use diesel::r2d2::{ConnectionManager, Pool};
use diesel::PgConnection;
use futures::future::FutureExt;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{error, warn};
use web_push::HyperWebPushClient;

mod delivery;
mod metrics;
mod payload;
mod policy;
mod worker;

pub use metrics::PushMetrics;
pub use payload::{PushMessagePreview, PushMessagePreviewSticker};

use crate::models::PushProvider;
use crate::services::unread::UnreadService;
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
    pub reply_target_uid: Option<i32>,
}

pub struct PushService {
    pub client: HyperWebPushClient,
    pub config: Arc<crate::config::PushConfig>,
    apns_sender: Option<ApnsSender>,
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
        // Validate the private key parses correctly.
        let _ = web_push::VapidSignatureBuilder::from_base64_no_sub(&config.vapid_private_key)
            .expect("Failed to create VapidSignatureBuilder from VAPID_PRIVATE_KEY");

        let apns_sender = config
            .apns
            .as_ref()
            .map(ApnsSender::from_config)
            .transpose()
            .expect("invalid APNS configuration");

        let (tx, rx) = mpsc::channel(CHANNEL_BUFFER);

        let service = Arc::new(Self {
            client: HyperWebPushClient::new(),
            config,
            apns_sender,
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
mod tests;
