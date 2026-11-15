use diesel::r2d2::{ConnectionManager, Pool};
use diesel::PgConnection;
use futures::future::FutureExt;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{error, warn};

mod delivery;
mod metrics;
mod payload;
mod policy;
mod providers;
pub(crate) mod subscriptions;
mod worker;

pub use metrics::PushMetrics;
pub use payload::{PushMessagePreview, PushMessagePreviewSticker};

use crate::models::PushProvider;
use crate::services::unread::UnreadService;
use crate::services::ws_registry::ConnectionRegistry;
use providers::{apns::ApnsSender, fcm::FcmSender, web_push::WebPushSender};
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
    pub reply_target_uid: Option<i32>,
}

pub struct PushService {
    web_push_sender: Option<WebPushSender>,
    apns_sender: Option<ApnsSender>,
    fcm_sender: Option<FcmSender>,
    metrics: Arc<PushMetrics>,
    unread_service: Arc<UnreadService>,
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
        metrics: Arc<PushMetrics>,
        unread_service: Arc<UnreadService>,
        config: Arc<crate::config::PushConfig>,
    ) -> Arc<Self> {
        let web_push_sender = config
            .web_push
            .as_ref()
            .map(WebPushSender::from_config)
            .transpose()
            .expect("Failed to create VapidSignatureBuilder from VAPID_PRIVATE_KEY");

        let apns_sender = config
            .apns
            .as_ref()
            .map(ApnsSender::from_config)
            .transpose()
            .expect("invalid APNS configuration");

        let fcm_sender = config
            .fcm
            .as_ref()
            .map(FcmSender::from_config)
            .transpose()
            .expect("invalid FCM configuration");

        let (tx, rx) = mpsc::channel(CHANNEL_BUFFER);

        let service = Arc::new(Self {
            web_push_sender,
            apns_sender,
            fcm_sender,
            metrics,
            unread_service,
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
            PushProvider::WebPush => self.web_push_sender.is_some(),
            PushProvider::Apns => self.apns_sender.is_some(),
            PushProvider::Fcm => self.fcm_sender.is_some(),
        }
    }

    pub fn vapid_public_key(&self) -> Option<&str> {
        self.web_push_sender
            .as_ref()
            .map(WebPushSender::vapid_public_key)
    }

    /// Enqueue a push job. Non-blocking; logs a warning if the channel is full.
    pub fn enqueue(&self, job: PushJob) {
        if let Err(e) = self.job_tx.try_send(job) {
            warn!("Push job channel full, dropping notification: {}", e);
        }
    }
}

pub fn panic_payload_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&'static str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "non-string panic payload".to_string()
    }
}

pub async fn supervise_worker<F, Fut>(worker_name: &str, restart_delay: Duration, mut worker: F)
where
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
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn service_without_native_senders(registry: &prometheus::Registry) -> PushService {
        PushService {
            web_push_sender: Some(
                WebPushSender::from_config(&crate::config::WebPushConfig {
                    vapid_public_key: "public".to_string(),
                    vapid_private_key: "IQ9Ur0ykXoHS9gzfYX0aBjy9lvdrjx_PFUXmie9YRcY".to_string(),
                    vapid_subject: "mailto:test@example.com".to_string(),
                })
                .unwrap(),
            ),
            apns_sender: None,
            fcm_sender: None,
            metrics: Arc::new(PushMetrics::new(registry)),
            unread_service: Arc::new(UnreadService::new()),
            job_tx: mpsc::channel(1).0,
        }
    }

    #[test]
    fn apns_support_requires_sender_configuration() {
        let service = service_without_native_senders(&prometheus::Registry::new());
        assert!(service.supports_provider(&PushProvider::WebPush));
        assert!(!service.supports_provider(&PushProvider::Apns));
        assert!(!service.supports_provider(&PushProvider::Fcm));
    }

    #[test]
    fn web_push_key_and_disabled_provider_support() {
        use crate::errors::AppError;
        use crate::services::api::push::get_vapid_public_key;
        let mut service = service_without_native_senders(&prometheus::Registry::new());
        assert_eq!(service.vapid_public_key(), Some("public"));
        assert_eq!(get_vapid_public_key(&service).unwrap().public_key, "public");
        service.web_push_sender = None;
        assert!(!service.supports_provider(&PushProvider::WebPush));
        assert_eq!(service.vapid_public_key(), None);
        assert!(matches!(
            get_vapid_public_key(&service),
            Err(AppError::ServiceUnavailable("web push is not configured"))
        ));
    }

    #[tokio::test]
    async fn native_sender_support_uses_configured_senders() {
        let dir = std::env::temp_dir().join(format!("push-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let apns_key = dir.join("apns.p8");
        let fcm_key = dir.join("fcm.json");
        std::fs::write(&apns_key, "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgivJKWwZouOz4P/b5\nM0YhMe+OI3xHvkXNMV+xEqHS4kmhRANCAASIPzDH0RwyrwnpsgnBHeXweBp77QPJ\nUYD9rnPc2s+nrhvIyOYP2WMzQzd9myz+EjoVVazvUEGJGSEWZ22xwzNc\n-----END PRIVATE KEY-----\n").unwrap();
        std::fs::write(
            &fcm_key,
            r#"{"client_email":"test@example.com","private_key":"local-test-key"}"#,
        )
        .unwrap();
        let mut service = service_without_native_senders(&prometheus::Registry::new());
        service.web_push_sender = None;
        service.apns_sender = Some(
            ApnsSender::from_config(&crate::config::ApnsConfig {
                key_id: "key".into(),
                team_id: "team".into(),
                private_key_path: apns_key.to_str().unwrap().into(),
                topic: "test".into(),
            })
            .unwrap(),
        );
        service.fcm_sender = Some(
            FcmSender::from_config(&crate::config::FcmConfig {
                project_id: "test".into(),
                service_account_path: fcm_key.to_str().unwrap().into(),
            })
            .unwrap(),
        );
        assert!(!service.supports_provider(&PushProvider::WebPush));
        assert!(service.supports_provider(&PushProvider::Apns));
        assert!(service.supports_provider(&PushProvider::Fcm));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn disabled_provider_subscribe_returns_before_database_write() {
        use crate::errors::AppError;
        use crate::services::api::push::post_subscribe;
        use diesel::{connection::SimpleConnection, Connection};
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.batch_execute("BEGIN READ ONLY").unwrap();
        let mut service = service_without_native_senders(&prometheus::Registry::new());
        service.web_push_sender = None;
        let id_gen = crate::utils::ids::new_generator(0);
        for body in [
            r#"{"endpoint":"https://example.com/push","keys":{"p256dh":"abc","auth":"def"}}"#,
            r#"{"provider":"apns","deviceToken":"token","environment":"sandbox"}"#,
            r#"{"provider":"fcm","deviceToken":"token"}"#,
        ] {
            let result = post_subscribe(
                1,
                "client".into(),
                serde_json::from_str(body).unwrap(),
                &mut conn,
                &service,
                &id_gen,
            )
            .await;
            assert!(matches!(
                result,
                Err(AppError::BadRequest(
                    "the requested push provider is not configured"
                ))
            ));
        }
        conn.batch_execute("ROLLBACK").unwrap();
    }

    #[tokio::test]
    async fn missing_sender_records_one_failed_attempt_without_pruning() {
        use super::delivery::{DeliveryFailureAction, DeliveryFailureClass};
        use super::payload::RecipientNotification;
        use crate::models::{MessageType, PushSubscription};

        let registry = prometheus::Registry::new();
        let mut service = service_without_native_senders(&registry);
        service.web_push_sender = None;
        let job = PushJob {
            chat_id: 1,
            sender_uid: 1,
            sender_username: "alice".into(),
            chat_name: "chat".into(),
            message_preview: PushMessagePreview {
                message: None,
                message_type: MessageType::Text,
                sticker: None,
                attachments: vec![],
                is_deleted: false,
            },
            body_preview: None,
            message_id: 2,
            thread_root_id: None,
            mentioned_uids: vec![],
            reply_target_uid: None,
        };
        let input = RecipientNotification {
            job: &job,
            recipient_uid: 42,
            unread_count: 0,
            is_dm: false,
        };
        let mut sub = PushSubscription {
            id: 9,
            user_id: 42,
            provider: PushProvider::WebPush,
            endpoint: None,
            device_token: None,
            apns_environment: None,
            provider_data: serde_json::Value::Null,
            created_at: chrono::Utc::now().naive_utc(),
            client_id: None,
            delivery_failure_count: 0,
            last_delivery_error: None,
            last_delivery_error_at: None,
        };
        let failure = service
            .send_to_subscription(&sub, &input)
            .await
            .unwrap_err();
        assert_eq!(failure.class, DeliveryFailureClass::BackendConfig);
        assert_eq!(failure.action, DeliveryFailureAction::None);
        assert_eq!(failure.reason, "web_push_not_configured");
        let family = registry
            .gather()
            .into_iter()
            .find(|m| m.get_name() == "push_notifications_total")
            .unwrap();
        let metrics = family.get_metric();
        assert_eq!(metrics.len(), 1);
        assert_eq!(metrics[0].get_counter().get_value(), 1.0);
        assert!(metrics[0]
            .get_label()
            .iter()
            .any(|label| label.get_name() == "provider" && label.get_value() == "web_push"));
        assert!(metrics[0]
            .get_label()
            .iter()
            .any(|label| label.get_name() == "result" && label.get_value() == "failure"));
        sub.provider = PushProvider::Apns;
        let failure = service
            .send_to_subscription(&sub, &input)
            .await
            .unwrap_err();
        assert_eq!(failure.class, DeliveryFailureClass::BackendConfig);
        assert_eq!(failure.action, DeliveryFailureAction::None);
        assert_eq!(failure.reason, "apns_not_configured");
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
