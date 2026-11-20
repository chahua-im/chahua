use std::time::Duration;

use prometheus::{
    register_histogram_vec_with_registry, register_int_gauge_with_registry, Histogram, IntGauge,
    Registry,
};

pub struct RpcAdmissionMetrics {
    queue_depth: IntGauge,
    started: Histogram,
    timeout: Histogram,
    cancelled: Histogram,
}

impl RpcAdmissionMetrics {
    pub fn new(registry: &Registry) -> Self {
        let queue_depth = register_int_gauge_with_registry!(
            "rpc_admission_queue_depth",
            "Read and mutation calls waiting for RPC execution capacity",
            registry
        )
        .expect("rpc_admission_queue_depth registration should succeed");
        let wait = register_histogram_vec_with_registry!(
            "rpc_admission_wait_duration_seconds",
            "Time queued for RPC execution capacity, excluding execution time",
            &["outcome"],
            vec![0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0],
            registry
        )
        .expect("rpc_admission_wait_duration_seconds registration should succeed");
        Self {
            queue_depth,
            started: wait.with_label_values(&["started"]),
            timeout: wait.with_label_values(&["timeout"]),
            cancelled: wait.with_label_values(&["cancelled"]),
        }
    }

    pub(crate) fn queued(&self) {
        self.queue_depth.inc();
    }

    pub(crate) fn dequeued(&self, elapsed: Duration, outcome: &'static str) {
        self.queue_depth.dec();
        let wait = match outcome {
            "started" => &self.started,
            "timeout" => &self.timeout,
            "cancelled" => &self.cancelled,
            _ => unreachable!("fixed RPC admission outcome"),
        };
        wait.observe(elapsed.as_secs_f64());
    }
}
