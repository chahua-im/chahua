use axum::http::StatusCode;
use prometheus::{
    register_histogram_vec_with_registry, register_int_counter_vec_with_registry, HistogramVec,
    IntCounterVec, Registry,
};

pub struct ApiMetrics {
    requests_total: IntCounterVec,
    request_duration_seconds: HistogramVec,
}

impl ApiMetrics {
    pub fn new(registry: &Registry) -> Self {
        let requests_total = register_int_counter_vec_with_registry!(
            "api_requests_total",
            "Completed logical API calls and rejections by transport, operation and outcome",
            &["transport", "api", "status", "error_code"],
            registry
        )
        .expect("api_requests_total registration should succeed");
        let request_duration_seconds = register_histogram_vec_with_registry!(
            "api_request_duration_seconds",
            "Server-side API turnaround through individual response preparation in seconds",
            &["transport", "api", "status"],
            vec![0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
            registry
        )
        .expect("api_request_duration_seconds registration should succeed");
        Self {
            requests_total,
            request_duration_seconds,
        }
    }

    /// Operation and transport are registry literals; error codes are fixed native
    /// protocol codes, never peer input or error text. RPC status is HTTP-equivalent.
    pub fn record(
        &self,
        transport: &'static str,
        api: &'static str,
        status: StatusCode,
        error_code: &str,
        duration_seconds: f64,
    ) {
        let status = status.as_str();
        self.requests_total
            .with_label_values(&[transport, api, status, error_code])
            .inc();
        self.request_duration_seconds
            .with_label_values(&[transport, api, status])
            .observe(duration_seconds);
    }
}
