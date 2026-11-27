mod api;
mod http;
mod pool;
pub mod queries;
mod rpc_admission;

pub use api::{ApiMetrics, ApiStages};
pub use rpc_admission::RpcAdmissionMetrics;

use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use prometheus::{Encoder, Registry, TextEncoder};
use std::sync::Arc;

use crate::handlers::chats::ChatMetrics;
use crate::services::audio_transcode::AudioTranscodeMetrics;
use crate::services::avatars::AvatarMetrics;
use crate::services::background::BackgroundMetrics;
use crate::services::client_tracking::ClientTrackingMetrics;
use crate::services::message_search::MessageSearchMetrics;
use crate::services::presence::PresenceMetrics;
use crate::services::push::PushMetrics;
use crate::services::ws_registry::WsMetrics;

pub use http::track_http_metrics;

#[derive(Clone)]
pub struct Metrics {
    registry: Registry,
    pub api: Arc<ApiMetrics>,
    pub rpc_admission: Arc<RpcAdmissionMetrics>,
    pub chat: Arc<ChatMetrics>,
    pub ws: Arc<WsMetrics>,
    pub presence: Arc<PresenceMetrics>,
    pub push: Arc<PushMetrics>,
    pub avatars: Arc<AvatarMetrics>,
    pub client_tracking: Arc<ClientTrackingMetrics>,
    pub message_search: Arc<MessageSearchMetrics>,
    pub background: Arc<BackgroundMetrics>,
    pub audio_transcode: Arc<AudioTranscodeMetrics>,
    pub queries: Arc<queries::QueryMetrics>,
}

impl Metrics {
    pub fn new() -> Self {
        let registry = Registry::new();
        #[cfg(target_os = "linux")]
        registry
            .register(Box::new(
                prometheus::process_collector::ProcessCollector::for_self(),
            ))
            .expect("process collector registration should succeed");
        Self {
            api: Arc::new(ApiMetrics::new(&registry)),
            rpc_admission: Arc::new(RpcAdmissionMetrics::new(&registry)),
            chat: Arc::new(ChatMetrics::new(&registry)),
            ws: Arc::new(WsMetrics::new(&registry)),
            presence: Arc::new(PresenceMetrics::new(&registry)),
            push: Arc::new(PushMetrics::new(&registry)),
            avatars: Arc::new(AvatarMetrics::new(&registry)),
            client_tracking: Arc::new(ClientTrackingMetrics::new(&registry)),
            message_search: Arc::new(MessageSearchMetrics::new(&registry)),
            background: Arc::new(BackgroundMetrics::new(&registry)),
            audio_transcode: Arc::new(AudioTranscodeMetrics::new(&registry)),
            queries: Arc::new(queries::QueryMetrics::new(&registry)),
            registry,
        }
    }

    pub fn pool_events(&self) -> pool::PoolEvents {
        pool::PoolEvents::new(&self.registry)
    }

    pub fn register_pool_state(&self, pool: crate::state::DbPool) {
        pool::register_pool_state(&self.registry, pool);
    }

    pub fn render(&self) -> Result<String, prometheus::Error> {
        encode(&self.registry)
    }
}

pub fn encode(registry: &Registry) -> Result<String, prometheus::Error> {
    let metric_families = registry.gather();
    let mut output = Vec::new();
    TextEncoder::new().encode(&metric_families, &mut output)?;
    String::from_utf8(output).map_err(|err| prometheus::Error::Msg(err.utf8_error().to_string()))
}

pub async fn metrics_handler(
    State(metrics): State<Arc<Metrics>>,
) -> Result<impl IntoResponse, StatusCode> {
    let body = metrics
        .render()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let encoder = TextEncoder::new();
    let mut response = body.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(encoder.format_type()).expect("prometheus content type is valid"),
    );
    Ok(response)
}

#[cfg(test)]
mod tests;
