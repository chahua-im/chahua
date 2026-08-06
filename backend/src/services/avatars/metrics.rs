use prometheus::{
    register_histogram_with_registry, register_int_counter_with_registry, Histogram, IntCounter,
    Registry,
};

pub(crate) struct AvatarMetrics {
    lookup_duration_seconds: Histogram,
    lookup_fs_duration_seconds: Histogram,
    lookup_users_total: IntCounter,
}

impl AvatarMetrics {
    pub(crate) fn new(registry: &Registry) -> Self {
        let lookup_duration_seconds = register_histogram_with_registry!(
            "discuz_avatar_lookup_duration_seconds",
            "Discuz avatar lookup latency in seconds",
            vec![0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
            registry
        )
        .expect("discuz_avatar_lookup_duration_seconds registration should succeed");
        let lookup_fs_duration_seconds = register_histogram_with_registry!(
            "discuz_avatar_lookup_fs_duration_seconds",
            "Filesystem portion of Discuz avatar lookup latency in seconds",
            vec![0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
            registry
        )
        .expect("discuz_avatar_lookup_fs_duration_seconds registration should succeed");
        let lookup_users_total = register_int_counter_with_registry!(
            "discuz_avatar_lookup_users_total",
            "Total number of requested users processed by Discuz avatar lookups",
            registry
        )
        .expect("discuz_avatar_lookup_users_total registration should succeed");

        Self {
            lookup_duration_seconds,
            lookup_fs_duration_seconds,
            lookup_users_total,
        }
    }

    pub(crate) fn record_lookup(
        &self,
        requested_users: usize,
        duration_seconds: f64,
        fs_duration_seconds: f64,
    ) {
        self.lookup_duration_seconds.observe(duration_seconds);
        self.lookup_fs_duration_seconds.observe(fs_duration_seconds);
        self.lookup_users_total.inc_by(requested_users as u64);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn avatar_metrics_render_expected_values() {
        let registry = Registry::new();
        let metrics = AvatarMetrics::new(&registry);
        metrics.record_lookup(3, 0.015, 0.006);

        let rendered = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(rendered.contains("discuz_avatar_lookup_duration_seconds_sum"));
        assert!(rendered.contains("discuz_avatar_lookup_fs_duration_seconds_sum"));
        assert!(rendered.contains("discuz_avatar_lookup_users_total 3"));
    }
}
