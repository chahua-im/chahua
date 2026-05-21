use diesel::r2d2::{ConnectionManager, Pool};
use diesel::PgConnection;
use futures::future::FutureExt;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{error, warn};
use web_push::HyperWebPushClient;

mod delivery;
mod payload;
mod policy;
mod worker;

pub use payload::{PushMessagePreview, PushMessagePreviewSticker};

use crate::metrics::Metrics;
use crate::models::PushProvider;
use crate::services::ws_registry::ConnectionRegistry;
use delivery::ApnsSender;
use worker::supervise_push_worker;

const CHANNEL_BUFFER: usize = 1024;

pub struct PushJob {
    pub chat_id: i64,
    pub sender_uid: i32,
    pub sender_username: String,
    pub chat_name: String,
    pub message_preview: PushMessagePreview,
    pub body_preview: Option<String>,
    pub message_id: i64,
    pub thread_root_id: Option<i64>,
    pub mentioned_uids: Vec<i32>,
}

pub struct PushService {
    pub client: HyperWebPushClient,
    pub vapid_public_key: String,
    pub vapid_private_key: String,
    pub vapid_subject: String,
    apns_sender: Option<ApnsSender>,
    metrics: Arc<Metrics>,
    job_tx: mpsc::Sender<PushJob>,
}

impl PushService {
    /// Create the push service and spawn the background worker.
    ///
    /// The worker pulls `PushJob`s from the channel and delivers push notifications
    /// to all subscribed, offline members of the relevant chat.
    pub fn start(
        db: Pool<ConnectionManager<PgConnection>>,
        ws_registry: Arc<ConnectionRegistry>,
        metrics: Arc<Metrics>,
    ) -> Arc<Self> {
        let public_key = std::env::var("VAPID_PUBLIC_KEY")
            .expect("VAPID_PUBLIC_KEY environment variable must be set");
        let private_key = std::env::var("VAPID_PRIVATE_KEY")
            .expect("VAPID_PRIVATE_KEY environment variable must be set");
        let subject =
            std::env::var("VAPID_SUBJECT").expect("VAPID_SUBJECT environment variable must be set");

        // Validate the private key parses correctly.
        let _ = web_push::VapidSignatureBuilder::from_base64_no_sub(&private_key)
            .expect("Failed to create VapidSignatureBuilder from VAPID_PRIVATE_KEY");

        let apns_sender =
            ApnsSender::from_env().expect("invalid APNS configuration; set all vars or none");

        let (tx, rx) = mpsc::channel(CHANNEL_BUFFER);

        let service = Arc::new(Self {
            client: HyperWebPushClient::new(),
            vapid_public_key: public_key,
            vapid_private_key: private_key,
            vapid_subject: subject,
            apns_sender,
            metrics,
            job_tx: tx,
        });

        // Spawn the background worker supervisor.
        let worker_service = service.clone();
        tokio::spawn(async move {
            supervise_push_worker(rx, worker_service, db, ws_registry).await;
        });

        service
    }

    pub fn supports_provider(&self, provider: &PushProvider) -> bool {
        match provider {
            PushProvider::WebPush => true,
            PushProvider::Apns => self.apns_sender.is_some(),
        }
    }

    /// Enqueue a push job. Non-blocking; logs a warning if the channel is full.
    pub fn enqueue(&self, job: PushJob) {
        if let Err(e) = self.job_tx.try_send(job) {
            warn!("Push job channel full, dropping notification: {}", e);
        }
    }
}

pub(crate) fn panic_payload_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&'static str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "non-string panic payload".to_string()
    }
}

pub(crate) async fn supervise_worker<F, Fut>(
    worker_name: &str,
    restart_delay: Duration,
    mut worker: F,
) where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    loop {
        let worker_result = std::panic::AssertUnwindSafe(worker()).catch_unwind().await;

        match worker_result {
            Ok(()) => return,
            Err(payload) => {
                let panic_message = panic_payload_message(payload.as_ref());
                error!(
                    "{} panicked; restarting in {}s: {}",
                    worker_name,
                    restart_delay.as_secs_f32(),
                    panic_message
                );
                tokio::time::sleep(restart_delay).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::delivery::{
        classify_apns_send_error, classify_web_push_error, is_stale_apns_error_reason,
        DeliveryFailureAction,
    };
    use super::payload::{
        build_apns_notification, build_push_payload, format_push_body, truncate_preview,
        APNS_BODY_LOC_KEY_AUDIO, APNS_BODY_LOC_KEY_IMAGE, APNS_BODY_LOC_KEY_IMAGE_WITH_PREVIEW,
        APNS_BODY_LOC_KEY_INVITE, APNS_BODY_LOC_KEY_NO_PREVIEW, APNS_BODY_LOC_KEY_STICKER_EMOJI,
        APNS_BODY_LOC_KEY_VIDEO, APNS_BODY_LOC_KEY_WITH_PREVIEW, APNS_TITLE_LOC_KEY,
        MESSAGE_PREVIEW_MAX,
    };
    use super::*;
    use crate::models::MessageType;
    use a2::ErrorReason as ApnsErrorReason;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn truncate_preview_keeps_short_ascii() {
        assert_eq!(truncate_preview("hello"), "hello");
    }

    #[test]
    fn truncate_preview_adds_ellipsis_for_long_ascii() {
        let input = "a".repeat(MESSAGE_PREVIEW_MAX + 5);
        let expected = format!("{}…", "a".repeat(MESSAGE_PREVIEW_MAX));
        assert_eq!(truncate_preview(&input), expected);
    }

    #[test]
    fn truncate_preview_handles_multibyte_unicode_without_panicking() {
        let input = "不用注册tg之后感觉加群的奇怪的人会更多，感觉要考虑下禁止事项和惩罚措施了（）";
        assert_eq!(truncate_preview(input), input);
    }

    #[test]
    fn truncate_preview_exact_limit_has_no_ellipsis() {
        let input = "a".repeat(MESSAGE_PREVIEW_MAX);
        assert_eq!(truncate_preview(&input), input);
    }

    #[test]
    fn format_push_body_uses_fallback_for_missing_preview() {
        assert_eq!(format_push_body("alice", None), "alice sent a message");
    }

    #[test]
    fn build_push_payload_includes_structured_preview_and_legacy_body() {
        let job = PushJob {
            chat_id: 10,
            sender_uid: 42,
            sender_username: "alice".to_string(),
            chat_name: "General".to_string(),
            message_preview: PushMessagePreview {
                message: None,
                message_type: MessageType::Sticker,
                sticker: Some(PushMessagePreviewSticker {
                    emoji: "🙂".to_string(),
                }),
                first_attachment_kind: None,
                is_deleted: false,
            },
            body_preview: Some("[Sticker] 🙂".to_string()),
            message_id: 99,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
        };

        let payload = build_push_payload(&job, 3, "alice: [Sticker] 🙂");
        assert_eq!(payload.sender_name, "alice");
        assert_eq!(payload.body, "alice: [Sticker] 🙂");
        assert_eq!(payload.message_preview.message_type, MessageType::Sticker);
        assert_eq!(
            payload.message_preview.sticker,
            Some(PushMessagePreviewSticker {
                emoji: "🙂".to_string(),
            })
        );
        assert_eq!(payload.data.chat_id, "10");
        assert_eq!(payload.data.message_id, "99");
        assert_eq!(payload.unread_count, 3);

        let serialized = serde_json::to_value(&payload).expect("serialize push payload");
        assert_eq!(serialized["type"], "newMessage");
        assert_eq!(serialized["senderName"], "alice");
        assert_eq!(serialized["messagePreview"]["messageType"], "sticker");
        assert_eq!(serialized["data"]["chatId"], "10");
        assert_eq!(serialized["data"]["messageId"], "99");
        assert!(serialized.get("sender_name").is_none());
        assert!(serialized["data"].get("chat_id").is_none());
    }

    #[test]
    fn build_apns_notification_uses_localized_keys_and_custom_data() {
        let job = PushJob {
            chat_id: 10,
            sender_uid: 42,
            sender_username: "alice".to_string(),
            chat_name: "General".to_string(),
            message_preview: PushMessagePreview {
                message: Some("Hello".to_string()),
                message_type: MessageType::Text,
                sticker: None,
                first_attachment_kind: None,
                is_deleted: false,
            },
            body_preview: Some("hello there".to_string()),
            message_id: 99,
            thread_root_id: Some(77),
            mentioned_uids: Vec::new(),
        };

        let n = build_apns_notification(&job, 7);
        assert_eq!(n.title_loc_key, APNS_TITLE_LOC_KEY);
        assert_eq!(n.title_loc_args, vec!["General".to_string()]);
        assert_eq!(n.body_loc_key, APNS_BODY_LOC_KEY_WITH_PREVIEW);
        assert_eq!(
            n.body_loc_args,
            vec!["alice".to_string(), "Hello".to_string()]
        );
        assert_eq!(n.badge, 7);
        assert_eq!(n.thread_id, "chat_10_thread_77");
        assert_eq!(n.custom_data.chat_id, "10");
        assert_eq!(n.custom_data.thread_root_id, Some("77".to_string()));
        assert_eq!(n.custom_data.unread_count, 7);
    }

    #[test]
    fn build_apns_notification_falls_back_when_preview_missing() {
        let job = PushJob {
            chat_id: 10,
            sender_uid: 42,
            sender_username: "alice".to_string(),
            chat_name: "General".to_string(),
            message_preview: PushMessagePreview {
                message: None,
                message_type: MessageType::Text,
                sticker: None,
                first_attachment_kind: None,
                is_deleted: false,
            },
            body_preview: None,
            message_id: 99,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
        };

        let payload = build_apns_notification(&job, 0);
        assert_eq!(payload.body_loc_key, APNS_BODY_LOC_KEY_NO_PREVIEW);
        assert_eq!(payload.body_loc_args, vec!["alice".to_string()]);
        assert_eq!(payload.badge, 0);
        assert_eq!(payload.thread_id, "chat_10");
    }

    #[test]
    fn build_apns_notification_audio_message() {
        let job = PushJob {
            chat_id: 5,
            sender_uid: 1,
            sender_username: "bob".to_string(),
            chat_name: "DMs".to_string(),
            message_preview: PushMessagePreview {
                message: None,
                message_type: MessageType::Audio,
                sticker: None,
                first_attachment_kind: None,
                is_deleted: false,
            },
            body_preview: None,
            message_id: 50,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
        };

        let n = build_apns_notification(&job, 2);
        assert_eq!(n.body_loc_key, APNS_BODY_LOC_KEY_AUDIO);
        assert_eq!(n.body_loc_args, vec!["bob".to_string()]);
    }

    #[test]
    fn build_apns_notification_sticker_with_emoji() {
        let job = PushJob {
            chat_id: 5,
            sender_uid: 1,
            sender_username: "bob".to_string(),
            chat_name: "DMs".to_string(),
            message_preview: PushMessagePreview {
                message: None,
                message_type: MessageType::Sticker,
                sticker: Some(PushMessagePreviewSticker {
                    emoji: "🎉".to_string(),
                }),
                first_attachment_kind: None,
                is_deleted: false,
            },
            body_preview: Some("[Sticker] 🎉".to_string()),
            message_id: 51,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
        };

        let n = build_apns_notification(&job, 0);
        assert_eq!(n.body_loc_key, APNS_BODY_LOC_KEY_STICKER_EMOJI);
        assert_eq!(n.body_loc_args, vec!["bob".to_string(), "🎉".to_string()]);
    }

    #[test]
    fn build_apns_notification_image_attachment() {
        let job = PushJob {
            chat_id: 5,
            sender_uid: 1,
            sender_username: "bob".to_string(),
            chat_name: "DMs".to_string(),
            message_preview: PushMessagePreview {
                message: None,
                message_type: MessageType::File,
                sticker: None,
                first_attachment_kind: Some("image/jpeg".to_string()),
                is_deleted: false,
            },
            body_preview: None,
            message_id: 52,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
        };

        let n = build_apns_notification(&job, 1);
        assert_eq!(n.body_loc_key, APNS_BODY_LOC_KEY_IMAGE);
        assert_eq!(n.body_loc_args, vec!["bob".to_string()]);
    }

    #[test]
    fn build_apns_notification_prefers_attachment_key_over_caption_preview() {
        let job = PushJob {
            chat_id: 5,
            sender_uid: 1,
            sender_username: "bob".to_string(),
            chat_name: "DMs".to_string(),
            message_preview: PushMessagePreview {
                message: Some("look at this".to_string()),
                message_type: MessageType::File,
                sticker: None,
                first_attachment_kind: Some("image/jpeg".to_string()),
                is_deleted: false,
            },
            body_preview: Some("[Image]".to_string()),
            message_id: 54,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
        };

        let n = build_apns_notification(&job, 0);
        assert_eq!(n.body_loc_key, APNS_BODY_LOC_KEY_IMAGE_WITH_PREVIEW);
        assert_eq!(
            n.body_loc_args,
            vec!["bob".to_string(), "look at this".to_string()]
        );
    }

    #[test]
    fn build_apns_notification_video_attachment() {
        let job = PushJob {
            chat_id: 5,
            sender_uid: 1,
            sender_username: "bob".to_string(),
            chat_name: "DMs".to_string(),
            message_preview: PushMessagePreview {
                message: None,
                message_type: MessageType::File,
                sticker: None,
                first_attachment_kind: Some("video/mp4".to_string()),
                is_deleted: false,
            },
            body_preview: None,
            message_id: 53,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
        };

        let n = build_apns_notification(&job, 0);
        assert_eq!(n.body_loc_key, APNS_BODY_LOC_KEY_VIDEO);
    }

    #[test]
    fn build_apns_notification_invite() {
        let job = PushJob {
            chat_id: 5,
            sender_uid: 1,
            sender_username: "bob".to_string(),
            chat_name: "DMs".to_string(),
            message_preview: PushMessagePreview {
                message: None,
                message_type: MessageType::Invite,
                sticker: None,
                first_attachment_kind: None,
                is_deleted: false,
            },
            body_preview: Some("sent an invite".to_string()),
            message_id: 54,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
        };

        let n = build_apns_notification(&job, 0);
        assert_eq!(n.body_loc_key, APNS_BODY_LOC_KEY_INVITE);
        assert_eq!(n.body_loc_args, vec!["bob".to_string()]);
    }

    #[test]
    fn stale_apns_error_reason_classification_matches_expected_errors() {
        assert!(is_stale_apns_error_reason(&ApnsErrorReason::BadDeviceToken));
        assert!(is_stale_apns_error_reason(
            &ApnsErrorReason::DeviceTokenNotForTopic
        ));
        assert!(is_stale_apns_error_reason(&ApnsErrorReason::Unregistered));
        assert!(!is_stale_apns_error_reason(
            &ApnsErrorReason::TooManyRequests
        ));
        assert!(!is_stale_apns_error_reason(
            &ApnsErrorReason::InternalServerError
        ));
    }

    #[test]
    fn apns_response_error_with_bad_device_token_prunes_subscription() {
        let error = a2::Error::ResponseError(a2::Response {
            apns_id: Some("test-apns-id".to_string()),
            error: Some(a2::ErrorBody {
                reason: ApnsErrorReason::BadDeviceToken,
                timestamp: None,
            }),
            code: 400,
        });

        let failure = classify_apns_send_error(&error);

        assert_eq!(failure.action, DeliveryFailureAction::PruneImmediate);
        assert_eq!(failure.reason, "BadDeviceToken");
    }

    #[test]
    fn apns_response_error_with_unregistered_prunes_subscription() {
        let error = a2::Error::ResponseError(a2::Response {
            apns_id: Some("test-apns-id".to_string()),
            error: Some(a2::ErrorBody {
                reason: ApnsErrorReason::Unregistered,
                timestamp: None,
            }),
            code: 410,
        });

        let failure = classify_apns_send_error(&error);

        assert_eq!(failure.action, DeliveryFailureAction::PruneImmediate);
        assert_eq!(failure.reason, "Unregistered");
    }

    #[test]
    fn apns_response_error_with_too_many_requests_is_retryable() {
        let error = a2::Error::ResponseError(a2::Response {
            apns_id: Some("test-apns-id".to_string()),
            error: Some(a2::ErrorBody {
                reason: ApnsErrorReason::TooManyRequests,
                timestamp: None,
            }),
            code: 429,
        });

        let failure = classify_apns_send_error(&error);

        assert_eq!(failure.action, DeliveryFailureAction::None);
        assert_eq!(failure.reason, "TooManyRequests");
    }

    #[test]
    fn apns_timeout_is_retryable() {
        let error = a2::Error::RequestTimeout(30);

        let failure = classify_apns_send_error(&error);

        assert_eq!(failure.action, DeliveryFailureAction::None);
        assert_eq!(failure.reason, "request_timeout");
    }

    #[test]
    fn web_push_endpoint_not_found_prunes_immediately() {
        let error = web_push::request_builder::parse_response(
            http02::StatusCode::NOT_FOUND,
            b"not found".to_vec(),
        )
        .expect_err("404 should classify as endpoint not found");

        let failure = classify_web_push_error(&error);

        assert_eq!(failure.action, DeliveryFailureAction::PruneImmediate);
        assert_eq!(failure.reason, "endpoint_not_found");
    }

    #[test]
    fn web_push_endpoint_not_valid_prunes_immediately() {
        let error =
            web_push::request_builder::parse_response(http02::StatusCode::GONE, b"gone".to_vec())
                .expect_err("410 should classify as endpoint not valid");

        let failure = classify_web_push_error(&error);

        assert_eq!(failure.action, DeliveryFailureAction::PruneImmediate);
        assert_eq!(failure.reason, "endpoint_not_valid");
    }

    #[test]
    fn web_push_unspecified_counts_toward_pruning() {
        let failure = classify_web_push_error(&web_push::WebPushError::Unspecified);

        assert_eq!(failure.action, DeliveryFailureAction::Counted);
        assert_eq!(failure.reason, "unspecified");
    }

    #[test]
    fn web_push_server_error_is_retryable_without_pruning() {
        let error = web_push::request_builder::parse_response(
            http02::StatusCode::SERVICE_UNAVAILABLE,
            b"temporarily unavailable".to_vec(),
        )
        .expect_err("503 should classify as server error");

        let failure = classify_web_push_error(&error);

        assert_eq!(failure.action, DeliveryFailureAction::None);
        assert_eq!(failure.reason, "server_error");
    }

    #[test]
    fn apns_support_requires_sender_configuration() {
        let service = PushService {
            client: HyperWebPushClient::new(),
            vapid_public_key: "public".to_string(),
            vapid_private_key: "private".to_string(),
            vapid_subject: "mailto:test@example.com".to_string(),
            apns_sender: None,
            metrics: Arc::new(Metrics::new()),
            job_tx: mpsc::channel(1).0,
        };

        assert!(service.supports_provider(&PushProvider::WebPush));
        assert!(!service.supports_provider(&PushProvider::Apns));
    }

    #[tokio::test]
    async fn supervisor_restarts_after_panic() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let worker_attempts = attempts.clone();
        let (done_tx, mut done_rx) = mpsc::channel::<usize>(1);

        tokio::spawn(async move {
            supervise_worker("test worker", Duration::from_millis(1), move || {
                let worker_attempts = worker_attempts.clone();
                let done_tx = done_tx.clone();
                async move {
                    let attempt = worker_attempts.fetch_add(1, Ordering::SeqCst) + 1;
                    if attempt == 1 {
                        panic!("boom");
                    }
                    done_tx.send(attempt).await.unwrap();
                }
            })
            .await;
        });

        let attempt = tokio::time::timeout(Duration::from_secs(1), done_rx.recv())
            .await
            .expect("supervisor should finish the restarted attempt")
            .expect("channel should receive attempt number");
        assert_eq!(attempt, 2);
    }
}
