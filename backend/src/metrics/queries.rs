use diesel::connection::{get_default_instrumentation, Instrumentation, InstrumentationEvent};
use diesel::r2d2::CustomizeConnection;
use diesel::{Connection, PgConnection};
use prometheus::{
    register_histogram_vec_with_registry, register_histogram_with_registry, Histogram, Registry,
};
use std::sync::Arc;
use std::time::Instant;

/// Operation-level query timings. Labels are fixed outcomes, never query data.
pub struct QueryMetrics {
    profile_lookup_duration_seconds: [Histogram; 2],
    profile_lookup_batch_size: Histogram,
    app_version_aggregation_duration_seconds: [Histogram; 2],
}

impl QueryMetrics {
    pub fn new(registry: &Registry) -> Self {
        let buckets = vec![
            0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
            30.0,
        ];
        let profile_duration = register_histogram_vec_with_registry!(
            "profile_lookup_duration_seconds",
            "Elapsed profile lookup time in seconds, including failed and empty lookups",
            &["outcome"],
            buckets.clone(),
            registry
        )
        .expect("profile lookup duration registration should succeed");
        let version_duration = register_histogram_vec_with_registry!(
            "app_version_aggregation_duration_seconds",
            "Elapsed active app-version aggregation time in seconds, including failed attempts",
            &["outcome"],
            buckets,
            registry
        )
        .expect("app version aggregation duration registration should succeed");
        Self {
            profile_lookup_duration_seconds: [
                profile_duration.with_label_values(&["error"]),
                profile_duration.with_label_values(&["success"]),
            ],
            profile_lookup_batch_size: register_histogram_with_registry!(
                "profile_lookup_batch_size",
                "Number of requested user IDs per profile lookup, including empty batches and duplicates",
                vec![0.0, 1.0, 2.0, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1000.0, 5000.0],
                registry
            ).expect("profile lookup batch size registration should succeed"),
            app_version_aggregation_duration_seconds: [
                version_duration.with_label_values(&["error"]),
                version_duration.with_label_values(&["success"]),
            ],
        }
    }

    pub fn record_profile_lookup(&self, batch_size: usize, start: Instant, success: bool) {
        let elapsed = start.elapsed().as_secs_f64();
        self.profile_lookup_batch_size.observe(batch_size as f64);
        self.profile_lookup_duration_seconds[usize::from(success)].observe(elapsed);
    }

    pub fn record_app_version_aggregation(&self, start: Instant, success: bool) {
        let elapsed = start.elapsed().as_secs_f64();
        self.app_version_aggregation_duration_seconds[usize::from(success)].observe(elapsed);
    }
}

/// Per-connection context, forwarding Diesel events to the configured tracer.
struct QueryInstrumentation {
    metrics: Arc<QueryMetrics>,
    inner: Option<Box<dyn Instrumentation>>,
}

impl Instrumentation for QueryInstrumentation {
    fn on_connection_event(&mut self, event: InstrumentationEvent<'_>) {
        if let Some(inner) = self.inner.as_mut() {
            inner.on_connection_event(event);
        }
    }
}

/// Attach to a fresh connection, preserving the configured default instrumentation.
pub fn attach_connection_metrics(conn: &mut PgConnection, metrics: Arc<QueryMetrics>) {
    conn.set_instrumentation(QueryInstrumentation {
        metrics,
        inner: get_default_instrumentation(),
    });
}

pub(crate) fn connection_metrics(conn: &mut PgConnection) -> Option<Arc<QueryMetrics>> {
    conn.instrumentation()
        .downcast_ref::<QueryInstrumentation>()
        .map(|instrumentation| Arc::clone(&instrumentation.metrics))
}

pub struct QueryConnectionCustomizer {
    metrics: Arc<QueryMetrics>,
}

impl QueryConnectionCustomizer {
    pub fn new(metrics: Arc<QueryMetrics>) -> Self {
        Self { metrics }
    }
}

impl std::fmt::Debug for QueryConnectionCustomizer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QueryConnectionCustomizer")
            .finish_non_exhaustive()
    }
}

impl CustomizeConnection<PgConnection, diesel::r2d2::Error> for QueryConnectionCustomizer {
    fn on_acquire(&self, conn: &mut PgConnection) -> Result<(), diesel::r2d2::Error> {
        attach_connection_metrics(conn, Arc::clone(&self.metrics));
        Ok(())
    }
}
