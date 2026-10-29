use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use chrono::{NaiveDate, NaiveDateTime, Utc};
use diesel::prelude::*;
use diesel::sql_types::{Array, BigInt, Date, Integer, Timestamp};
use diesel::QueryableByName;

use super::{
    ActivityTodaySnapshot, ClientTrackingMetrics, ClientTrackingService, DailyMetricDelta,
};
use crate::state::DbPool;

/// Coalesces user last-seen observations before persisting them in bulk.
///
/// The buffer is partitioned by the observation's UTC day so activity crossing
/// midnight advances both daily rollups. Observations remain in the buffer
/// while a database write is running; this keeps reads current and lets the
/// acknowledgement retain an observation that arrived after the snapshot.
pub struct LastSeen {
    db: DbPool,
    metrics: Arc<ClientTrackingMetrics>,
    pending: Mutex<BTreeMap<NaiveDate, HashMap<i32, NaiveDateTime>>>,
    flush_lock: Mutex<()>,
}

#[derive(QueryableByName)]
struct ActiveUserCount {
    #[diesel(sql_type = BigInt)]
    active_users: i64,
}

impl LastSeen {
    pub fn new(db: DbPool, metrics: Arc<ClientTrackingMetrics>) -> Self {
        Self {
            db,
            metrics,
            pending: Mutex::new(BTreeMap::new()),
            flush_lock: Mutex::new(()),
        }
    }

    /// Records an observation immediately in memory, retaining the newest
    /// timestamp for this user and UTC day.
    pub fn record(&self, uid: i32, at: NaiveDateTime) {
        let mut pending = self.pending.lock().unwrap();
        pending
            .entry(at.date())
            .or_default()
            .entry(uid)
            .and_modify(|known| *known = (*known).max(at))
            .or_insert(at);
    }

    /// Returns the newest timestamp visible to this process or already read
    /// from storage. Pending observations are deliberately retained while a
    /// flush is in flight, so this is safe to use for presence snapshots.
    pub fn latest(&self, uid: i32, persisted: Option<NaiveDateTime>) -> Option<NaiveDateTime> {
        let pending = self.pending.lock().unwrap();
        pending
            .values()
            .filter_map(|observations| observations.get(&uid).copied())
            .fold(persisted, |latest, observed| {
                Some(latest.map_or(observed, |known| known.max(observed)))
            })
    }

    /// Persists a stable snapshot of pending observations. Successful days are
    /// acknowledged independently, so a failure leaves that day and all later
    /// days available for retry without duplicating already committed rollups.
    pub fn flush(&self) -> Result<(), String> {
        let _flush_lock = self.flush_lock.lock().unwrap();
        let snapshot = self.snapshot();
        if snapshot.is_empty() {
            return Ok(());
        }

        let mut conn = match self.db.get() {
            Ok(conn) => conn,
            Err(error) => {
                self.metrics.record_daily_rollup_update("error");
                return Err(format!(
                    "failed to get last-seen database connection: {error:?}"
                ));
            }
        };
        let flushed_at = Utc::now().naive_utc();

        for (day, observations) in snapshot {
            let mut observations: Vec<_> = observations.into_iter().collect();
            observations.sort_unstable_by_key(|(uid, _)| *uid);

            let today_metrics = match Self::flush_day(&mut conn, day, &observations, flushed_at) {
                Ok(today_metrics) => today_metrics,
                Err(error) => {
                    self.metrics.record_daily_rollup_update("error");
                    return Err(format!(
                        "failed to flush last-seen observations for {day}: {error:?}"
                    ));
                }
            };

            self.acknowledge(day, &observations);
            if let Some(today_metrics) = today_metrics {
                self.metrics.record_daily_rollup_update("success");
                if day == Utc::now().date_naive() {
                    self.metrics.set_activity_today(today_metrics);
                }
            }
        }

        Ok(())
    }

    fn snapshot(&self) -> BTreeMap<NaiveDate, HashMap<i32, NaiveDateTime>> {
        self.pending.lock().unwrap().clone()
    }

    fn acknowledge(&self, day: NaiveDate, observations: &[(i32, NaiveDateTime)]) {
        let mut pending = self.pending.lock().unwrap();
        let mut empty = false;

        if let Some(current_day) = pending.get_mut(&day) {
            for (uid, persisted_at) in observations {
                if current_day
                    .get(uid)
                    .is_some_and(|current| *current <= *persisted_at)
                {
                    current_day.remove(uid);
                }
            }
            empty = current_day.is_empty();
        }

        if empty {
            pending.remove(&day);
        }
    }

    fn flush_day(
        conn: &mut PgConnection,
        day: NaiveDate,
        observations: &[(i32, NaiveDateTime)],
        flushed_at: NaiveDateTime,
    ) -> QueryResult<Option<ActivityTodaySnapshot>> {
        let uids: Vec<i32> = observations.iter().map(|(uid, _)| *uid).collect();
        let timestamps: Vec<NaiveDateTime> = observations.iter().map(|(_, at)| *at).collect();

        conn.transaction::<Option<ActivityTodaySnapshot>, diesel::result::Error, _>(|conn| {
            // Arrays avoid one round trip per user. The ordered candidates CTE
            // locks user rows by uid before the UPDATE, giving concurrent
            // flushes a consistent lock order.
            let active_users = diesel::sql_query(
                "WITH incoming AS (
                     SELECT uid, last_seen_at
                     FROM UNNEST($1::INTEGER[], $2::TIMESTAMP[])
                         AS observations(uid, last_seen_at)
                     ORDER BY uid
                 ), candidates AS MATERIALIZED (
                     SELECT ue.uid, ue.last_seen_at AS previous_seen_at,
                            incoming.last_seen_at
                     FROM user_extra AS ue
                     JOIN incoming ON incoming.uid = ue.uid
                     WHERE ue.last_seen_at < incoming.last_seen_at
                     ORDER BY ue.uid
                     FOR UPDATE OF ue
                 ), updated AS (
                     UPDATE user_extra AS ue
                     SET last_seen_at = GREATEST(ue.last_seen_at, candidates.last_seen_at)
                     FROM candidates
                     WHERE ue.uid = candidates.uid
                     RETURNING candidates.previous_seen_at
                 )
                 SELECT COUNT(*)::BIGINT AS active_users
                 FROM updated
                 WHERE previous_seen_at::DATE <> $3::DATE",
            )
            .bind::<Array<Integer>, _>(uids)
            .bind::<Array<Timestamp>, _>(timestamps)
            .bind::<Date, _>(day)
            .get_result::<ActiveUserCount>(conn)?
            .active_users;

            ClientTrackingService::upsert_daily_metrics(
                conn,
                DailyMetricDelta {
                    day,
                    active_users,
                    new_users: 0,
                    active_clients: 0,
                    new_clients: 0,
                    client_rebinds: 0,
                    stale_clients_purged: 0,
                    legacy_subscriptions_purged: 0,
                },
                flushed_at,
            )
        })
    }
}

#[cfg(test)]
mod tests;
