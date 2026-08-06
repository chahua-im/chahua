use dashmap::{DashMap, DashSet};
use prometheus::{
    register_int_counter_vec_with_registry, register_int_counter_with_registry,
    register_int_gauge_vec_with_registry, register_int_gauge_with_registry, IntCounter,
    IntCounterVec, IntGauge, IntGaugeVec, Registry,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ActivityTodaySnapshot {
    pub(crate) active_users: i64,
    pub(crate) new_users: i64,
    pub(crate) active_clients: i64,
    pub(crate) new_clients: i64,
    pub(crate) client_rebinds: i64,
    pub(crate) stale_clients_purged: i64,
    pub(crate) legacy_subscriptions_purged: i64,
}

impl ActivityTodaySnapshot {
    pub(crate) const fn zero() -> Self {
        Self {
            active_users: 0,
            new_users: 0,
            active_clients: 0,
            new_clients: 0,
            client_rebinds: 0,
            stale_clients_purged: 0,
            legacy_subscriptions_purged: 0,
        }
    }
}

pub(crate) struct ClientTrackingMetrics {
    activity_writes_total: IntCounterVec,
    activity_writes_skipped_total: IntCounterVec,
    rebinds_total: IntCounter,
    purge_total: IntCounterVec,
    daily_rollup_updates_total: IntCounterVec,
    today_active_users: IntGauge,
    today_new_users: IntGauge,
    today_active_clients: IntGauge,
    today_new_clients: IntGauge,
    today_client_rebinds: IntGauge,
    today_stale_clients_purged: IntGauge,
    today_legacy_subscriptions_purged: IntGauge,
    app_version_requests_total: IntCounterVec,
    app_version_unique_clients: IntGaugeVec,
    app_version_clients: DashMap<String, DashSet<String>>,
}

impl ClientTrackingMetrics {
    pub(crate) fn new(registry: &Registry) -> Self {
        let activity_writes_total = register_int_counter_vec_with_registry!(
            "client_activity_writes_total",
            "Total number of client activity writes attempted",
            &["result"],
            registry
        )
        .expect("client_activity_writes_total registration should succeed");
        let activity_writes_skipped_total = register_int_counter_vec_with_registry!(
            "client_activity_writes_skipped_total",
            "Total number of client activity writes skipped",
            &["reason"],
            registry
        )
        .expect("client_activity_writes_skipped_total registration should succeed");
        let rebinds_total = register_int_counter_with_registry!(
            "client_rebinds_total",
            "Total number of times a client was rebound to a different user",
            registry
        )
        .expect("client_rebinds_total registration should succeed");
        let purge_total = register_int_counter_vec_with_registry!(
            "client_tracking_purge_total",
            "Total number of client tracking records purged",
            &["kind"],
            registry
        )
        .expect("client_tracking_purge_total registration should succeed");
        let daily_rollup_updates_total = register_int_counter_vec_with_registry!(
            "activity_daily_rollup_updates_total",
            "Total number of daily activity rollup updates",
            &["result"],
            registry
        )
        .expect("activity_daily_rollup_updates_total registration should succeed");
        let today_active_users = register_int_gauge_with_registry!(
            "activity_today_active_users",
            "Today's exact active user count mirrored from the daily activity rollup",
            registry
        )
        .expect("activity_today_active_users registration should succeed");
        let today_new_users = register_int_gauge_with_registry!(
            "activity_today_new_users",
            "Today's exact new user count mirrored from the daily activity rollup",
            registry
        )
        .expect("activity_today_new_users registration should succeed");
        let today_active_clients = register_int_gauge_with_registry!(
            "activity_today_active_clients",
            "Today's exact active client count mirrored from the daily activity rollup",
            registry
        )
        .expect("activity_today_active_clients registration should succeed");
        let today_new_clients = register_int_gauge_with_registry!(
            "activity_today_new_clients",
            "Today's exact new client count mirrored from the daily activity rollup",
            registry
        )
        .expect("activity_today_new_clients registration should succeed");
        let today_client_rebinds = register_int_gauge_with_registry!(
            "activity_today_client_rebinds",
            "Today's exact client rebind count mirrored from the daily activity rollup",
            registry
        )
        .expect("activity_today_client_rebinds registration should succeed");
        let today_stale_clients_purged = register_int_gauge_with_registry!(
            "activity_today_stale_clients_purged",
            "Today's exact stale client purge count mirrored from the daily activity rollup",
            registry
        )
        .expect("activity_today_stale_clients_purged registration should succeed");
        let today_legacy_subscriptions_purged = register_int_gauge_with_registry!(
            "activity_today_legacy_subscriptions_purged",
            "Today's exact legacy subscription purge count mirrored from the daily activity rollup",
            registry
        )
        .expect("activity_today_legacy_subscriptions_purged registration should succeed");
        let app_version_requests_total = register_int_counter_vec_with_registry!(
            "app_version_requests_total",
            "Total number of HTTP requests by app version",
            &["version"],
            registry
        )
        .expect("app_version_requests_total registration should succeed");
        let app_version_unique_clients = register_int_gauge_vec_with_registry!(
            "app_version_unique_clients",
            "Number of unique client IDs observed per app version",
            &["version"],
            registry
        )
        .expect("app_version_unique_clients registration should succeed");

        Self {
            activity_writes_total,
            activity_writes_skipped_total,
            rebinds_total,
            purge_total,
            daily_rollup_updates_total,
            today_active_users,
            today_new_users,
            today_active_clients,
            today_new_clients,
            today_client_rebinds,
            today_stale_clients_purged,
            today_legacy_subscriptions_purged,
            app_version_requests_total,
            app_version_unique_clients,
            app_version_clients: DashMap::new(),
        }
    }

    pub(crate) fn record_activity_write(&self, result: &str) {
        self.activity_writes_total
            .with_label_values(&[result])
            .inc();
    }

    pub(crate) fn record_activity_write_skipped(&self, reason: &str) {
        self.activity_writes_skipped_total
            .with_label_values(&[reason])
            .inc();
    }

    pub(crate) fn record_rebind(&self) {
        self.rebinds_total.inc();
    }

    pub(crate) fn record_purge(&self, kind: &str, count: u64) {
        self.purge_total.with_label_values(&[kind]).inc_by(count);
    }

    pub(crate) fn record_daily_rollup_update(&self, result: &str) {
        self.daily_rollup_updates_total
            .with_label_values(&[result])
            .inc();
    }

    pub(crate) fn record_app_version_request(&self, version: &str, client_id: Option<&str>) {
        self.app_version_requests_total
            .with_label_values(&[version])
            .inc();
        if let Some(cid) = client_id {
            let set = self
                .app_version_clients
                .entry(version.to_owned())
                .or_default();
            if set.insert(cid.to_owned()) {
                self.app_version_unique_clients
                    .with_label_values(&[version])
                    .set(set.len() as i64);
            }
        }
    }

    pub(crate) fn set_activity_today(&self, snapshot: ActivityTodaySnapshot) {
        self.today_active_users.set(snapshot.active_users);
        self.today_new_users.set(snapshot.new_users);
        self.today_active_clients.set(snapshot.active_clients);
        self.today_new_clients.set(snapshot.new_clients);
        self.today_client_rebinds.set(snapshot.client_rebinds);
        self.today_stale_clients_purged
            .set(snapshot.stale_clients_purged);
        self.today_legacy_subscriptions_purged
            .set(snapshot.legacy_subscriptions_purged);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_tracking_metrics_render_expected_values() {
        let registry = Registry::new();
        let metrics = ClientTrackingMetrics::new(&registry);
        metrics.record_activity_write("success");
        metrics.record_activity_write_skipped("throttled");
        metrics.record_rebind();
        metrics.record_purge("legacy_subscriptions", 3);
        metrics.record_daily_rollup_update("success");
        metrics.set_activity_today(ActivityTodaySnapshot {
            active_users: 5,
            new_users: 2,
            active_clients: 6,
            new_clients: 3,
            client_rebinds: 1,
            stale_clients_purged: 0,
            legacy_subscriptions_purged: 0,
        });
        metrics.record_app_version_request("v1.0", Some("c1"));
        metrics.record_app_version_request("v1.0", Some("c2"));
        metrics.record_app_version_request("v2.0", None);

        let rendered = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(rendered.contains("client_activity_writes_total{result=\"success\"} 1"));
        assert!(rendered.contains("client_activity_writes_skipped_total{reason=\"throttled\"} 1"));
        assert!(rendered.contains("client_rebinds_total 1"));
        assert!(rendered.contains("client_tracking_purge_total{kind=\"legacy_subscriptions\"} 3"));
        assert!(rendered.contains("activity_daily_rollup_updates_total{result=\"success\"} 1"));
        assert!(rendered.contains("activity_today_active_users 5"));
        assert!(rendered.contains("activity_today_new_users 2"));
        assert!(rendered.contains("activity_today_active_clients 6"));
        assert!(rendered.contains("activity_today_new_clients 3"));
        assert!(rendered.contains("activity_today_client_rebinds 1"));
        assert!(rendered.contains("app_version_requests_total{version=\"v1.0\"} 2"));
        assert!(rendered.contains("app_version_requests_total{version=\"v2.0\"} 1"));
        assert!(rendered.contains("app_version_unique_clients{version=\"v1.0\"} 2"));
    }

    #[test]
    fn app_version_tracks_unique_clients_per_version() {
        let registry = Registry::new();
        let metrics = ClientTrackingMetrics::new(&registry);

        // Two requests from same client on same version — unique count stays 1
        metrics.record_app_version_request("abc1234", Some("client-a"));
        metrics.record_app_version_request("abc1234", Some("client-a"));
        let rendered = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(rendered.contains("app_version_requests_total{version=\"abc1234\"} 2"));
        assert!(rendered.contains("app_version_unique_clients{version=\"abc1234\"} 1"));

        // Different client on same version — unique count becomes 2
        metrics.record_app_version_request("abc1234", Some("client-b"));
        let rendered = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(rendered.contains("app_version_requests_total{version=\"abc1234\"} 3"));
        assert!(rendered.contains("app_version_unique_clients{version=\"abc1234\"} 2"));

        // Request without client_id — request counter increments, unique count unchanged
        metrics.record_app_version_request("abc1234", None);
        let rendered = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(rendered.contains("app_version_requests_total{version=\"abc1234\"} 4"));
        assert!(rendered.contains("app_version_unique_clients{version=\"abc1234\"} 2"));
    }
}
