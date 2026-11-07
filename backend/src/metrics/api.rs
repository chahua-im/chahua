use axum::http::StatusCode;
use prometheus::{
    register_histogram_vec_with_registry, register_int_counter_vec_with_registry, HistogramTimer,
    HistogramVec, IntCounterVec, Registry,
};

pub struct ApiMetrics {
    requests_total: IntCounterVec,
    request_duration_seconds: HistogramVec,
    stage_duration_seconds: HistogramVec,
}

#[derive(Clone, Copy)]
pub struct ApiStages<'a> {
    metrics: &'a ApiMetrics,
    transport: &'static str,
    api: &'static str,
}

impl ApiStages<'_> {
    pub fn start(&self, stage: &'static str) -> HistogramTimer {
        self.metrics.start_stage(self.transport, self.api, stage)
    }
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
        let stage_duration_seconds = register_histogram_vec_with_registry!(
            "api_stage_duration_seconds",
            "Elapsed time in instrumented API stages, including failed attempts, in seconds",
            &["transport", "api", "stage"],
            vec![
                0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0,
                10.0, 30.0
            ],
            registry
        )
        .expect("api_stage_duration_seconds registration should succeed");
        Self {
            requests_total,
            request_duration_seconds,
            stage_duration_seconds,
        }
    }

    pub fn stages(&self, transport: &'static str, api: &'static str) -> ApiStages<'_> {
        ApiStages {
            metrics: self,
            transport,
            api,
        }
    }

    /// All labels must be fixed instrumentation literals or canonical registered API names.
    /// Dropping the timer records elapsed time, including early error returns.
    pub fn start_stage(
        &self,
        transport: &'static str,
        api: &'static str,
        stage: &'static str,
    ) -> HistogramTimer {
        self.stage_duration_seconds
            .with_label_values(&[transport, api, stage])
            .start_timer()
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
