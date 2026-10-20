use prometheus::{
    register_histogram_vec_with_registry, register_histogram_with_registry, Histogram,
    HistogramVec, Registry,
};

const LATENCY_BUCKETS: &[f64] = &[
    0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0,
];

pub struct PresenceMetrics {
    snapshot_duration_seconds: [Histogram; 2],
    scope_load_duration_seconds: [Histogram; 2],
    group_count_lookup_duration_seconds: Histogram,
    group_count_refresh_duration_seconds: [Histogram; 2],
    group_online_scan_duration_seconds: Histogram,
    group_members_scanned: Histogram,
}

impl PresenceMetrics {
    pub fn new(registry: &Registry) -> Self {
        let snapshot_duration_seconds = register_histogram_vec_with_registry!(
            "presence_snapshot_duration_seconds",
            "Completed presence snapshot latency including authorization and shared count waits",
            &["result"],
            LATENCY_BUCKETS.to_vec(),
            registry
        )
        .expect("presence_snapshot_duration_seconds registration should succeed");
        let scope_load_duration_seconds = register_histogram_vec_with_registry!(
            "presence_scope_load_duration_seconds",
            "Presence authorization and user data load latency including blocking task and pool waits",
            &["result"],
            LATENCY_BUCKETS.to_vec(),
            registry
        )
        .expect("presence_scope_load_duration_seconds registration should succeed");
        let group_count_lookup_duration_seconds = register_histogram_with_registry!(
            "presence_group_count_lookup_duration_seconds",
            "Authorized group count lookup latency including cache hits and coalesced refresh waits",
            LATENCY_BUCKETS.to_vec(),
            registry
        )
        .expect("presence_group_count_lookup_duration_seconds registration should succeed");
        let group_count_refresh_duration_seconds = register_histogram_vec_with_registry!(
            "presence_group_count_refresh_duration_seconds",
            "Actual shared group count refresh latency including blocking task and pool waits",
            &["result"],
            LATENCY_BUCKETS.to_vec(),
            registry
        )
        .expect("presence_group_count_refresh_duration_seconds registration should succeed");
        let group_online_scan_duration_seconds = register_histogram_with_registry!(
            "presence_group_online_scan_duration_seconds",
            "Registry scan time for successfully loaded group membership lists",
            LATENCY_BUCKETS.to_vec(),
            registry
        )
        .expect("presence_group_online_scan_duration_seconds registration should succeed");
        let group_members_scanned = register_histogram_with_registry!(
            "presence_group_members_scanned",
            "Membership UIDs scanned per actual group count refresh, not per viewer",
            vec![1.0, 10.0, 50.0, 100.0, 500.0, 1000.0, 5000.0, 10000.0, 20000.0],
            registry
        )
        .expect("presence_group_members_scanned registration should succeed");
        Self {
            snapshot_duration_seconds: result_histograms(snapshot_duration_seconds),
            scope_load_duration_seconds: result_histograms(scope_load_duration_seconds),
            group_count_lookup_duration_seconds,
            group_count_refresh_duration_seconds: result_histograms(
                group_count_refresh_duration_seconds,
            ),
            group_online_scan_duration_seconds,
            group_members_scanned,
        }
    }

    pub fn record_snapshot(&self, success: bool, duration_seconds: f64) {
        self.snapshot_duration_seconds[usize::from(success)].observe(duration_seconds);
    }

    pub fn record_scope_load(&self, success: bool, duration_seconds: f64) {
        self.scope_load_duration_seconds[usize::from(success)].observe(duration_seconds);
    }

    pub fn record_group_lookup(&self, duration_seconds: f64) {
        self.group_count_lookup_duration_seconds
            .observe(duration_seconds);
    }

    pub fn record_group_refresh(&self, success: bool, duration_seconds: f64) {
        self.group_count_refresh_duration_seconds[usize::from(success)].observe(duration_seconds);
    }

    pub fn record_group_scan(&self, members: usize, duration_seconds: f64) {
        self.group_online_scan_duration_seconds
            .observe(duration_seconds);
        self.group_members_scanned.observe(members as f64);
    }
}

// Bind the two fixed label sets once rather than looking them up on each observation.
fn result_histograms(histogram: HistogramVec) -> [Histogram; 2] {
    ["failure", "success"].map(|result| histogram.with_label_values(&[result]))
}
