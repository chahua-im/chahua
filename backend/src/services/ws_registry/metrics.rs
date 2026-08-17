use prometheus::{
    register_histogram_with_registry, register_int_counter_vec_with_registry,
    register_int_counter_with_registry, register_int_gauge_with_registry, Histogram, IntCounter,
    IntCounterVec, IntGauge, Registry,
};

pub struct WsMetrics {
    connected_users: IntGauge,
    active_connections: IntGauge,
    inactive_connections: IntGauge,
    connections_total: IntCounter,
    connection_duration_seconds: Histogram,
    messages_pushed_total: IntCounterVec,
    messages_dropped_total: IntCounterVec,
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

        Self {
            connected_users,
            active_connections,
            inactive_connections,
            connections_total,
            connection_duration_seconds,
            messages_pushed_total,
            messages_dropped_total,
        }
    }

    pub fn set_connected_users(&self, connected_users: usize) {
        self.connected_users.set(connected_users as i64);
    }

    pub fn set_connection_states(&self, active_connections: usize, inactive_connections: usize) {
        self.active_connections.set(active_connections as i64);
        self.inactive_connections.set(inactive_connections as i64);
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
        metrics.record_connection_open();
        metrics.record_connection_duration(30.0);
        metrics.record_message_pushed("message");
        metrics.record_message_pushed("message");
        metrics.record_message_dropped("message_updated");

        let rendered = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(rendered.contains("ws_connected_users 1"));
        assert!(rendered.contains("ws_active_connections 1"));
        assert!(rendered.contains("ws_inactive_connections 0"));
        assert!(rendered.contains("ws_connections_total 1"));
        assert!(rendered.contains("ws_connection_duration_seconds_sum"));
        assert!(rendered.contains("ws_messages_pushed_total{message_type=\"message\"} 2"));
        assert!(rendered.contains("ws_messages_dropped_total{message_type=\"message_updated\"} 1"));
    }
}
