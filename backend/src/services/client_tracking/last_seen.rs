use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use chrono::{NaiveDate, NaiveDateTime, Utc};
use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sql_types::{Array, BigInt, Date, Integer, Timestamp};
use diesel::QueryableByName;

use super::{
    ActivityTodaySnapshot, ClientTrackingMetrics, ClientTrackingService, DailyMetricDelta,
};
use crate::state::DbPool;

const MAX_PENDING_OBSERVATIONS: usize = 100_000;
const FLUSH_CHECKOUT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

type LastSeenSnapshot = ((NaiveDate, bool), Vec<(i32, NaiveDateTime)>);

/// Coalesces user last-seen observations before persisting them in bulk.
///
/// The buffer is partitioned by the observation's UTC day so activity crossing
/// midnight advances both daily rollups. Observations remain in the buffer
/// while a database write is running; this keeps reads current and lets the
/// acknowledgement retain an observation that arrived after the snapshot.
pub struct LastSeen {
    db: DbPool,
    metrics: Arc<ClientTrackingMetrics>,
    pending: Mutex<BTreeMap<(NaiveDate, bool), HashMap<i32, NaiveDateTime>>>,
    flush_lock: Mutex<()>,
    in_flight: Mutex<Option<LastSeenSnapshot>>,
}

#[derive(QueryableByName)]
struct ActiveUserCount {
    #[diesel(sql_type = BigInt)]
    active_users: i64,
    #[diesel(sql_type = BigInt)]
    new_users: i64,
}

impl LastSeen {
    pub fn new(db: DbPool, metrics: Arc<ClientTrackingMetrics>) -> Self {
        Self {
            db,
            metrics,
            pending: Mutex::new(BTreeMap::new()),
            flush_lock: Mutex::new(()),
            in_flight: Mutex::new(None),
        }
    }

    /// Records an observation immediately in memory, retaining the newest
    /// timestamp for this user and UTC day.
    pub fn record(&self, uid: i32, at: NaiveDateTime) {
        self.record_observation(uid, at, false);
    }

    /// Records an active-period end without counting it as a new active report.
    pub fn record_end(&self, uid: i32, at: NaiveDateTime) {
        self.record_observation(uid, at, true);
    }

    fn record_observation(&self, uid: i32, at: NaiveDateTime, end: bool) {
        let key = (at.date(), end);
        let mut pending = self.pending.lock().unwrap();
        if !pending.get(&key).is_some_and(|day| day.contains_key(&uid))
            && pending.values().map(HashMap::len).sum::<usize>() >= MAX_PENDING_OBSERVATIONS
        {
            self.metrics.record_activity_dropped();
            return;
        }
        pending
            .entry(key)
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
            .iter()
            .filter(|((_, end), _)| *end)
            .map(|(_, observations)| observations)
            .filter_map(|observations| observations.get(&uid).copied())
            .fold(persisted, |latest, observed| {
                Some(latest.map_or(observed, |known| known.max(observed)))
            })
    }

    pub(super) fn stats(&self) -> (usize, f64) {
        let pending = self.pending.lock().unwrap();
        let now = Utc::now().naive_utc();
        let mut count = 0;
        let mut age: f64 = 0.0;
        for at in pending.values().flat_map(|day| day.values()) {
            count += 1;
            age = age.max((now - *at).num_milliseconds().max(0) as f64 / 1000.0);
        }
        (count, age)
    }

    /// Persists a stable snapshot of pending observations. Successful days are
    /// acknowledged independently, so a failure leaves that day and all later
    /// days available for retry. An uncertain commit may duplicate additive rollups.
    pub fn flush(&self) -> Result<(), String> {
        let _flush_lock = self.flush_lock.lock().unwrap();
        if self.pending.lock().unwrap().is_empty() {
            return Ok(());
        }
        let mut in_flight = self.in_flight.lock().unwrap();

        let mut conn = match self.db.get_timeout(FLUSH_CHECKOUT_TIMEOUT) {
            Ok(conn) => conn,
            Err(error) => {
                self.metrics.record_daily_rollup_update("error");
                return Err(format!(
                    "failed to get last-seen database connection: {error:?}"
                ));
            }
        };
        let flushed_at = Utc::now().naive_utc();
        let started = std::time::Instant::now();

        loop {
            if started.elapsed() >= FLUSH_CHECKOUT_TIMEOUT {
                break;
            }
            if in_flight.is_none() {
                let Some((key, entries)) = self.snapshot().into_iter().next() else {
                    break;
                };
                let mut observations: Vec<_> = entries.into_iter().collect();
                observations.sort_unstable_by_key(|(uid, _)| *uid);
                *in_flight = Some((key, observations));
            }
            let (key, observations) = in_flight.as_ref().unwrap();
            let (day, end) = *key;
            let result = if end {
                Self::flush_ends(&mut conn, observations).map(|()| None)
            } else {
                Self::flush_day(&mut conn, day, observations, flushed_at)
            };
            let today_metrics = match result {
                Ok(today_metrics) => today_metrics,
                Err(error) => {
                    self.metrics.record_daily_rollup_update("error");
                    return Err(format!(
                        "failed to flush last-seen observations for {day}: {error:?}"
                    ));
                }
            };

            self.acknowledge(*key, observations);
            *in_flight = None;
            if let Some(today_metrics) = today_metrics {
                self.metrics.record_daily_rollup_update("success");
                if day == Utc::now().date_naive() {
                    self.metrics.set_activity_today(today_metrics);
                }
            }
        }

        Ok(())
    }

    fn snapshot(&self) -> BTreeMap<(NaiveDate, bool), HashMap<i32, NaiveDateTime>> {
        self.pending
            .lock()
            .unwrap()
            .iter()
            .take(1)
            .map(|(day, entries)| {
                (
                    *day,
                    entries
                        .iter()
                        .take(1000)
                        .map(|(uid, at)| (*uid, *at))
                        .collect(),
                )
            })
            .collect()
    }

    fn acknowledge(&self, day: (NaiveDate, bool), observations: &[(i32, NaiveDateTime)]) {
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

    fn flush_ends(
        conn: &mut PgConnection,
        observations: &[(i32, NaiveDateTime)],
    ) -> QueryResult<()> {
        conn.transaction::<(), diesel::result::Error, _>(|conn| {
            conn.batch_execute(
                "SET LOCAL statement_timeout = '2s'; SET LOCAL lock_timeout = '1s'",
            )?;
            diesel::insert_into(crate::schema::user_extra::table)
                .values(
                    observations
                        .iter()
                        .map(|(uid, at)| crate::models::NewUserExtra {
                            last_seen_at: *at,
                            ..crate::models::NewUserExtra::new(*uid, *at)
                        })
                        .collect::<Vec<_>>(),
                )
                .on_conflict(crate::schema::user_extra::uid)
                .do_update()
                .set(
                    crate::schema::user_extra::last_seen_at.eq(diesel::dsl::sql::<Timestamp>(
                        "GREATEST(user_extra.last_seen_at, EXCLUDED.last_seen_at)",
                    )),
                )
                .execute(conn)?;
            Ok(())
        })
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
            conn.batch_execute(
                "SET LOCAL statement_timeout = '2s'; SET LOCAL lock_timeout = '1s'",
            )?;
            diesel::insert_into(crate::schema::user_extra::table)
                .values(
                    observations
                        .iter()
                        .map(|(uid, at)| crate::models::NewUserExtra::new(*uid, *at))
                        .collect::<Vec<_>>(),
                )
                .on_conflict(crate::schema::user_extra::uid)
                .do_nothing()
                .execute(conn)?;
            // Arrays avoid one round trip per user. The ordered candidates CTE
            // locks user rows by uid before the UPDATE, giving concurrent
            // flushes a consistent lock order.
            let counts = diesel::sql_query(
                "WITH incoming AS (
                     SELECT uid, last_seen_at
                     FROM UNNEST($1::INTEGER[], $2::TIMESTAMP[])
                         AS observations(uid, last_seen_at)
                     ORDER BY uid
                 ), candidates AS MATERIALIZED (
                     SELECT ue.uid, ue.last_active_at AS previous_seen_at,
                            incoming.last_seen_at
                     FROM user_extra AS ue
                     JOIN incoming ON incoming.uid = ue.uid
                     WHERE ue.last_active_at IS NULL OR ue.last_active_at < incoming.last_seen_at
                     ORDER BY ue.uid
                     FOR UPDATE OF ue
                 ), updated AS (
                     UPDATE user_extra AS ue
                     SET last_active_at = candidates.last_seen_at
                     FROM candidates
                     WHERE ue.uid = candidates.uid
                     RETURNING candidates.previous_seen_at
                 )
                 SELECT COUNT(*) FILTER (WHERE previous_seen_at IS NULL OR previous_seen_at::DATE <> $3::DATE)::BIGINT AS active_users,
                        COUNT(*) FILTER (WHERE previous_seen_at IS NULL)::BIGINT AS new_users
                 FROM updated",
            )
            .bind::<Array<Integer>, _>(uids)
            .bind::<Array<Timestamp>, _>(timestamps)
            .bind::<Date, _>(day)
            .get_result::<ActiveUserCount>(conn)?;

            ClientTrackingService::upsert_daily_metrics(
                conn,
                DailyMetricDelta {
                    day,
                    active_users: counts.active_users,
                    new_users: counts.new_users,
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
