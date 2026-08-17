use prometheus::{
    register_histogram_vec_with_registry, register_int_counter_vec_with_registry, HistogramVec,
    IntCounterVec, Registry,
};

pub struct BackgroundMetrics {
    jobs_total: IntCounterVec,
    job_duration_seconds: HistogramVec,
}

impl BackgroundMetrics {
    pub fn new(registry: &Registry) -> Self {
        let jobs_total = register_int_counter_vec_with_registry!(
            "background_jobs_total",
            "Total number of background jobs processed",
            &["job_kind", "result"],
            registry
        )
        .expect("background_jobs_total registration should succeed");
        let job_duration_seconds = register_histogram_vec_with_registry!(
            "background_job_duration_seconds",
            "Background job runtime in seconds",
            &["job_kind", "result"],
            vec![0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0],
            registry
        )
        .expect("background_job_duration_seconds registration should succeed");
        jobs_total.with_label_values(&["bulk_delete_messages", "success"]);
        jobs_total.with_label_values(&["bulk_delete_messages", "failure"]);
        job_duration_seconds.with_label_values(&["bulk_delete_messages", "success"]);
        job_duration_seconds.with_label_values(&["bulk_delete_messages", "failure"]);

        Self {
            jobs_total,
            job_duration_seconds,
        }
    }

    pub fn record_job(&self, job_kind: &str, result: &str, duration_seconds: f64) {
        self.jobs_total.with_label_values(&[job_kind, result]).inc();
        self.job_duration_seconds
            .with_label_values(&[job_kind, result])
            .observe(duration_seconds);
    }
}
