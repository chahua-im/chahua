use axum::extract::{MatchedPath, State};
use axum::http::{header, HeaderValue, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use dashmap::{DashMap, DashSet};
use prometheus::{
    histogram_opts, opts, Encoder, Histogram, HistogramVec, IntCounter, IntCounterVec, IntGauge,
    IntGaugeVec, Registry, TextEncoder,
};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ActivityTodaySnapshot {
    pub(crate) active_users: i64,
    pub(crate) new_users: i64,
    pub(crate) active_clients: i64,
    pub(crate) new_clients: i64,
    pub(crate) client_rebinds: i64,
    pub(crate) stale_clients_purged: i64,
    pub(crate) legacy_subscriptions_purged: i64,
}

impl ActivityTodaySnapshot {
    pub(crate) const fn zero() -> Self {
        Self {
            active_users: 0,
            new_users: 0,
            active_clients: 0,
            new_clients: 0,
            client_rebinds: 0,
            stale_clients_purged: 0,
            legacy_subscriptions_purged: 0,
        }
    }
}

#[derive(Clone)]
pub(crate) struct Metrics {
    registry: Registry,
    http_requests_total: IntCounterVec,
    http_request_duration_seconds: HistogramVec,
    http_multipart_duration_seconds: HistogramVec,
    messages_total: IntCounterVec,
    push_notifications_total: IntCounterVec,
    push_notification_jobs_total: IntCounterVec,
    push_notification_job_duration_seconds: HistogramVec,
    push_notifications_suppressed_total: IntCounter,
    push_delivery_failures_total: IntCounterVec,
    push_subscription_prunes_total: IntCounterVec,
    ws_connected_users: IntGauge,
    ws_active_connections: IntGauge,
    ws_inactive_connections: IntGauge,
    ws_connections_total: IntCounter,
    ws_connection_duration_seconds: Histogram,
    discuz_avatar_lookup_duration_seconds: Histogram,
    discuz_avatar_lookup_fs_duration_seconds: Histogram,
    discuz_avatar_lookup_users_total: IntCounter,
    ws_messages_pushed_total: IntCounterVec,
    ws_messages_dropped_total: IntCounterVec,
    client_activity_writes_total: IntCounterVec,
    client_activity_writes_skipped_total: IntCounterVec,
    client_rebinds_total: IntCounter,
    client_tracking_purge_total: IntCounterVec,
    activity_daily_rollup_updates_total: IntCounterVec,
    activity_today_active_users: IntGauge,
    activity_today_new_users: IntGauge,
    activity_today_active_clients: IntGauge,
    activity_today_new_clients: IntGauge,
    activity_today_client_rebinds: IntGauge,
    activity_today_stale_clients_purged: IntGauge,
    activity_today_legacy_subscriptions_purged: IntGauge,
    app_version_requests_total: IntCounterVec,
    app_version_unique_clients: IntGaugeVec,
    app_version_clients: DashMap<String, DashSet<String>>,
    message_search_index_operations_total: IntCounterVec,
    message_search_queries_total: IntCounterVec,
    message_search_query_duration_seconds: HistogramVec,
    message_search_index_operation_duration_seconds: HistogramVec,
    message_search_candidates_per_query: HistogramVec,
    message_search_results_per_query: HistogramVec,
    message_search_candidates_dropped_total: IntCounterVec,
    message_search_index_documents_total: IntCounterVec,
    message_search_reindex_duration_seconds: HistogramVec,
    message_search_reindex_documents_total: IntCounterVec,
    message_search_reindex_last_success_timestamp_seconds: IntGauge,
    background_jobs_total: IntCounterVec,
    background_job_duration_seconds: HistogramVec,
    audio_transcode_source_total: IntCounterVec,
    audio_transcode_jobs_total: IntCounterVec,
    audio_transcode_job_duration_seconds: HistogramVec,
}

impl Metrics {
    pub(crate) fn new() -> Self {
        let registry = Registry::new();
        let http_requests_total = IntCounterVec::new(
            opts!(
                "http_requests_total",
                "Total number of HTTP requests handled by the API server"
            ),
            &["method", "route", "status"],
        )
        .expect("http_requests_total metric should be valid");
        let http_request_duration_seconds = HistogramVec::new(
            histogram_opts!(
                "http_request_duration_seconds",
                "HTTP request latency in seconds for the API server",
                vec![0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0]
            ),
            &["method", "route", "status"],
        )
        .expect("http_request_duration_seconds metric should be valid");
        let http_multipart_duration_seconds = HistogramVec::new(
            histogram_opts!(
                "http_multipart_duration_seconds",
                "HTTP multipart request latency in seconds for the API server",
                vec![0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0]
            ),
            &["method", "route", "status"],
        )
        .expect("http_multipart_duration_seconds metric should be valid");
        let messages_total = IntCounterVec::new(
            opts!(
                "messages_total",
                "Total number of messages successfully persisted"
            ),
            &["chat_id"],
        )
        .expect("messages_total metric should be valid");
        let push_notifications_total = IntCounterVec::new(
            opts!(
                "push_notifications_total",
                "Total number of push notification delivery attempts"
            ),
            &["provider", "result"],
        )
        .expect("push_notifications_total metric should be valid");
        let push_notification_jobs_total = IntCounterVec::new(
            opts!(
                "push_notification_jobs_total",
                "Total number of push notification jobs processed by the worker"
            ),
            &["result"],
        )
        .expect("push_notification_jobs_total metric should be valid");
        let push_notification_job_duration_seconds = HistogramVec::new(
            histogram_opts!(
                "push_notification_job_duration_seconds",
                "Push notification job runtime in seconds",
                vec![0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0]
            ),
            &["result"],
        )
        .expect("push_notification_job_duration_seconds metric should be valid");
        let push_notifications_suppressed_total = IntCounter::with_opts(opts!(
            "push_notifications_suppressed_total",
            "Total number of push notifications skipped because a user had active websocket presence"
        ))
        .expect("push_notifications_suppressed_total metric should be valid");
        let push_delivery_failures_total = IntCounterVec::new(
            opts!(
                "push_delivery_failures_total",
                "Total number of classified push delivery failures"
            ),
            &["provider", "class"],
        )
        .expect("push_delivery_failures_total metric should be valid");
        let push_subscription_prunes_total = IntCounterVec::new(
            opts!(
                "push_subscription_prunes_total",
                "Total number of push subscriptions pruned after delivery failures"
            ),
            &["provider", "reason"],
        )
        .expect("push_subscription_prunes_total metric should be valid");
        let ws_connected_users = IntGauge::with_opts(opts!(
            "ws_connected_users",
            "Current number of users with at least one active websocket connection"
        ))
        .expect("ws_connected_users metric should be valid");
        let ws_active_connections = IntGauge::with_opts(opts!(
            "ws_active_connections",
            "Current number of websocket connections reporting active app presence"
        ))
        .expect("ws_active_connections metric should be valid");
        let ws_inactive_connections = IntGauge::with_opts(opts!(
            "ws_inactive_connections",
            "Current number of websocket connections reporting inactive app presence"
        ))
        .expect("ws_inactive_connections metric should be valid");
        let ws_connections_total = IntCounter::with_opts(opts!(
            "ws_connections_total",
            "Total number of successfully established websocket connections"
        ))
        .expect("ws_connections_total metric should be valid");
        let ws_connection_duration_seconds = Histogram::with_opts(histogram_opts!(
            "ws_connection_duration_seconds",
            "Lifetime of websocket connections in seconds",
            vec![1.0, 5.0, 15.0, 30.0, 60.0, 300.0, 900.0, 1800.0, 3600.0, 14400.0]
        ))
        .expect("ws_connection_duration_seconds metric should be valid");
        let discuz_avatar_lookup_duration_seconds = Histogram::with_opts(histogram_opts!(
            "discuz_avatar_lookup_duration_seconds",
            "Discuz avatar lookup latency in seconds",
            vec![0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0]
        ))
        .expect("discuz_avatar_lookup_duration_seconds metric should be valid");
        let discuz_avatar_lookup_fs_duration_seconds = Histogram::with_opts(histogram_opts!(
            "discuz_avatar_lookup_fs_duration_seconds",
            "Filesystem portion of Discuz avatar lookup latency in seconds",
            vec![0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0]
        ))
        .expect("discuz_avatar_lookup_fs_duration_seconds metric should be valid");
        let discuz_avatar_lookup_users_total = IntCounter::with_opts(opts!(
            "discuz_avatar_lookup_users_total",
            "Total number of requested users processed by Discuz avatar lookups"
        ))
        .expect("discuz_avatar_lookup_users_total metric should be valid");
        let ws_messages_pushed_total = IntCounterVec::new(
            opts!(
                "ws_messages_pushed_total",
                "Total number of messages successfully pushed to websocket connections"
            ),
            &["message_type"],
        )
        .expect("ws_messages_pushed_total metric should be valid");
        let ws_messages_dropped_total = IntCounterVec::new(
            opts!(
                "ws_messages_dropped_total",
                "Total number of messages dropped due to full websocket send buffer"
            ),
            &["message_type"],
        )
        .expect("ws_messages_dropped_total metric should be valid");
        let client_activity_writes_total = IntCounterVec::new(
            opts!(
                "client_activity_writes_total",
                "Total number of client activity writes attempted"
            ),
            &["result"],
        )
        .expect("client_activity_writes_total metric should be valid");
        let client_activity_writes_skipped_total = IntCounterVec::new(
            opts!(
                "client_activity_writes_skipped_total",
                "Total number of client activity writes skipped"
            ),
            &["reason"],
        )
        .expect("client_activity_writes_skipped_total metric should be valid");
        let client_rebinds_total = IntCounter::with_opts(opts!(
            "client_rebinds_total",
            "Total number of times a client was rebound to a different user"
        ))
        .expect("client_rebinds_total metric should be valid");
        let client_tracking_purge_total = IntCounterVec::new(
            opts!(
                "client_tracking_purge_total",
                "Total number of client tracking records purged"
            ),
            &["kind"],
        )
        .expect("client_tracking_purge_total metric should be valid");
        let activity_daily_rollup_updates_total = IntCounterVec::new(
            opts!(
                "activity_daily_rollup_updates_total",
                "Total number of daily activity rollup updates"
            ),
            &["result"],
        )
        .expect("activity_daily_rollup_updates_total metric should be valid");
        let activity_today_active_users = IntGauge::with_opts(opts!(
            "activity_today_active_users",
            "Today's exact active user count mirrored from the daily activity rollup"
        ))
        .expect("activity_today_active_users metric should be valid");
        let activity_today_new_users = IntGauge::with_opts(opts!(
            "activity_today_new_users",
            "Today's exact new user count mirrored from the daily activity rollup"
        ))
        .expect("activity_today_new_users metric should be valid");
        let activity_today_active_clients = IntGauge::with_opts(opts!(
            "activity_today_active_clients",
            "Today's exact active client count mirrored from the daily activity rollup"
        ))
        .expect("activity_today_active_clients metric should be valid");
        let activity_today_new_clients = IntGauge::with_opts(opts!(
            "activity_today_new_clients",
            "Today's exact new client count mirrored from the daily activity rollup"
        ))
        .expect("activity_today_new_clients metric should be valid");
        let activity_today_client_rebinds = IntGauge::with_opts(opts!(
            "activity_today_client_rebinds",
            "Today's exact client rebind count mirrored from the daily activity rollup"
        ))
        .expect("activity_today_client_rebinds metric should be valid");
        let activity_today_stale_clients_purged = IntGauge::with_opts(opts!(
            "activity_today_stale_clients_purged",
            "Today's exact stale client purge count mirrored from the daily activity rollup"
        ))
        .expect("activity_today_stale_clients_purged metric should be valid");
        let activity_today_legacy_subscriptions_purged = IntGauge::with_opts(opts!(
            "activity_today_legacy_subscriptions_purged",
            "Today's exact legacy subscription purge count mirrored from the daily activity rollup"
        ))
        .expect("activity_today_legacy_subscriptions_purged metric should be valid");
        let app_version_requests_total = IntCounterVec::new(
            opts!(
                "app_version_requests_total",
                "Total number of HTTP requests by app version"
            ),
            &["version"],
        )
        .expect("app_version_requests_total metric should be valid");
        let app_version_unique_clients = IntGaugeVec::new(
            opts!(
                "app_version_unique_clients",
                "Number of unique client IDs observed per app version"
            ),
            &["version"],
        )
        .expect("app_version_unique_clients metric should be valid");
        let message_search_index_operations_total = IntCounterVec::new(
            opts!(
                "message_search_index_operations_total",
                "Total number of message search index operations"
            ),
            &["operation", "result"],
        )
        .expect("message_search_index_operations_total metric should be valid");
        let message_search_queries_total = IntCounterVec::new(
            opts!(
                "message_search_queries_total",
                "Total number of message search queries"
            ),
            &["sort", "result"],
        )
        .expect("message_search_queries_total metric should be valid");
        for operation in ["upsert", "delete", "delete_batch"] {
            for result in ["success", "failure"] {
                message_search_index_operations_total.with_label_values(&[operation, result]);
            }
        }
        for sort in ["relevance", "newest"] {
            for result in ["success", "failure"] {
                message_search_queries_total.with_label_values(&[sort, result]);
            }
        }
        let message_search_query_duration_seconds = HistogramVec::new(
            histogram_opts!(
                "message_search_query_duration_seconds",
                "Message search request latency in seconds",
                vec![0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0]
            ),
            &["sort", "result"],
        )
        .expect("message_search_query_duration_seconds metric should be valid");
        let message_search_index_operation_duration_seconds = HistogramVec::new(
            histogram_opts!(
                "message_search_index_operation_duration_seconds",
                "Message search index operation latency in seconds from enqueue to Meilisearch task completion",
                vec![0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0]
            ),
            &["operation", "result"],
        )
        .expect("message_search_index_operation_duration_seconds metric should be valid");
        let message_search_candidates_per_query = HistogramVec::new(
            histogram_opts!(
                "message_search_candidates_per_query",
                "Number of Meilisearch candidate hits returned per message search query",
                vec![0.0, 1.0, 5.0, 10.0, 20.0, 50.0, 100.0, 500.0, 1000.0]
            ),
            &["sort"],
        )
        .expect("message_search_candidates_per_query metric should be valid");
        let message_search_results_per_query = HistogramVec::new(
            histogram_opts!(
                "message_search_results_per_query",
                "Number of authoritative messages returned per message search query after database filtering",
                vec![0.0, 1.0, 5.0, 10.0, 20.0, 50.0, 100.0, 500.0, 1000.0]
            ),
            &["sort"],
        )
        .expect("message_search_results_per_query metric should be valid");
        let message_search_candidates_dropped_total = IntCounterVec::new(
            opts!(
                "message_search_candidates_dropped_total",
                "Total number of message search candidates dropped during database authority checks"
            ),
            &["reason"],
        )
        .expect("message_search_candidates_dropped_total metric should be valid");
        let message_search_index_documents_total = IntCounterVec::new(
            opts!(
                "message_search_index_documents_total",
                "Total number of message search index documents affected by index operations"
            ),
            &["operation", "result"],
        )
        .expect("message_search_index_documents_total metric should be valid");
        let message_search_reindex_duration_seconds = HistogramVec::new(
            histogram_opts!(
                "message_search_reindex_duration_seconds",
                "Message search full reindex job latency in seconds",
                vec![1.0, 5.0, 15.0, 30.0, 60.0, 300.0, 900.0, 1800.0, 3600.0]
            ),
            &["result"],
        )
        .expect("message_search_reindex_duration_seconds metric should be valid");
        let message_search_reindex_documents_total = IntCounterVec::new(
            opts!(
                "message_search_reindex_documents_total",
                "Total number of documents indexed by message search reindex jobs"
            ),
            &["result"],
        )
        .expect("message_search_reindex_documents_total metric should be valid");
        let message_search_reindex_last_success_timestamp_seconds = IntGauge::with_opts(opts!(
            "message_search_reindex_last_success_timestamp_seconds",
            "Unix timestamp in seconds for the last successful message search reindex job"
        ))
        .expect("message_search_reindex_last_success_timestamp_seconds metric should be valid");
        for sort in ["relevance", "newest"] {
            message_search_candidates_per_query.with_label_values(&[sort]);
            message_search_results_per_query.with_label_values(&[sort]);
            for result in ["success", "failure"] {
                message_search_query_duration_seconds.with_label_values(&[sort, result]);
            }
        }
        for operation in ["upsert", "delete", "delete_batch"] {
            for result in ["success", "failure"] {
                message_search_index_operation_duration_seconds
                    .with_label_values(&[operation, result]);
                message_search_index_documents_total.with_label_values(&[operation, result]);
            }
        }
        for reason in [
            "missing_db_row",
            "wrong_chat",
            "not_searchable",
            "stale_version",
        ] {
            message_search_candidates_dropped_total.with_label_values(&[reason]);
        }
        for result in ["success", "failure"] {
            message_search_reindex_duration_seconds.with_label_values(&[result]);
            message_search_reindex_documents_total.with_label_values(&[result]);
        }

        let background_jobs_total = IntCounterVec::new(
            opts!(
                "background_jobs_total",
                "Total number of background jobs processed"
            ),
            &["job_kind", "result"],
        )
        .expect("background_jobs_total metric should be valid");
        let background_job_duration_seconds = HistogramVec::new(
            histogram_opts!(
                "background_job_duration_seconds",
                "Background job runtime in seconds",
                vec![0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0]
            ),
            &["job_kind", "result"],
        )
        .expect("background_job_duration_seconds metric should be valid");
        // Pre-initialize label combinations so metrics appear in output before first use.
        background_jobs_total.with_label_values(&["bulk_delete_messages", "success"]);
        background_jobs_total.with_label_values(&["bulk_delete_messages", "failure"]);
        background_job_duration_seconds.with_label_values(&["bulk_delete_messages", "success"]);
        background_job_duration_seconds.with_label_values(&["bulk_delete_messages", "failure"]);
        let audio_transcode_source_total = IntCounterVec::new(
            opts!(
                "audio_transcode_source_total",
                "Total number of audio transcode jobs by normalized source media type"
            ),
            &["content_type"],
        )
        .expect("audio_transcode_source_total metric should be valid");
        let audio_transcode_jobs_total = IntCounterVec::new(
            opts!(
                "audio_transcode_jobs_total",
                "Total number of audio transcode jobs processed"
            ),
            &["result"],
        )
        .expect("audio_transcode_jobs_total metric should be valid");
        let audio_transcode_job_duration_seconds = HistogramVec::new(
            histogram_opts!(
                "audio_transcode_job_duration_seconds",
                "Audio transcode job runtime in seconds",
                vec![0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0]
            ),
            &["result"],
        )
        .expect("audio_transcode_job_duration_seconds metric should be valid");
        audio_transcode_jobs_total.with_label_values(&["success"]);
        audio_transcode_jobs_total.with_label_values(&["failure"]);
        audio_transcode_job_duration_seconds.with_label_values(&["success"]);
        audio_transcode_job_duration_seconds.with_label_values(&["failure"]);

        registry
            .register(Box::new(http_requests_total.clone()))
            .expect("http_requests_total registration should succeed");
        registry
            .register(Box::new(http_request_duration_seconds.clone()))
            .expect("http_request_duration_seconds registration should succeed");
        registry
            .register(Box::new(http_multipart_duration_seconds.clone()))
            .expect("http_multipart_duration_seconds registration should succeed");
        registry
            .register(Box::new(messages_total.clone()))
            .expect("messages_total registration should succeed");
        registry
            .register(Box::new(push_notifications_total.clone()))
            .expect("push_notifications_total registration should succeed");
        registry
            .register(Box::new(push_notification_jobs_total.clone()))
            .expect("push_notification_jobs_total registration should succeed");
        registry
            .register(Box::new(push_notification_job_duration_seconds.clone()))
            .expect("push_notification_job_duration_seconds registration should succeed");
        registry
            .register(Box::new(push_notifications_suppressed_total.clone()))
            .expect("push_notifications_suppressed_total registration should succeed");
        registry
            .register(Box::new(push_delivery_failures_total.clone()))
            .expect("push_delivery_failures_total registration should succeed");
        registry
            .register(Box::new(push_subscription_prunes_total.clone()))
            .expect("push_subscription_prunes_total registration should succeed");
        registry
            .register(Box::new(ws_connected_users.clone()))
            .expect("ws_connected_users registration should succeed");
        registry
            .register(Box::new(ws_active_connections.clone()))
            .expect("ws_active_connections registration should succeed");
        registry
            .register(Box::new(ws_inactive_connections.clone()))
            .expect("ws_inactive_connections registration should succeed");
        registry
            .register(Box::new(ws_connections_total.clone()))
            .expect("ws_connections_total registration should succeed");
        registry
            .register(Box::new(ws_connection_duration_seconds.clone()))
            .expect("ws_connection_duration_seconds registration should succeed");
        registry
            .register(Box::new(discuz_avatar_lookup_duration_seconds.clone()))
            .expect("discuz_avatar_lookup_duration_seconds registration should succeed");
        registry
            .register(Box::new(discuz_avatar_lookup_fs_duration_seconds.clone()))
            .expect("discuz_avatar_lookup_fs_duration_seconds registration should succeed");
        registry
            .register(Box::new(discuz_avatar_lookup_users_total.clone()))
            .expect("discuz_avatar_lookup_users_total registration should succeed");
        registry
            .register(Box::new(ws_messages_pushed_total.clone()))
            .expect("ws_messages_pushed_total registration should succeed");
        registry
            .register(Box::new(ws_messages_dropped_total.clone()))
            .expect("ws_messages_dropped_total registration should succeed");
        registry
            .register(Box::new(client_activity_writes_total.clone()))
            .expect("client_activity_writes_total registration should succeed");
        registry
            .register(Box::new(client_activity_writes_skipped_total.clone()))
            .expect("client_activity_writes_skipped_total registration should succeed");
        registry
            .register(Box::new(client_rebinds_total.clone()))
            .expect("client_rebinds_total registration should succeed");
        registry
            .register(Box::new(client_tracking_purge_total.clone()))
            .expect("client_tracking_purge_total registration should succeed");
        registry
            .register(Box::new(activity_daily_rollup_updates_total.clone()))
            .expect("activity_daily_rollup_updates_total registration should succeed");
        registry
            .register(Box::new(activity_today_active_users.clone()))
            .expect("activity_today_active_users registration should succeed");
        registry
            .register(Box::new(activity_today_new_users.clone()))
            .expect("activity_today_new_users registration should succeed");
        registry
            .register(Box::new(activity_today_active_clients.clone()))
            .expect("activity_today_active_clients registration should succeed");
        registry
            .register(Box::new(activity_today_new_clients.clone()))
            .expect("activity_today_new_clients registration should succeed");
        registry
            .register(Box::new(activity_today_client_rebinds.clone()))
            .expect("activity_today_client_rebinds registration should succeed");
        registry
            .register(Box::new(activity_today_stale_clients_purged.clone()))
            .expect("activity_today_stale_clients_purged registration should succeed");
        registry
            .register(Box::new(activity_today_legacy_subscriptions_purged.clone()))
            .expect("activity_today_legacy_subscriptions_purged registration should succeed");
        registry
            .register(Box::new(app_version_requests_total.clone()))
            .expect("app_version_requests_total registration should succeed");
        registry
            .register(Box::new(app_version_unique_clients.clone()))
            .expect("app_version_unique_clients registration should succeed");
        registry
            .register(Box::new(message_search_index_operations_total.clone()))
            .expect("message_search_index_operations_total registration should succeed");
        registry
            .register(Box::new(message_search_queries_total.clone()))
            .expect("message_search_queries_total registration should succeed");
        registry
            .register(Box::new(message_search_query_duration_seconds.clone()))
            .expect("message_search_query_duration_seconds registration should succeed");
        registry
            .register(Box::new(
                message_search_index_operation_duration_seconds.clone(),
            ))
            .expect("message_search_index_operation_duration_seconds registration should succeed");
        registry
            .register(Box::new(message_search_candidates_per_query.clone()))
            .expect("message_search_candidates_per_query registration should succeed");
        registry
            .register(Box::new(message_search_results_per_query.clone()))
            .expect("message_search_results_per_query registration should succeed");
        registry
            .register(Box::new(message_search_candidates_dropped_total.clone()))
            .expect("message_search_candidates_dropped_total registration should succeed");
        registry
            .register(Box::new(message_search_index_documents_total.clone()))
            .expect("message_search_index_documents_total registration should succeed");
        registry
            .register(Box::new(message_search_reindex_duration_seconds.clone()))
            .expect("message_search_reindex_duration_seconds registration should succeed");
        registry
            .register(Box::new(message_search_reindex_documents_total.clone()))
            .expect("message_search_reindex_documents_total registration should succeed");
        registry
            .register(Box::new(
                message_search_reindex_last_success_timestamp_seconds.clone(),
            ))
            .expect(
                "message_search_reindex_last_success_timestamp_seconds registration should succeed",
            );
        registry
            .register(Box::new(background_jobs_total.clone()))
            .expect("background_jobs_total registration should succeed");
        registry
            .register(Box::new(background_job_duration_seconds.clone()))
            .expect("background_job_duration_seconds registration should succeed");
        registry
            .register(Box::new(audio_transcode_source_total.clone()))
            .expect("audio_transcode_source_total registration should succeed");
        registry
            .register(Box::new(audio_transcode_jobs_total.clone()))
            .expect("audio_transcode_jobs_total registration should succeed");
        registry
            .register(Box::new(audio_transcode_job_duration_seconds.clone()))
            .expect("audio_transcode_job_duration_seconds registration should succeed");

        Self {
            registry,
            http_requests_total,
            http_request_duration_seconds,
            http_multipart_duration_seconds,
            messages_total,
            push_notifications_total,
            push_notification_jobs_total,
            push_notification_job_duration_seconds,
            push_notifications_suppressed_total,
            push_delivery_failures_total,
            push_subscription_prunes_total,
            ws_connected_users,
            ws_active_connections,
            ws_inactive_connections,
            ws_connections_total,
            ws_connection_duration_seconds,
            discuz_avatar_lookup_duration_seconds,
            discuz_avatar_lookup_fs_duration_seconds,
            discuz_avatar_lookup_users_total,
            ws_messages_pushed_total,
            ws_messages_dropped_total,
            client_activity_writes_total,
            client_activity_writes_skipped_total,
            client_rebinds_total,
            client_tracking_purge_total,
            activity_daily_rollup_updates_total,
            activity_today_active_users,
            activity_today_new_users,
            activity_today_active_clients,
            activity_today_new_clients,
            activity_today_client_rebinds,
            activity_today_stale_clients_purged,
            activity_today_legacy_subscriptions_purged,
            app_version_requests_total,
            app_version_unique_clients,
            app_version_clients: DashMap::new(),
            message_search_index_operations_total,
            message_search_queries_total,
            message_search_query_duration_seconds,
            message_search_index_operation_duration_seconds,
            message_search_candidates_per_query,
            message_search_results_per_query,
            message_search_candidates_dropped_total,
            message_search_index_documents_total,
            message_search_reindex_duration_seconds,
            message_search_reindex_documents_total,
            message_search_reindex_last_success_timestamp_seconds,
            background_jobs_total,
            background_job_duration_seconds,
            audio_transcode_source_total,
            audio_transcode_jobs_total,
            audio_transcode_job_duration_seconds,
        }
    }

    pub(crate) fn record_http(
        &self,
        method: &str,
        route: &str,
        status: StatusCode,
        duration_seconds: f64,
    ) {
        let status = status.as_u16().to_string();
        self.http_requests_total
            .with_label_values(&[method, route, &status])
            .inc();
        self.http_request_duration_seconds
            .with_label_values(&[method, route, &status])
            .observe(duration_seconds);
    }

    pub(crate) fn record_http_multipart(
        &self,
        method: &str,
        route: &str,
        status: StatusCode,
        duration_seconds: f64,
    ) {
        let status = status.as_u16().to_string();
        self.http_multipart_duration_seconds
            .with_label_values(&[method, route, &status])
            .observe(duration_seconds);
    }

    pub(crate) fn render(&self) -> Result<String, prometheus::Error> {
        let metric_families = self.registry.gather();
        let mut output = Vec::new();
        TextEncoder::new().encode(&metric_families, &mut output)?;
        String::from_utf8(output)
            .map_err(|err| prometheus::Error::Msg(err.utf8_error().to_string()))
    }

    pub(crate) fn record_message(&self, chat_id: i64) {
        let chat_id = chat_id.to_string();
        self.messages_total.with_label_values(&[&chat_id]).inc();
    }

    pub(crate) fn record_push_notification(&self, provider: &str, success: bool) {
        let result = if success { "success" } else { "failure" };
        self.push_notifications_total
            .with_label_values(&[provider, result])
            .inc();
    }

    pub(crate) fn record_push_job(&self, result: &str, duration_seconds: f64) {
        self.push_notification_jobs_total
            .with_label_values(&[result])
            .inc();
        self.push_notification_job_duration_seconds
            .with_label_values(&[result])
            .observe(duration_seconds);
    }

    pub(crate) fn record_background_job(
        &self,
        job_kind: &str,
        result: &str,
        duration_seconds: f64,
    ) {
        self.background_jobs_total
            .with_label_values(&[job_kind, result])
            .inc();
        self.background_job_duration_seconds
            .with_label_values(&[job_kind, result])
            .observe(duration_seconds);
    }

    pub(crate) fn record_audio_transcode_source(&self, content_type: &str) {
        let normalized = normalize_metric_content_type(content_type);
        self.audio_transcode_source_total
            .with_label_values(&[normalized.as_str()])
            .inc();
    }

    pub(crate) fn record_audio_transcode_job(&self, result: &str, duration_seconds: f64) {
        self.audio_transcode_jobs_total
            .with_label_values(&[result])
            .inc();
        self.audio_transcode_job_duration_seconds
            .with_label_values(&[result])
            .observe(duration_seconds);
    }

    pub(crate) fn set_ws_connected_users(&self, connected_users: usize) {
        self.ws_connected_users.set(connected_users as i64);
    }

    pub(crate) fn set_ws_connection_states(
        &self,
        active_connections: usize,
        inactive_connections: usize,
    ) {
        self.ws_active_connections.set(active_connections as i64);
        self.ws_inactive_connections
            .set(inactive_connections as i64);
    }

    pub(crate) fn record_push_suppressed(&self) {
        self.push_notifications_suppressed_total.inc();
    }

    pub(crate) fn record_push_delivery_failure(&self, provider: &str, class: &str) {
        self.push_delivery_failures_total
            .with_label_values(&[provider, class])
            .inc();
    }

    pub(crate) fn record_push_subscription_prune(&self, provider: &str, reason: &str) {
        self.push_subscription_prunes_total
            .with_label_values(&[provider, reason])
            .inc();
    }

    pub(crate) fn record_ws_connection_open(&self) {
        self.ws_connections_total.inc();
    }

    pub(crate) fn record_ws_connection_duration(&self, duration_seconds: f64) {
        self.ws_connection_duration_seconds
            .observe(duration_seconds);
    }

    pub(crate) fn record_discuz_avatar_lookup(
        &self,
        requested_users: usize,
        duration_seconds: f64,
        fs_duration_seconds: f64,
    ) {
        self.discuz_avatar_lookup_duration_seconds
            .observe(duration_seconds);
        self.discuz_avatar_lookup_fs_duration_seconds
            .observe(fs_duration_seconds);
        self.discuz_avatar_lookup_users_total
            .inc_by(requested_users as u64);
    }

    pub(crate) fn record_ws_message_pushed(&self, message_type: &str) {
        self.ws_messages_pushed_total
            .with_label_values(&[message_type])
            .inc();
    }

    pub(crate) fn record_ws_message_dropped(&self, message_type: &str) {
        self.ws_messages_dropped_total
            .with_label_values(&[message_type])
            .inc();
    }

    pub(crate) fn record_client_activity_write(&self, result: &str) {
        self.client_activity_writes_total
            .with_label_values(&[result])
            .inc();
    }

    pub(crate) fn record_client_activity_write_skipped(&self, reason: &str) {
        self.client_activity_writes_skipped_total
            .with_label_values(&[reason])
            .inc();
    }

    pub(crate) fn record_client_rebind(&self) {
        self.client_rebinds_total.inc();
    }

    pub(crate) fn record_client_tracking_purge(&self, kind: &str, count: u64) {
        self.client_tracking_purge_total
            .with_label_values(&[kind])
            .inc_by(count);
    }

    pub(crate) fn record_activity_daily_rollup_update(&self, result: &str) {
        self.activity_daily_rollup_updates_total
            .with_label_values(&[result])
            .inc();
    }

    pub(crate) fn record_app_version_request(&self, version: &str, client_id: Option<&str>) {
        self.app_version_requests_total
            .with_label_values(&[version])
            .inc();
        if let Some(cid) = client_id {
            let set = self
                .app_version_clients
                .entry(version.to_owned())
                .or_default();
            if set.insert(cid.to_owned()) {
                self.app_version_unique_clients
                    .with_label_values(&[version])
                    .set(set.len() as i64);
            }
        }
    }

    pub(crate) fn record_message_search_index_operation(&self, operation: &str, result: &str) {
        self.message_search_index_operations_total
            .with_label_values(&[operation, result])
            .inc();
    }

    pub(crate) fn record_message_search_query(&self, sort: &str, result: &str) {
        self.message_search_queries_total
            .with_label_values(&[sort, result])
            .inc();
    }

    pub(crate) fn record_message_search_query_duration(
        &self,
        sort: &str,
        result: &str,
        duration_seconds: f64,
    ) {
        self.message_search_query_duration_seconds
            .with_label_values(&[sort, result])
            .observe(duration_seconds);
    }

    pub(crate) fn record_message_search_index_operation_duration(
        &self,
        operation: &str,
        result: &str,
        duration_seconds: f64,
    ) {
        self.message_search_index_operation_duration_seconds
            .with_label_values(&[operation, result])
            .observe(duration_seconds);
    }

    pub(crate) fn observe_message_search_candidates(&self, sort: &str, count: usize) {
        self.message_search_candidates_per_query
            .with_label_values(&[sort])
            .observe(count as f64);
    }

    pub(crate) fn observe_message_search_results(&self, sort: &str, count: usize) {
        self.message_search_results_per_query
            .with_label_values(&[sort])
            .observe(count as f64);
    }

    pub(crate) fn record_message_search_candidate_drop(&self, reason: &str, count: usize) {
        if count == 0 {
            return;
        }
        self.message_search_candidates_dropped_total
            .with_label_values(&[reason])
            .inc_by(count as u64);
    }

    pub(crate) fn record_message_search_index_documents(
        &self,
        operation: &str,
        result: &str,
        count: usize,
    ) {
        if count == 0 {
            return;
        }
        self.message_search_index_documents_total
            .with_label_values(&[operation, result])
            .inc_by(count as u64);
    }

    pub(crate) fn record_message_search_reindex(
        &self,
        result: &str,
        duration_seconds: f64,
        document_count: usize,
    ) {
        self.message_search_reindex_duration_seconds
            .with_label_values(&[result])
            .observe(duration_seconds);
        if document_count > 0 {
            self.message_search_reindex_documents_total
                .with_label_values(&[result])
                .inc_by(document_count as u64);
        }
        if result == "success" {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs() as i64)
                .unwrap_or_default();
            self.message_search_reindex_last_success_timestamp_seconds
                .set(timestamp);
        }
    }

    pub(crate) fn set_activity_today(&self, snapshot: ActivityTodaySnapshot) {
        self.activity_today_active_users.set(snapshot.active_users);
        self.activity_today_new_users.set(snapshot.new_users);
        self.activity_today_active_clients
            .set(snapshot.active_clients);
        self.activity_today_new_clients.set(snapshot.new_clients);
        self.activity_today_client_rebinds
            .set(snapshot.client_rebinds);
        self.activity_today_stale_clients_purged
            .set(snapshot.stale_clients_purged);
        self.activity_today_legacy_subscriptions_purged
            .set(snapshot.legacy_subscriptions_purged);
    }
}

pub(crate) async fn track_http_metrics(
    State(metrics): State<Arc<Metrics>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let method = request.method().as_str().to_string();
    let route = route_label(
        request
            .extensions()
            .get::<MatchedPath>()
            .map(MatchedPath::as_str),
    );
    let is_multipart = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("multipart/form-data"));
    let start = Instant::now();

    let response = next.run(request).await;
    let elapsed = start.elapsed().as_secs_f64();
    if is_multipart {
        metrics.record_http_multipart(&method, &route, response.status(), elapsed);
    } else {
        metrics.record_http(&method, &route, response.status(), elapsed);
    }

    response
}

pub(crate) async fn metrics_handler(
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

fn route_label(matched_path: Option<&str>) -> String {
    matched_path.unwrap_or("unknown").to_string()
}

fn normalize_metric_content_type(content_type: &str) -> String {
    let normalized = content_type
        .split(';')
        .next()
        .unwrap_or("unknown")
        .trim()
        .to_ascii_lowercase();

    match normalized.as_str() {
        "" => "unknown".to_string(),
        "audio/ogg" => "audio/ogg".to_string(),
        "audio/mp4" => "audio/mp4".to_string(),
        "audio/mpeg" => "audio/mpeg".to_string(),
        "audio/webm" => "audio/webm".to_string(),
        "audio/wav" | "audio/x-wav" => "audio/wav".to_string(),
        "audio/aac" | "audio/aacp" => "audio/aac".to_string(),
        "audio/flac" => "audio/flac".to_string(),
        value if value.starts_with("audio/") => "other".to_string(),
        _ => "unknown".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use axum::routing::get;
    use axum::{middleware, Router};
    use tower::ServiceExt;

    async fn ok_handler() -> &'static str {
        "ok"
    }

    async fn not_found_handler() -> StatusCode {
        StatusCode::NOT_FOUND
    }

    #[test]
    fn route_label_falls_back_to_unknown() {
        assert_eq!(route_label(None), "unknown");
    }

    #[tokio::test]
    async fn metrics_endpoint_renders_registered_collectors() {
        let metrics = Arc::new(Metrics::new());
        metrics.record_http("GET", "/seed", StatusCode::OK, 0.001);
        metrics.record_http_multipart("POST", "/upload", StatusCode::CREATED, 0.05);
        metrics.record_message(42);
        metrics.record_push_notification("web_push", true);
        metrics.record_push_job("success", 0.002);
        metrics.record_push_suppressed();
        metrics.set_ws_connected_users(2);
        metrics.set_ws_connection_states(1, 1);
        metrics.record_ws_connection_open();
        metrics.record_ws_connection_duration(12.0);
        metrics.record_discuz_avatar_lookup(2, 0.003, 0.001);
        metrics.record_ws_message_pushed("message");
        metrics.record_ws_message_dropped("message");
        metrics.record_client_activity_write("success");
        metrics.record_client_activity_write_skipped("throttled");
        metrics.record_client_rebind();
        metrics.record_client_tracking_purge("stale_clients", 2);
        metrics.record_activity_daily_rollup_update("success");
        metrics.record_audio_transcode_source("audio/ogg;codecs=opus");
        metrics.record_audio_transcode_job("success", 0.75);
        metrics.set_activity_today(ActivityTodaySnapshot {
            active_users: 3,
            new_users: 1,
            active_clients: 4,
            new_clients: 2,
            client_rebinds: 1,
            stale_clients_purged: 2,
            legacy_subscriptions_purged: 0,
        });
        metrics.record_app_version_request("abc1234", Some("client-a"));
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

    #[tokio::test]
    async fn http_metrics_count_requests_by_matched_route() {
        let metrics = Arc::new(Metrics::new());
        let app = Router::new().route("/items/{id}", get(ok_handler)).layer(
            middleware::from_fn_with_state(metrics.clone(), track_http_metrics),
        );

        let response = app
            .oneshot(
                HttpRequest::builder()
                    .method("GET")
                    .uri("/items/42")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("app should respond");

        assert_eq!(response.status(), StatusCode::OK);

        let rendered = metrics.render().expect("metrics should render");
        assert!(rendered.contains("http_requests_total"));
        assert!(rendered.contains("method=\"GET\",route=\"/items/{id}\",status=\"200\""));
    }

    #[tokio::test]
    async fn http_metrics_record_unknown_for_unmatched_requests() {
        let metrics = Arc::new(Metrics::new());
        let app =
            Router::new()
                .fallback(get(not_found_handler))
                .layer(middleware::from_fn_with_state(
                    metrics.clone(),
                    track_http_metrics,
                ));

        let response = app
            .oneshot(
                HttpRequest::builder()
                    .method("GET")
                    .uri("/missing")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("app should respond");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let rendered = metrics.render().expect("metrics should render");
        assert!(rendered.contains("method=\"GET\",route=\"unknown\",status=\"404\""));
    }

    #[tokio::test]
    async fn multipart_requests_use_dedicated_duration_metric() {
        let metrics = Arc::new(Metrics::new());
        let app =
            Router::new()
                .route("/upload", get(ok_handler))
                .layer(middleware::from_fn_with_state(
                    metrics.clone(),
                    track_http_metrics,
                ));

        let response = app
            .oneshot(
                HttpRequest::builder()
                    .method("GET")
                    .uri("/upload")
                    .header(header::CONTENT_TYPE, "multipart/form-data; boundary=abc123")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("app should respond");

        assert_eq!(response.status(), StatusCode::OK);

        let rendered = metrics.render().expect("metrics should render");
        assert!(rendered.contains("http_multipart_duration_seconds"));
        assert!(rendered.contains(
            "http_multipart_duration_seconds_bucket{method=\"GET\",route=\"/upload\",status=\"200\""
        ));
        assert!(!rendered
            .contains("http_requests_total{method=\"GET\",route=\"/upload\",status=\"200\"} 1"));
        assert!(!rendered.contains(
            "http_request_duration_seconds_bucket{method=\"GET\",route=\"/upload\",status=\"200\""
        ));
    }

    #[test]
    fn discuz_metrics_render_expected_values() {
        let metrics = Metrics::new();
        metrics.record_message(123);
        metrics.record_push_notification("web_push", true);
        metrics.record_push_notification("apns", false);
        metrics.record_push_job("success", 0.2);
        metrics.record_push_job("failure", 0.4);
        metrics.record_push_suppressed();
        metrics.set_ws_connected_users(1);
        metrics.set_ws_connection_states(1, 0);
        metrics.record_ws_connection_open();
        metrics.record_ws_connection_duration(30.0);
        metrics.record_discuz_avatar_lookup(3, 0.015, 0.006);
        metrics.record_ws_message_pushed("message");
        metrics.record_ws_message_pushed("message");
        metrics.record_ws_message_dropped("message_updated");
        metrics.record_client_activity_write("success");
        metrics.record_client_activity_write_skipped("throttled");
        metrics.record_client_rebind();
        metrics.record_client_tracking_purge("legacy_subscriptions", 3);
        metrics.record_activity_daily_rollup_update("success");
        metrics.record_audio_transcode_source("audio/ogg");
        metrics.record_audio_transcode_job("failure", 1.5);
        metrics.record_message_search_index_operation("upsert", "success");
        metrics.record_message_search_query("relevance", "failure");
        metrics.record_message_search_query_duration("relevance", "success", 0.42);
        metrics.record_message_search_index_operation_duration("upsert", "success", 1.25);
        metrics.observe_message_search_candidates("relevance", 20);
        metrics.observe_message_search_results("relevance", 18);
        metrics.record_message_search_candidate_drop("stale_version", 2);
        metrics.record_message_search_index_documents("upsert", "success", 1);
        metrics.record_message_search_reindex("success", 3.5, 500);
        metrics.set_activity_today(ActivityTodaySnapshot {
            active_users: 5,
            new_users: 2,
            active_clients: 6,
            new_clients: 3,
            client_rebinds: 1,
            stale_clients_purged: 0,
            legacy_subscriptions_purged: 0,
        });

        let rendered = metrics.render().expect("metrics should render");
        assert!(rendered.contains("messages_total{chat_id=\"123\"} 1"));
        assert!(rendered
            .contains("push_notifications_total{provider=\"web_push\",result=\"success\"} 1"));
        assert!(
            rendered.contains("push_notifications_total{provider=\"apns\",result=\"failure\"} 1")
        );
        assert!(rendered.contains("push_notification_jobs_total{result=\"success\"} 1"));
        assert!(rendered.contains("push_notification_jobs_total{result=\"failure\"} 1"));
        assert!(
            rendered.contains("push_notification_job_duration_seconds_sum{result=\"success\"} 0.2")
        );
        assert!(
            rendered.contains("push_notification_job_duration_seconds_sum{result=\"failure\"} 0.4")
        );
        assert!(
            rendered.contains("push_notification_job_duration_seconds_count{result=\"success\"} 1")
        );
        assert!(
            rendered.contains("push_notification_job_duration_seconds_count{result=\"failure\"} 1")
        );
        assert!(rendered.contains("push_notifications_suppressed_total 1"));
        assert!(rendered.contains("ws_connected_users 1"));
        assert!(rendered.contains("ws_active_connections 1"));
        assert!(rendered.contains("ws_inactive_connections 0"));
        assert!(rendered.contains("ws_connections_total 1"));
        assert!(rendered.contains("ws_connection_duration_seconds_sum"));
        assert!(rendered.contains("discuz_avatar_lookup_duration_seconds_sum"));
        assert!(rendered.contains("discuz_avatar_lookup_fs_duration_seconds_sum"));
        assert!(rendered.contains("discuz_avatar_lookup_users_total 3"));
        assert!(rendered.contains("ws_messages_pushed_total{message_type=\"message\"} 2"));
        assert!(rendered.contains("ws_messages_dropped_total{message_type=\"message_updated\"} 1"));
        assert!(rendered.contains("client_activity_writes_total{result=\"success\"} 1"));
        assert!(rendered.contains("client_activity_writes_skipped_total{reason=\"throttled\"} 1"));
        assert!(rendered.contains("client_rebinds_total 1"));
        assert!(rendered.contains("client_tracking_purge_total{kind=\"legacy_subscriptions\"} 3"));
        assert!(rendered.contains("activity_daily_rollup_updates_total{result=\"success\"} 1"));
        assert!(rendered.contains("audio_transcode_source_total{content_type=\"audio/ogg\"} 1"));
        assert!(rendered.contains("audio_transcode_jobs_total{result=\"failure\"} 1"));
        assert!(
            rendered.contains("audio_transcode_job_duration_seconds_sum{result=\"failure\"} 1.5")
        );
        assert!(rendered.contains(
            "message_search_index_operations_total{operation=\"upsert\",result=\"success\"} 1"
        ));
        assert!(rendered
            .contains("message_search_queries_total{result=\"failure\",sort=\"relevance\"} 1"));
        assert!(rendered.contains(
            "message_search_query_duration_seconds_sum{result=\"success\",sort=\"relevance\"} 0.42"
        ));
        assert!(rendered.contains(
            "message_search_index_operation_duration_seconds_sum{operation=\"upsert\",result=\"success\"} 1.25"
        ));
        assert!(rendered.contains("message_search_candidates_per_query_sum{sort=\"relevance\"} 20"));
        assert!(rendered.contains("message_search_results_per_query_sum{sort=\"relevance\"} 18"));
        assert!(rendered
            .contains("message_search_candidates_dropped_total{reason=\"stale_version\"} 2"));
        assert!(rendered.contains(
            "message_search_index_documents_total{operation=\"upsert\",result=\"success\"} 1"
        ));
        assert!(rendered
            .contains("message_search_reindex_duration_seconds_sum{result=\"success\"} 3.5"));
        assert!(rendered.contains("message_search_reindex_documents_total{result=\"success\"} 500"));
        assert!(rendered.contains("message_search_reindex_last_success_timestamp_seconds"));
        assert!(rendered.contains("activity_today_active_users 5"));
        assert!(rendered.contains("activity_today_new_users 2"));
        assert!(rendered.contains("activity_today_active_clients 6"));
        assert!(rendered.contains("activity_today_new_clients 3"));
        assert!(rendered.contains("activity_today_client_rebinds 1"));

        metrics.record_app_version_request("v1.0", Some("c1"));
        metrics.record_app_version_request("v1.0", Some("c2"));
        metrics.record_app_version_request("v2.0", None);
        let rendered = metrics.render().expect("metrics should render");
        assert!(rendered.contains("app_version_requests_total{version=\"v1.0\"} 2"));
        assert!(rendered.contains("app_version_requests_total{version=\"v2.0\"} 1"));
        assert!(rendered.contains("app_version_unique_clients{version=\"v1.0\"} 2"));
    }

    #[test]
    fn app_version_tracks_unique_clients_per_version() {
        let metrics = Metrics::new();

        // Two requests from same client on same version — unique count stays 1
        metrics.record_app_version_request("abc1234", Some("client-a"));
        metrics.record_app_version_request("abc1234", Some("client-a"));
        let rendered = metrics.render().expect("metrics should render");
        assert!(rendered.contains("app_version_requests_total{version=\"abc1234\"} 2"));
        assert!(rendered.contains("app_version_unique_clients{version=\"abc1234\"} 1"));

        // Different client on same version — unique count becomes 2
        metrics.record_app_version_request("abc1234", Some("client-b"));
        let rendered = metrics.render().expect("metrics should render");
        assert!(rendered.contains("app_version_requests_total{version=\"abc1234\"} 3"));
        assert!(rendered.contains("app_version_unique_clients{version=\"abc1234\"} 2"));

        // Request without client_id — request counter increments, unique count unchanged
        metrics.record_app_version_request("abc1234", None);
        let rendered = metrics.render().expect("metrics should render");
        assert!(rendered.contains("app_version_requests_total{version=\"abc1234\"} 4"));
        assert!(rendered.contains("app_version_unique_clients{version=\"abc1234\"} 2"));
    }

    #[test]
    fn audio_transcode_source_metric_normalizes_content_type() {
        let metrics = Metrics::new();

        metrics.record_audio_transcode_source("Audio/Ogg;codecs=opus");
        metrics.record_audio_transcode_source("audio/x-custom-thing");

        let rendered = metrics.render().expect("metrics should render");
        assert!(rendered.contains("audio_transcode_source_total{content_type=\"audio/ogg\"} 1"));
        assert!(rendered.contains("audio_transcode_source_total{content_type=\"other\"} 1"));
    }
}
