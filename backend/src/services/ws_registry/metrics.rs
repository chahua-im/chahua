use prometheus::{
    register_histogram_with_registry, register_int_counter_vec_with_registry,
    register_int_counter_with_registry, register_int_gauge_with_registry, Histogram, IntCounter,
    IntCounterVec, IntGauge, Registry,
};

pub struct WsMetrics {
    connected_users: IntGauge,
    active_connections: IntGauge,
    inactive_connections: IntGauge,
    long_lived_unknown_connections: IntGauge,
    connections_total: IntCounter,
    connection_duration_seconds: Histogram,
    messages_pushed_total: IntCounterVec,
    messages_dropped_total: IntCounterVec,
    presence_transition_rate_limited_total: IntCounter,
    presence_transition_rate_limit_evictions_total: IntCounter,
    presence_physical_online_users: IntGauge,
    presence_published_online_users: IntGauge,
    presence_debouncing_users: IntGauge,
    presence_persistence_queue_depth: IntGauge,
    presence_persistence_successes_total: IntCounter,
    presence_persistence_failures_total: IntCounter,
    presence_persistence_retries_total: IntCounter,
    presence_transitions_total: IntCounter,
    presence_checkpoints_submitted_total: IntCounter,
    presence_checkpoints_coalesced_total: IntCounter,
    presence_debounce_absorbed_total: IntCounter,
    presence_reconciliations_total: IntCounter,
    presence_broadcast_candidates_total: IntCounter,
    presence_broadcast_filtered_total: IntCounter,
    presence_revocations_enqueued_total: IntCounter,
    presence_revocation_evictions_total: IntCounter,
    presence_metrics_drift_total: IntCounter,
    presence_persistence_degradations_total: IntCounter,
}

impl WsMetrics {
    pub fn new(registry: &Registry) -> Self {
        let connected_users = register_int_gauge_with_registry!(
            "ws_connected_users",
            "Current number of users with at least one active websocket connection",
            registry
        )
        .expect("ws_connected_users registration should succeed");
        let active_connections = register_int_gauge_with_registry!(
            "ws_active_connections",
            "Current number of websocket connections reporting active app presence",
            registry
        )
        .expect("ws_active_connections registration should succeed");
        let inactive_connections = register_int_gauge_with_registry!(
            "ws_inactive_connections",
            "Current number of websocket connections reporting inactive app presence",
            registry
        )
        .expect("ws_inactive_connections registration should succeed");
        let long_lived_unknown_connections = register_int_gauge_with_registry!(
            "ws_long_lived_unknown_connections",
            "Current number of websocket connections that have remained in unknown app presence past the configured threshold",
            registry
        )
        .expect("ws_long_lived_unknown_connections registration should succeed");
        let connections_total = register_int_counter_with_registry!(
            "ws_connections_total",
            "Total number of successfully established websocket connections",
            registry
        )
        .expect("ws_connections_total registration should succeed");
        let connection_duration_seconds = register_histogram_with_registry!(
            "ws_connection_duration_seconds",
            "Lifetime of websocket connections in seconds",
            vec![1.0, 5.0, 15.0, 30.0, 60.0, 300.0, 900.0, 1800.0, 3600.0, 14400.0],
            registry
        )
        .expect("ws_connection_duration_seconds registration should succeed");
        let messages_pushed_total = register_int_counter_vec_with_registry!(
            "ws_messages_pushed_total",
            "Total number of messages successfully pushed to websocket connections",
            &["message_type"],
            registry
        )
        .expect("ws_messages_pushed_total registration should succeed");
        let messages_dropped_total = register_int_counter_vec_with_registry!(
            "ws_messages_dropped_total",
            "Total number of messages dropped due to full websocket send buffer",
            &["message_type"],
            registry
        )
        .expect("ws_messages_dropped_total registration should succeed");
        let presence_transition_rate_limited_total = register_int_counter_with_registry!(
            "ws_presence_transition_rate_limited_total",
            "Presence state transitions rejected for exceeding a rate limit",
            registry
        )
        .expect("ws_presence_transition_rate_limited_total registration should succeed");
        let presence_transition_rate_limit_evictions_total = register_int_counter_with_registry!(
            "ws_presence_transition_rate_limit_evictions_total",
            "WebSocket connections removed after exceeding a presence transition rate limit",
            registry
        )
        .expect("ws_presence_transition_rate_limit_evictions_total registration should succeed");
        let presence_physical_online_users = register_int_gauge_with_registry!(
            "ws_presence_physical_online_users",
            "Current number of users with at least one physically active websocket connection",
            registry
        )
        .expect("ws_presence_physical_online_users registration should succeed");
        let presence_published_online_users = register_int_gauge_with_registry!(
            "ws_presence_published_online_users",
            "Current number of users whose online presence is published",
            registry
        )
        .expect("ws_presence_published_online_users registration should succeed");
        let presence_debouncing_users = register_int_gauge_with_registry!(
            "ws_presence_debouncing_users",
            "Current number of users awaiting normal-disconnect presence confirmation",
            registry
        )
        .expect("ws_presence_debouncing_users registration should succeed");
        let presence_persistence_queue_depth = register_int_gauge_with_registry!(
            "ws_presence_persistence_queue_depth",
            "Current number of presence observations awaiting successful persistence",
            registry
        )
        .expect("ws_presence_persistence_queue_depth registration should succeed");
        let presence_persistence_successes_total = register_int_counter_with_registry!(
            "ws_presence_persistence_successes_total",
            "Total successful presence observation persistence operations",
            registry
        )
        .expect("ws_presence_persistence_successes_total registration should succeed");
        let presence_persistence_failures_total = register_int_counter_with_registry!(
            "ws_presence_persistence_failures_total",
            "Total failed presence observation persistence attempts",
            registry
        )
        .expect("ws_presence_persistence_failures_total registration should succeed");
        let presence_persistence_retries_total = register_int_counter_with_registry!(
            "ws_presence_persistence_retries_total",
            "Total presence observation persistence retries scheduled",
            registry
        )
        .expect("ws_presence_persistence_retries_total registration should succeed");
        let presence_transitions_total = register_int_counter_with_registry!(
            "ws_presence_transitions_total",
            "Total published presence transitions (online/offline) enqueued",
            registry
        )
        .expect("ws_presence_transitions_total registration should succeed");
        let presence_checkpoints_submitted_total = register_int_counter_with_registry!(
            "ws_presence_checkpoints_submitted_total",
            "Total active-presence checkpoint observations enqueued",
            registry
        )
        .expect("ws_presence_checkpoints_submitted_total registration should succeed");
        let presence_checkpoints_coalesced_total = register_int_counter_with_registry!(
            "ws_presence_checkpoints_coalesced_total",
            "Total pending checkpoints replaced by a newer one before persistence",
            registry
        )
        .expect("ws_presence_checkpoints_coalesced_total registration should succeed");
        let presence_debounce_absorbed_total = register_int_counter_with_registry!(
            "ws_presence_debounce_absorbed_total",
            "Total disconnect debounces cancelled by a reconnect before expiry",
            registry
        )
        .expect("ws_presence_debounce_absorbed_total registration should succeed");
        let presence_reconciliations_total = register_int_counter_with_registry!(
            "ws_presence_reconciliations_total",
            "Total presence reconciliation commands processed",
            registry
        )
        .expect("ws_presence_reconciliations_total registration should succeed");
        let presence_broadcast_candidates_total = register_int_counter_with_registry!(
            "ws_presence_broadcast_candidates_total",
            "Total friend candidates considered for presence broadcasts",
            registry
        )
        .expect("ws_presence_broadcast_candidates_total registration should succeed");
        let presence_broadcast_filtered_total = register_int_counter_with_registry!(
            "ws_presence_broadcast_filtered_total",
            "Total presence broadcast candidates removed by privacy/block filtering",
            registry
        )
        .expect("ws_presence_broadcast_filtered_total registration should succeed");
        let presence_revocations_enqueued_total = register_int_counter_with_registry!(
            "ws_presence_revocations_enqueued_total",
            "Total privacy revocation snapshots successfully enqueued to recipients",
            registry
        )
        .expect("ws_presence_revocations_enqueued_total registration should succeed");
        let presence_revocation_evictions_total = register_int_counter_with_registry!(
            "ws_presence_revocation_evictions_total",
            "Total connections evicted because a privacy revocation could not be enqueued",
            registry
        )
        .expect("ws_presence_revocation_evictions_total registration should succeed");
        let presence_metrics_drift_total = register_int_counter_with_registry!(
            "ws_presence_metrics_drift_total",
            "Total low-frequency metric audits that found gauge drift",
            registry
        )
        .expect("ws_presence_metrics_drift_total registration should succeed");
        let presence_persistence_degradations_total = register_int_counter_with_registry!(
            "ws_presence_persistence_degradations_total",
            "Total times a per-uid operation queue was degraded under persistence pressure",
            registry
        )
        .expect("ws_presence_persistence_degradations_total registration should succeed");

        Self {
            connected_users,
            active_connections,
            inactive_connections,
            long_lived_unknown_connections,
            connections_total,
            connection_duration_seconds,
            messages_pushed_total,
            messages_dropped_total,
            presence_transition_rate_limited_total,
            presence_transition_rate_limit_evictions_total,
            presence_physical_online_users,
            presence_published_online_users,
            presence_debouncing_users,
            presence_persistence_queue_depth,
            presence_persistence_successes_total,
            presence_persistence_failures_total,
            presence_persistence_retries_total,
            presence_transitions_total,
            presence_checkpoints_submitted_total,
            presence_checkpoints_coalesced_total,
            presence_debounce_absorbed_total,
            presence_reconciliations_total,
            presence_broadcast_candidates_total,
            presence_broadcast_filtered_total,
            presence_revocations_enqueued_total,
            presence_revocation_evictions_total,
            presence_metrics_drift_total,
            presence_persistence_degradations_total,
        }
    }

    pub fn set_connected_users(&self, connected_users: usize) {
        self.connected_users.set(connected_users as i64);
    }

    pub fn set_connection_states(&self, active_connections: usize, inactive_connections: usize) {
        self.active_connections.set(active_connections as i64);
        self.inactive_connections.set(inactive_connections as i64);
    }

    pub fn set_long_lived_unknown_connections(&self, connections: usize) {
        self.long_lived_unknown_connections.set(connections as i64);
    }

    pub fn add_long_lived_unknown_connections(&self, delta: i64) {
        self.long_lived_unknown_connections.add(delta);
    }

    pub fn record_connection_open(&self) {
        self.connections_total.inc();
    }

    pub fn record_connection_duration(&self, duration_seconds: f64) {
        self.connection_duration_seconds.observe(duration_seconds);
    }

    pub fn record_message_pushed(&self, message_type: &str) {
        self.messages_pushed_total
            .with_label_values(&[message_type])
            .inc();
    }

    pub fn record_message_dropped(&self, message_type: &str) {
        self.messages_dropped_total
            .with_label_values(&[message_type])
            .inc();
    }

    pub fn record_presence_transition_rate_limited(&self) {
        self.presence_transition_rate_limited_total.inc();
    }

    pub fn record_presence_transition_rate_limit_eviction(&self) {
        self.presence_transition_rate_limit_evictions_total.inc();
    }

    pub fn set_presence_users(
        &self,
        physical_online: usize,
        published_online: usize,
        debouncing: usize,
    ) {
        self.presence_physical_online_users
            .set(physical_online as i64);
        self.presence_published_online_users
            .set(published_online as i64);
        self.presence_debouncing_users.set(debouncing as i64);
    }

    /// Incremental helpers for the presence user gauges. The coordinator is
    /// the only writer and applies each delta exactly once per state change,
    /// which keeps per-command work O(1) instead of a full registry scan.
    pub fn add_physical_online_users(&self, delta: i64) {
        self.presence_physical_online_users.add(delta);
    }

    pub fn add_published_online_users(&self, delta: i64) {
        self.presence_published_online_users.add(delta);
    }

    pub fn add_debouncing_users(&self, delta: i64) {
        self.presence_debouncing_users.add(delta);
    }

    pub fn set_presence_persistence_queue_depth(&self, depth: usize) {
        self.presence_persistence_queue_depth.set(depth as i64);
    }

    pub fn record_presence_persistence_success(&self) {
        self.presence_persistence_successes_total.inc();
    }

    pub fn record_presence_persistence_failure(&self) {
        self.presence_persistence_failures_total.inc();
    }

    pub fn record_presence_persistence_retry(&self) {
        self.presence_persistence_retries_total.inc();
    }

    pub fn record_presence_transition(&self) {
        self.presence_transitions_total.inc();
    }

    pub fn record_presence_checkpoint_submitted(&self) {
        self.presence_checkpoints_submitted_total.inc();
    }

    pub fn record_presence_checkpoint_coalesced(&self) {
        self.presence_checkpoints_coalesced_total.inc();
    }

    pub fn record_presence_debounce_absorbed(&self) {
        self.presence_debounce_absorbed_total.inc();
    }

    pub fn record_presence_reconciliation(&self) {
        self.presence_reconciliations_total.inc();
    }

    pub fn record_presence_broadcast_audience(&self, candidates: usize, filtered: usize) {
        if candidates > 0 {
            self.presence_broadcast_candidates_total
                .inc_by(candidates as u64);
        }
        if filtered > 0 {
            self.presence_broadcast_filtered_total
                .inc_by(filtered as u64);
        }
    }

    pub fn record_presence_revocation_enqueued(&self) {
        self.presence_revocations_enqueued_total.inc();
    }

    pub fn record_presence_revocation_eviction(&self) {
        self.presence_revocation_evictions_total.inc();
    }

    pub fn record_presence_metrics_drift(&self) {
        self.presence_metrics_drift_total.inc();
    }

    pub fn record_presence_degradation(&self) {
        self.presence_persistence_degradations_total.inc();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_metrics_render_expected_values() {
        let registry = Registry::new();
        let metrics = WsMetrics::new(&registry);
        metrics.set_connected_users(1);
        metrics.set_connection_states(1, 0);
        metrics.set_long_lived_unknown_connections(2);
        metrics.record_connection_open();
        metrics.record_connection_duration(30.0);
        metrics.record_message_pushed("message");
        metrics.record_message_pushed("message");
        metrics.record_message_dropped("message_updated");
        metrics.set_presence_users(2, 1, 1);
        metrics.set_presence_persistence_queue_depth(3);
        metrics.record_presence_persistence_success();
        metrics.record_presence_persistence_failure();
        metrics.record_presence_persistence_retry();
        metrics.record_presence_transition();
        metrics.record_presence_checkpoint_submitted();
        metrics.record_presence_checkpoint_coalesced();
        metrics.record_presence_debounce_absorbed();
        metrics.record_presence_reconciliation();
        metrics.record_presence_broadcast_audience(5, 2);
        metrics.record_presence_revocation_enqueued();
        metrics.record_presence_revocation_eviction();
        metrics.record_presence_metrics_drift();
        metrics.record_presence_degradation();
        metrics.add_physical_online_users(1);
        metrics.add_published_online_users(1);
        metrics.add_debouncing_users(-1);

        let rendered = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(rendered.contains("ws_connected_users 1"));
        assert!(rendered.contains("ws_active_connections 1"));
        assert!(rendered.contains("ws_inactive_connections 0"));
        assert!(rendered.contains("ws_long_lived_unknown_connections 2"));
        assert!(rendered.contains("ws_connections_total 1"));
        assert!(rendered.contains("ws_connection_duration_seconds_sum"));
        assert!(rendered.contains("ws_messages_pushed_total{message_type=\"message\"} 2"));
        assert!(rendered.contains("ws_messages_dropped_total{message_type=\"message_updated\"} 1"));
        assert!(rendered.contains("ws_presence_persistence_queue_depth 3"));
        assert!(rendered.contains("ws_presence_persistence_successes_total 1"));
        assert!(rendered.contains("ws_presence_persistence_failures_total 1"));
        assert!(rendered.contains("ws_presence_persistence_retries_total 1"));
        assert!(rendered.contains("ws_presence_transitions_total 1"));
        assert!(rendered.contains("ws_presence_checkpoints_submitted_total 1"));
        assert!(rendered.contains("ws_presence_checkpoints_coalesced_total 1"));
        assert!(rendered.contains("ws_presence_debounce_absorbed_total 1"));
        assert!(rendered.contains("ws_presence_reconciliations_total 1"));
        assert!(rendered.contains("ws_presence_broadcast_candidates_total 5"));
        assert!(rendered.contains("ws_presence_broadcast_filtered_total 2"));
        assert!(rendered.contains("ws_presence_revocations_enqueued_total 1"));
        assert!(rendered.contains("ws_presence_revocation_evictions_total 1"));
        assert!(rendered.contains("ws_presence_metrics_drift_total 1"));
        assert!(rendered.contains("ws_presence_persistence_degradations_total 1"));
        assert!(rendered.contains("ws_presence_physical_online_users 3"));
        assert!(rendered.contains("ws_presence_published_online_users 2"));
        assert!(rendered.contains("ws_presence_debouncing_users 0"));
    }
}
