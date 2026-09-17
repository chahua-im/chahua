use std::sync::Arc;

use chrono::{NaiveDate, NaiveDateTime, Utc};
use diesel::prelude::*;

use crate::models::{ActivityDailyMetric, NewActivityDailyMetric};
use crate::schema::activity_daily_metrics;
use crate::services::client_tracking::{ActivityTodaySnapshot, ClientTrackingMetrics};
use crate::state::DbPool;

#[derive(Clone, Copy)]
pub struct DailyMetricDelta {
    pub day: NaiveDate,
    pub active_users: i64,
    pub new_users: i64,
    pub active_clients: i64,
    pub new_clients: i64,
    pub client_rebinds: i64,
    pub stale_clients_purged: i64,
    pub legacy_subscriptions_purged: i64,
}

impl DailyMetricDelta {
    pub const fn is_zero(self) -> bool {
        self.active_users == 0
            && self.new_users == 0
            && self.active_clients == 0
            && self.new_clients == 0
            && self.client_rebinds == 0
            && self.stale_clients_purged == 0
            && self.legacy_subscriptions_purged == 0
    }

    fn as_activity_today_snapshot(self) -> ActivityTodaySnapshot {
        ActivityTodaySnapshot {
            active_users: self.active_users,
            new_users: self.new_users,
            active_clients: self.active_clients,
            new_clients: self.new_clients,
            client_rebinds: self.client_rebinds,
            stale_clients_purged: self.stale_clients_purged,
            legacy_subscriptions_purged: self.legacy_subscriptions_purged,
        }
    }
}

pub struct ActivityMetricsService {
    metrics: Arc<ClientTrackingMetrics>,
}

impl ActivityMetricsService {
    pub fn new(metrics: Arc<ClientTrackingMetrics>) -> Self {
        Self { metrics }
    }

    pub fn refresh_today_gauges(&self, db: &DbPool) -> Result<(), String> {
        let today = Utc::now().date_naive();
        let conn = &mut db
            .get()
            .map_err(|e| format!("failed to get DB connection: {e:?}"))?;
        let row = activity_daily_metrics::table
            .find(today)
            .select(ActivityDailyMetric::as_select())
            .first::<ActivityDailyMetric>(conn)
            .optional()
            .map_err(|e| format!("failed to load today's activity metrics: {e:?}"))?;

        self.metrics
            .set_activity_today(row.map_or_else(ActivityTodaySnapshot::zero, |metrics| {
                DailyMetricDelta {
                    day: metrics.day,
                    active_users: metrics.active_users,
                    new_users: metrics.new_users,
                    active_clients: metrics.active_clients,
                    new_clients: metrics.new_clients,
                    client_rebinds: metrics.client_rebinds,
                    stale_clients_purged: metrics.stale_clients_purged,
                    legacy_subscriptions_purged: metrics.legacy_subscriptions_purged,
                }
                .as_activity_today_snapshot()
            }));
        Ok(())
    }

    pub fn upsert(
        &self,
        conn: &mut PgConnection,
        delta: DailyMetricDelta,
        now: NaiveDateTime,
    ) -> QueryResult<()> {
        if delta.is_zero() {
            return Ok(());
        }

        let row = NewActivityDailyMetric {
            day: delta.day,
            active_users: delta.active_users,
            new_users: delta.new_users,
            active_clients: delta.active_clients,
            new_clients: delta.new_clients,
            client_rebinds: delta.client_rebinds,
            stale_clients_purged: delta.stale_clients_purged,
            legacy_subscriptions_purged: delta.legacy_subscriptions_purged,
            updated_at: now,
        };
        diesel::insert_into(activity_daily_metrics::table)
            .values(&row)
            .on_conflict(activity_daily_metrics::day)
            .do_update()
            .set((
                activity_daily_metrics::active_users
                    .eq(activity_daily_metrics::active_users + delta.active_users),
                activity_daily_metrics::new_users
                    .eq(activity_daily_metrics::new_users + delta.new_users),
                activity_daily_metrics::active_clients
                    .eq(activity_daily_metrics::active_clients + delta.active_clients),
                activity_daily_metrics::new_clients
                    .eq(activity_daily_metrics::new_clients + delta.new_clients),
                activity_daily_metrics::client_rebinds
                    .eq(activity_daily_metrics::client_rebinds + delta.client_rebinds),
                activity_daily_metrics::stale_clients_purged
                    .eq(activity_daily_metrics::stale_clients_purged + delta.stale_clients_purged),
                activity_daily_metrics::legacy_subscriptions_purged
                    .eq(activity_daily_metrics::legacy_subscriptions_purged
                        + delta.legacy_subscriptions_purged),
                activity_daily_metrics::updated_at.eq(now),
            ))
            .execute(conn)?;

        if delta.day == Utc::now().date_naive() {
            let current = activity_daily_metrics::table
                .find(delta.day)
                .select(ActivityDailyMetric::as_select())
                .first::<ActivityDailyMetric>(conn)?;
            self.metrics.set_activity_today(
                DailyMetricDelta {
                    day: current.day,
                    active_users: current.active_users,
                    new_users: current.new_users,
                    active_clients: current.active_clients,
                    new_clients: current.new_clients,
                    client_rebinds: current.client_rebinds,
                    stale_clients_purged: current.stale_clients_purged,
                    legacy_subscriptions_purged: current.legacy_subscriptions_purged,
                }
                .as_activity_today_snapshot(),
            );
        }
        self.metrics.record_daily_rollup_update("success");
        if delta.client_rebinds > 0 {
            self.metrics.record_rebind();
        }
        Ok(())
    }
}
