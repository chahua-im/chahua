mod http;

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
use crate::services::push::PushMetrics;
use crate::services::ws_registry::WsMetrics;

pub use http::track_http_metrics;
use http::HttpMetrics;

#[derive(Clone)]
pub struct Metrics {
    registry: Registry,
    pub http: Arc<HttpMetrics>,
    pub chat: Arc<ChatMetrics>,
    pub ws: Arc<WsMetrics>,
    pub push: Arc<PushMetrics>,
    pub avatars: Arc<AvatarMetrics>,
    pub client_tracking: Arc<ClientTrackingMetrics>,
    pub message_search: Arc<MessageSearchMetrics>,
    pub background: Arc<BackgroundMetrics>,
    pub audio_transcode: Arc<AudioTranscodeMetrics>,
}

impl Metrics {
    pub fn new() -> Self {
        let registry = Registry::new();
        Self {
            http: Arc::new(HttpMetrics::new(&registry)),
            chat: Arc::new(ChatMetrics::new(&registry)),
            ws: Arc::new(WsMetrics::new(&registry)),
            push: Arc::new(PushMetrics::new(&registry)),
            avatars: Arc::new(AvatarMetrics::new(&registry)),
            client_tracking: Arc::new(ClientTrackingMetrics::new(&registry)),
            message_search: Arc::new(MessageSearchMetrics::new(&registry)),
            background: Arc::new(BackgroundMetrics::new(&registry)),
            audio_transcode: Arc::new(AudioTranscodeMetrics::new(&registry)),
            registry,
        }
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
mod tests {
    use super::*;
    use crate::services::client_tracking::ActivityTodaySnapshot;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    #[tokio::test]
    async fn metrics_endpoint_renders_registered_collectors() {
        let metrics = Arc::new(Metrics::new());
        metrics.http.record("GET", "/seed", StatusCode::OK, 0.001);
        metrics
            .http
            .record_multipart("POST", "/upload", StatusCode::CREATED, 0.05);
        metrics.chat.record_message(42);
        metrics.push.record_notification("web_push", true);
        metrics.push.record_job("success", 0.002);
        metrics.push.record_suppressed();
        metrics.push.record_delivery_failure("web_push", "expired");
        metrics
            .push
            .record_subscription_prune("web_push", "expired");
        metrics.ws.set_connected_users(2);
        metrics.ws.set_connection_states(1, 1);
        metrics.ws.record_connection_open();
        metrics.ws.record_connection_duration(12.0);
        metrics.avatars.record_lookup(2, 0.003, 0.001);
        metrics.ws.record_message_pushed("message");
        metrics.ws.record_message_dropped("message");
        metrics.client_tracking.record_activity_write("success");
        metrics
            .client_tracking
            .record_activity_write_skipped("throttled");
        metrics.client_tracking.record_rebind();
        metrics.client_tracking.record_purge("stale_clients", 2);
        metrics
            .client_tracking
            .record_daily_rollup_update("success");
        metrics
            .audio_transcode
            .record_source("audio/ogg;codecs=opus");
        metrics.audio_transcode.record_job("success", 0.75);
        metrics
            .client_tracking
            .set_activity_today(ActivityTodaySnapshot {
                active_users: 3,
                new_users: 1,
                active_clients: 4,
                new_clients: 2,
                client_rebinds: 1,
                stale_clients_purged: 2,
                legacy_subscriptions_purged: 0,
            });
        metrics
            .client_tracking
            .record_app_version_request("abc1234", Some("client-a"));
        metrics
            .message_search
            .record_index_operation("upsert", "success");
        metrics.background.record_job("cleanup", "success", 0.01);
        let app = Router::new()
            .route("/metrics", get(metrics_handler))
            .with_state(metrics);

        let response = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/metrics")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("metrics route should respond");

        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body should be readable");
        let body = String::from_utf8(body.to_vec()).expect("metrics body should be utf8");
        assert!(body.contains("http_requests_total"));
        assert!(body.contains("http_request_duration_seconds"));
        assert!(body.contains("http_multipart_duration_seconds"));
        assert!(body.contains("messages_total"));
        assert!(body.contains("push_notifications_total"));
        assert!(body.contains("push_notification_jobs_total"));
        assert!(body.contains("push_notification_job_duration_seconds"));
        assert!(body.contains("push_notifications_suppressed_total"));
        assert!(body.contains("push_delivery_failures_total"));
        assert!(body.contains("push_subscription_prunes_total"));
        assert!(body.contains("ws_connected_users"));
        assert!(body.contains("ws_active_connections"));
        assert!(body.contains("ws_inactive_connections"));
        assert!(body.contains("ws_connections_total"));
        assert!(body.contains("ws_connection_duration_seconds"));
        assert!(body.contains("discuz_avatar_lookup_duration_seconds"));
        assert!(body.contains("discuz_avatar_lookup_fs_duration_seconds"));
        assert!(body.contains("discuz_avatar_lookup_users_total"));
        assert!(body.contains("ws_messages_pushed_total"));
        assert!(body.contains("ws_messages_dropped_total"));
        assert!(body.contains("client_activity_writes_total"));
        assert!(body.contains("client_activity_writes_skipped_total"));
        assert!(body.contains("client_rebinds_total"));
        assert!(body.contains("client_tracking_purge_total"));
        assert!(body.contains("activity_daily_rollup_updates_total"));
        assert!(body.contains("activity_today_active_users"));
        assert!(body.contains("activity_today_new_users"));
        assert!(body.contains("activity_today_active_clients"));
        assert!(body.contains("activity_today_new_clients"));
        assert!(body.contains("activity_today_client_rebinds"));
        assert!(body.contains("activity_today_stale_clients_purged"));
        assert!(body.contains("activity_today_legacy_subscriptions_purged"));
        assert!(body.contains("app_version_requests_total"));
        assert!(body.contains("app_version_unique_clients"));
        assert!(body.contains("message_search_index_operations_total"));
        assert!(body.contains("message_search_queries_total"));
        assert!(body.contains("message_search_query_duration_seconds"));
        assert!(body.contains("message_search_index_operation_duration_seconds"));
        assert!(body.contains("message_search_candidates_per_query"));
        assert!(body.contains("message_search_results_per_query"));
        assert!(body.contains("message_search_candidates_dropped_total"));
        assert!(body.contains("message_search_index_documents_total"));
        assert!(body.contains("message_search_reindex_duration_seconds"));
        assert!(body.contains("message_search_reindex_documents_total"));
        assert!(body.contains("message_search_reindex_last_success_timestamp_seconds"));
        assert!(body.contains("background_jobs_total"));
        assert!(body.contains("background_job_duration_seconds"));
        assert!(body.contains("audio_transcode_source_total"));
        assert!(body.contains("audio_transcode_jobs_total"));
        assert!(body.contains("audio_transcode_job_duration_seconds"));
    }
}
