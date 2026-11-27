use super::delivery::{
    classify_apns_send_error, classify_web_push_error, is_stale_apns_error_reason,
    DeliveryFailureAction,
};
use super::payload::{
    build_apns_notification, build_push_payload, format_push_body, format_reply_push_body,
    truncate_preview, PushPayloadType, APNS_BODY_LOC_KEY_AUDIO, APNS_BODY_LOC_KEY_INVITE,
    APNS_BODY_LOC_KEY_MENTION, APNS_BODY_LOC_KEY_NO_PREVIEW, APNS_BODY_LOC_KEY_REPLY,
    APNS_BODY_LOC_KEY_STICKER_EMOJI, APNS_BODY_LOC_KEY_WITH_PREVIEW, APNS_TITLE_LOC_KEY,
    MESSAGE_PREVIEW_MAX,
};
use super::*;
use crate::dto::messages::MessagePreviewAttachment;
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
            attachments: Vec::new(),
            is_deleted: false,
        },
        body_preview: Some("[Sticker] 🙂".to_string()),
        message_id: 99,
        thread_root_id: None,
        mentioned_uids: Vec::new(),
        reply_target_uid: None,
    };

    let payload = build_push_payload(&job, 3, "alice: [Sticker] 🙂", 42);
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
fn build_push_payload_marks_mention_for_mentioned_recipient() {
    let job = PushJob {
        chat_id: 10,
        sender_uid: 7,
        sender_username: "alice".to_string(),
        chat_name: "General".to_string(),
        message_preview: PushMessagePreview {
            message: Some("hi @[uid:42]".to_string()),
            message_type: MessageType::Text,
            sticker: None,
            attachments: Vec::new(),
            is_deleted: false,
        },
        body_preview: Some("hi @you".to_string()),
        message_id: 99,
        thread_root_id: None,
        mentioned_uids: vec![42],
        reply_target_uid: None,
    };

    // Mentioned recipient -> typed as Mention with context.
    let mentioned = build_push_payload(&job, 1, "alice: hi @you", 42);
    assert_eq!(mentioned.type_, PushPayloadType::Mention);
    assert_eq!(mentioned.mentioned_uid, Some(42));
    let serialized = serde_json::to_value(&mentioned).expect("serialize");
    assert_eq!(serialized["type"], "mention");
    assert_eq!(serialized["mentionedUid"], 42);

    // Non-mentioned recipient -> generic newMessage, no mention context.
    let other = build_push_payload(&job, 1, "alice: hi @you", 99);
    assert_eq!(other.type_, PushPayloadType::NewMessage);
    assert_eq!(other.mentioned_uid, None);
    let other_serialized = serde_json::to_value(&other).expect("serialize");
    assert!(other_serialized.get("mentionedUid").is_none());
}

#[test]
fn build_apns_notification_uses_mention_loc_key_for_mentioned_recipient() {
    let job = PushJob {
        chat_id: 10,
        sender_uid: 7,
        sender_username: "alice".to_string(),
        chat_name: "General".to_string(),
        message_preview: PushMessagePreview {
            message: Some("hello there".to_string()),
            message_type: MessageType::Text,
            sticker: None,
            attachments: Vec::new(),
            is_deleted: false,
        },
        body_preview: Some("hello there".to_string()),
        message_id: 99,
        thread_root_id: None,
        mentioned_uids: vec![42],
        reply_target_uid: None,
    };

    let n = build_apns_notification(&job, 1, 42);
    assert_eq!(n.body_loc_key, APNS_BODY_LOC_KEY_MENTION);
    assert_eq!(
        n.body_loc_args,
        vec!["alice".to_string(), "hello there".to_string()]
    );
    assert_eq!(n.custom_data.type_, PushPayloadType::Mention);
    assert_eq!(n.custom_data.mentioned_uid, Some(42));

    // Non-mentioned recipient falls back to the standard text-with-preview key.
    let other = build_apns_notification(&job, 1, 99);
    assert_eq!(other.body_loc_key, APNS_BODY_LOC_KEY_WITH_PREVIEW);
    assert_eq!(other.custom_data.type_, PushPayloadType::NewMessage);
    assert_eq!(other.custom_data.mentioned_uid, None);
}

#[test]
fn build_push_payload_types_reply_for_reply_target() {
    let job = PushJob {
        chat_id: 10,
        sender_uid: 7,
        sender_username: "alice".to_string(),
        chat_name: "General".to_string(),
        message_preview: PushMessagePreview {
            message: Some("a reply".to_string()),
            message_type: MessageType::Text,
            sticker: None,
            attachments: Vec::new(),
            is_deleted: false,
        },
        body_preview: Some("a reply".to_string()),
        message_id: 99,
        thread_root_id: Some(55),
        mentioned_uids: Vec::new(),
        reply_target_uid: Some(42),
    };

    let reply = build_push_payload(&job, 1, "alice replied to your message: a reply", 42);
    assert_eq!(reply.type_, PushPayloadType::Reply);
    assert_eq!(reply.mentioned_uid, None);
    let serialized = serde_json::to_value(&reply).expect("serialize");
    assert_eq!(serialized["type"], "reply");
    assert!(serialized.get("mentionedUid").is_none());

    // Unrelated recipient stays generic.
    let other = build_push_payload(&job, 1, "alice: a reply", 99);
    assert_eq!(other.type_, PushPayloadType::NewMessage);
}

#[test]
fn build_push_payload_mention_outranks_reply_for_same_recipient() {
    let job = PushJob {
        chat_id: 10,
        sender_uid: 7,
        sender_username: "alice".to_string(),
        chat_name: "General".to_string(),
        message_preview: PushMessagePreview {
            message: Some("hi @[uid:42]".to_string()),
            message_type: MessageType::Text,
            sticker: None,
            attachments: Vec::new(),
            is_deleted: false,
        },
        body_preview: Some("hi @you".to_string()),
        message_id: 99,
        thread_root_id: None,
        mentioned_uids: vec![42],
        reply_target_uid: Some(42),
    };

    let payload = build_push_payload(&job, 1, "alice: hi @you", 42);
    assert_eq!(payload.type_, PushPayloadType::Mention);
    assert_eq!(payload.mentioned_uid, Some(42));
}

#[test]
fn build_apns_notification_uses_reply_loc_key_for_reply_target() {
    let job = PushJob {
        chat_id: 10,
        sender_uid: 7,
        sender_username: "alice".to_string(),
        chat_name: "General".to_string(),
        message_preview: PushMessagePreview {
            message: Some("a reply".to_string()),
            message_type: MessageType::Text,
            sticker: None,
            attachments: Vec::new(),
            is_deleted: false,
        },
        body_preview: Some("a reply".to_string()),
        message_id: 99,
        thread_root_id: None,
        mentioned_uids: Vec::new(),
        reply_target_uid: Some(42),
    };

    let n = build_apns_notification(&job, 1, 42);
    assert_eq!(n.body_loc_key, APNS_BODY_LOC_KEY_REPLY);
    assert_eq!(
        n.body_loc_args,
        vec!["alice".to_string(), "a reply".to_string()]
    );
    assert_eq!(n.custom_data.type_, PushPayloadType::Reply);
    assert_eq!(n.custom_data.mentioned_uid, None);
}

#[test]
fn format_reply_push_body_uses_reply_copy() {
    assert_eq!(
        format_reply_push_body("alice", Some("a reply")),
        "alice replied to your message: a reply"
    );
    assert_eq!(
        format_reply_push_body("alice", None),
        "alice replied to your message"
    );
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
            attachments: Vec::new(),
            is_deleted: false,
        },
        body_preview: Some("hello there".to_string()),
        message_id: 99,
        thread_root_id: Some(77),
        mentioned_uids: Vec::new(),
        reply_target_uid: None,
    };

    let n = build_apns_notification(&job, 7, 42);
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
            attachments: Vec::new(),
            is_deleted: false,
        },
        body_preview: None,
        message_id: 99,
        thread_root_id: None,
        mentioned_uids: Vec::new(),
        reply_target_uid: None,
    };

    let payload = build_apns_notification(&job, 0, 42);
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
            attachments: Vec::new(),
            is_deleted: false,
        },
        body_preview: None,
        message_id: 50,
        thread_root_id: None,
        mentioned_uids: Vec::new(),
        reply_target_uid: None,
    };

    let n = build_apns_notification(&job, 2, 42);
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
            attachments: Vec::new(),
            is_deleted: false,
        },
        body_preview: Some("[Sticker] 🎉".to_string()),
        message_id: 51,
        thread_root_id: None,
        mentioned_uids: Vec::new(),
        reply_target_uid: None,
    };

    let n = build_apns_notification(&job, 0, 42);
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
            message_type: MessageType::Text,
            sticker: None,
            attachments: vec![MessagePreviewAttachment {
                kind: "image/jpeg".to_string(),
            }],
            is_deleted: false,
        },
        body_preview: None,
        message_id: 52,
        thread_root_id: None,
        mentioned_uids: Vec::new(),
        reply_target_uid: None,
    };

    let n = build_apns_notification(&job, 1, 42);
    assert_eq!(n.body_loc_key, "push.message.body.image");
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
            attachments: vec![MessagePreviewAttachment {
                kind: "image/jpeg".to_string(),
            }],
            is_deleted: false,
        },
        body_preview: Some("[Image]".to_string()),
        message_id: 54,
        thread_root_id: None,
        mentioned_uids: Vec::new(),
        reply_target_uid: None,
    };

    let n = build_apns_notification(&job, 0, 42);
    assert_eq!(n.body_loc_key, "push.message.body.attachment.with_preview");
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
            message_type: MessageType::Text,
            sticker: None,
            attachments: vec![MessagePreviewAttachment {
                kind: "video/mp4".to_string(),
            }],
            is_deleted: false,
        },
        body_preview: None,
        message_id: 53,
        thread_root_id: None,
        mentioned_uids: Vec::new(),
        reply_target_uid: None,
    };

    let n = build_apns_notification(&job, 0, 42);
    assert_eq!(n.body_loc_key, "push.message.body.video");
}

#[test]
fn build_apns_notification_file_attachment_uses_generic_key() {
    let job = PushJob {
        chat_id: 5,
        sender_uid: 1,
        sender_username: "bob".to_string(),
        chat_name: "DMs".to_string(),
        message_preview: PushMessagePreview {
            message: None,
            message_type: MessageType::File,
            sticker: None,
            attachments: vec![MessagePreviewAttachment {
                kind: "application/pdf".to_string(),
            }],
            is_deleted: false,
        },
        body_preview: None,
        message_id: 55,
        thread_root_id: None,
        mentioned_uids: Vec::new(),
        reply_target_uid: None,
    };

    let n = build_apns_notification(&job, 0, 42);
    assert_eq!(n.body_loc_key, "push.message.body.attachment");
    assert_eq!(n.body_loc_args, vec!["bob".to_string()]);
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
            attachments: Vec::new(),
            is_deleted: false,
        },
        body_preview: Some("sent an invite".to_string()),
        message_id: 54,
        thread_root_id: None,
        mentioned_uids: Vec::new(),
        reply_target_uid: None,
    };

    let n = build_apns_notification(&job, 0, 42);
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
        config: Arc::new(crate::config::PushConfig {
            vapid_public_key: "public".to_string(),
            vapid_private_key: "private".to_string(),
            vapid_subject: "mailto:test@example.com".to_string(),
            apns: None,
        }),
        apns_sender: None,
        metrics: Arc::new(PushMetrics::new(&prometheus::Registry::new())),
        unread_service: Arc::new(UnreadService::new()),
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
