use prometheus::{
    register_int_counter_vec_with_registry, register_int_counter_with_registry,
    register_int_gauge_vec_with_registry, register_int_gauge_with_registry, IntCounter,
    IntCounterVec, IntGauge, IntGaugeVec, Registry,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActivityTodaySnapshot {
    pub active_users: i64,
    pub new_users: i64,
    pub active_clients: i64,
    pub new_clients: i64,
    pub client_rebinds: i64,
    pub stale_clients_purged: i64,
    pub legacy_subscriptions_purged: i64,
}

impl ActivityTodaySnapshot {
    pub const fn zero() -> Self {
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

pub struct ClientTrackingMetrics {
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
    app_version_active_clients: IntGaugeVec,
}

impl ClientTrackingMetrics {
    pub fn new(registry: &Registry) -> Self {
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
        let app_version_active_clients = register_int_gauge_vec_with_registry!(
            "app_version_active_clients",
            "Clients active in the last 24 hours by latest persisted app version",
            &["version"],
            registry
        )
        .expect("app_version_active_clients registration should succeed");

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
            app_version_active_clients,
        }
    }

    pub fn record_activity_write(&self, result: &str) {
        self.activity_writes_total
            .with_label_values(&[result])
            .inc();
    }

    pub fn record_activity_write_skipped(&self, reason: &str) {
        self.activity_writes_skipped_total
            .with_label_values(&[reason])
            .inc();
    }

    pub fn record_rebind(&self) {
        self.rebinds_total.inc();
    }

    pub fn record_purge(&self, kind: &str, count: u64) {
        self.purge_total.with_label_values(&[kind]).inc_by(count);
    }

    pub fn record_daily_rollup_update(&self, result: &str) {
        self.daily_rollup_updates_total
            .with_label_values(&[result])
            .inc();
    }

    pub(crate) fn set_app_version_active_clients(
        &self,
        snapshot: &std::collections::HashMap<String, i64>,
    ) {
        self.app_version_active_clients.reset();
        for (version, count) in snapshot {
            self.app_version_active_clients
                .with_label_values(&[version])
                .set(*count);
        }
    }

    pub fn set_activity_today(&self, snapshot: ActivityTodaySnapshot) {
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
    }
}
