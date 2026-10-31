use prometheus::{
    register_histogram_vec_with_registry, register_int_counter_vec_with_registry, HistogramVec,
    IntCounterVec, Registry,
};

pub struct RpcMetrics {
    requests_total: IntCounterVec,
    request_duration_seconds: HistogramVec,
}

impl RpcMetrics {
    pub fn new(registry: &Registry) -> Self {
        let requests_total = register_int_counter_vec_with_registry!(
            "rpc_requests_total",
            "Total JSON-RPC calls and protocol rejections by registered method and outcome",
            &["method", "outcome"],
            registry
        )
        .expect("rpc_requests_total registration should succeed");
        let request_duration_seconds = register_histogram_vec_with_registry!(
            "rpc_request_duration_seconds",
            "JSON-RPC dispatch duration in seconds including worker and control-lane wait",
            &["method"],
            vec![0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
            registry
        )
        .expect("rpc_request_duration_seconds registration should succeed");
        Self {
            requests_total,
            request_duration_seconds,
        }
    }

    /// Callers pass registry literals (or "unknown") and fixed outcome names,
    /// never arbitrary peer input, IDs, credentials or application error text.
    pub fn record(&self, method: &'static str, outcome: &'static str, duration_seconds: f64) {
        self.requests_total
            .with_label_values(&[method, outcome])
            .inc();
        self.request_duration_seconds
            .with_label_values(&[method])
            .observe(duration_seconds);
    }
}
