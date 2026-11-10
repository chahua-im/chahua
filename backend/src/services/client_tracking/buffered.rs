use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{Duration, Instant};

use chrono::{NaiveDate, NaiveDateTime, Utc};
use diesel::connection::SimpleConnection;
use diesel::prelude::*;

use super::{clients, BindingChange, ClientTrackingService, DailyMetricDelta};

const MAX_PENDING: usize = 100_000;

#[derive(Clone)]
pub(super) struct Observation {
    pub uid: i32,
    pub at: NaiveDateTime,
    pub version: Option<String>,
    pub new_clients: i64,
    pub new_users: i64,
    pub rebinds: i64,
    pub sequence: u64,
    pub queued: Instant,
}

#[derive(Default)]
pub(super) struct Pending {
    entries: BTreeMap<(NaiveDate, String), Observation>,
    sequence: u64,
    in_flight: HashMap<(NaiveDate, String), Observation>,
    cursor: Option<(NaiveDate, String)>,
}

impl Pending {
    pub fn record(
        &mut self,
        client: &str,
        uid: i32,
        at: NaiveDateTime,
        version: Option<&str>,
        binding: BindingChange,
    ) -> bool {
        let key = (at.date(), client.to_owned());
        if !self.entries.contains_key(&key) && self.entries.len() >= MAX_PENDING {
            return false;
        }
        self.sequence += 1;
        let sequence = self.sequence;
        let entry = self.entries.entry(key).or_insert_with(|| Observation {
            uid,
            at,
            version: None,
            new_clients: 0,
            new_users: 0,
            rebinds: 0,
            sequence,
            queued: Instant::now(),
        });
        entry.uid = uid;
        entry.at = entry.at.max(at);
        if let Some(version) = version {
            entry.version = Some(version.to_owned());
        }
        entry.new_clients += i64::from(binding.new_client);
        entry.new_users += i64::from(binding.new_user);
        entry.rebinds += i64::from(binding.rebound);
        entry.sequence = sequence;
        true
    }

    fn snapshot(&mut self) -> Vec<((NaiveDate, String), Observation)> {
        let mut clients = HashSet::new();
        let mut eligible = Vec::new();
        for key in self.entries.keys() {
            if clients.insert(key.1.as_str()) {
                eligible.push(key);
            }
        }
        let start = self
            .cursor
            .as_ref()
            .and_then(|cursor| eligible.iter().position(|key| *key > cursor))
            .unwrap_or(0);
        let mut result = Vec::new();
        for &key in eligible
            .iter()
            .cycle()
            .skip(start)
            .take(eligible.len().min(256))
        {
            let observation = &self.entries[key];
            let entry = self
                .in_flight
                .entry(key.clone())
                .or_insert_with(|| observation.clone());
            result.push((key.clone(), entry.clone()));
        }
        result
    }

    fn acknowledge(&mut self, key: &(NaiveDate, String), snapshot: &Observation) {
        if let Some(current) = self.entries.get_mut(key) {
            if current.sequence == snapshot.sequence {
                self.entries.remove(key);
            } else {
                current.new_clients -= snapshot.new_clients;
                current.new_users -= snapshot.new_users;
                current.rebinds -= snapshot.rebinds;
            }
        }
        self.in_flight.remove(key);
    }

    pub fn stats(&self) -> (usize, f64) {
        (
            self.entries.len(),
            self.entries
                .values()
                .map(|entry| entry.queued.elapsed().as_secs_f64())
                .fold(0.0, f64::max),
        )
    }
}

impl ClientTrackingService {
    pub(super) fn flush_clients(&self) -> Result<bool, String> {
        let snapshot = self.pending.lock().unwrap().snapshot();
        if snapshot.is_empty() {
            return Ok(false);
        }
        let mut conn = self
            .db
            .get_timeout(Duration::from_secs(2))
            .map_err(|error| error.to_string())?;
        let started = Instant::now();
        let mut failure = None;
        for (key, observation) in snapshot {
            if started.elapsed() >= Duration::from_secs(2) {
                break;
            }
            self.pending.lock().unwrap().cursor = Some(key.clone());
            let (day, ref client_id) = key;
            let result = conn.transaction::<_, diesel::result::Error, _>(|conn| {
                conn.batch_execute(
                    "SET LOCAL statement_timeout = '2s'; SET LOCAL lock_timeout = '1s'",
                )?;
                let existing = clients::table
                    .find(client_id)
                    .for_update()
                    .select((clients::last_active, clients::last_active_uid))
                    .first::<(NaiveDateTime, i32)>(conn)
                    .optional()?;
                let active = existing
                    .as_ref()
                    .map_or(0, |(at, _)| i64::from(at.date() < day));
                if let Some((last_active, owner)) = existing {
                    let at = last_active.max(observation.at);
                    if let Some(version) = observation
                        .version
                        .as_deref()
                        .filter(|_| owner == observation.uid)
                    {
                        diesel::update(clients::table.find(client_id))
                            .set((
                                clients::last_active.eq(at),
                                clients::last_app_version.eq(version),
                            ))
                            .execute(conn)?;
                    } else if at > last_active {
                        diesel::update(clients::table.find(client_id))
                            .set(clients::last_active.eq(at))
                            .execute(conn)?;
                    }
                }
                Self::upsert_daily_metrics(
                    conn,
                    DailyMetricDelta {
                        day,
                        active_users: observation.new_users,
                        new_users: observation.new_users,
                        active_clients: active + observation.new_clients,
                        new_clients: observation.new_clients,
                        client_rebinds: observation.rebinds,
                        stale_clients_purged: 0,
                        legacy_subscriptions_purged: 0,
                    },
                    Utc::now().naive_utc(),
                )
            });
            let result = match result {
                Ok(result) => result,
                Err(error) => {
                    self.metrics.record_activity_write("error");
                    self.metrics.record_daily_rollup_update("error");
                    failure = Some(format!("failed to flush client activity: {error:?}"));
                    continue;
                }
            };
            self.metrics.record_activity_write("success");
            self.pending.lock().unwrap().acknowledge(&key, &observation);
            if let Some(metrics) = result {
                self.metrics.record_daily_rollup_update("success");
                if day == Utc::now().date_naive() {
                    self.metrics.set_activity_today(metrics);
                }
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(true),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::client_tracking::{ClientTrackingMetrics, LastSeen};
    use dashmap::DashMap;
    use diesel::r2d2::{ConnectionManager, Pool};
    use diesel::PgConnection;
    use std::sync::{Arc, Mutex};

    fn fixture() -> Option<ClientTrackingService> {
        let url = std::env::var("WETTY_TEST_DATABASE_URL").ok()?;
        let pool = Pool::builder()
            .max_size(1)
            .connection_customizer(Box::new(diesel::r2d2::TestCustomizer))
            .build(ConnectionManager::<PgConnection>::new(url))
            .unwrap();
        pool.get().unwrap().batch_execute(
            "CREATE TEMP TABLE clients (LIKE public.clients INCLUDING ALL);
             CREATE TEMP TABLE push_subscriptions (LIKE public.push_subscriptions INCLUDING ALL);
             CREATE TEMP TABLE activity_daily_metrics (LIKE public.activity_daily_metrics INCLUDING ALL);
             CREATE TEMP TABLE user_extra (LIKE public.user_extra INCLUDING ALL);"
        ).unwrap();
        let metrics = Arc::new(ClientTrackingMetrics::new(&prometheus::Registry::new()));
        Some(ClientTrackingService {
            db: pool.clone(),
            metrics: metrics.clone(),
            recent_writes: Arc::new(DashMap::new()),
            pending: Mutex::new(Pending::default()),
            activity_flush_lock: Mutex::new(()),
            last_seen: Arc::new(LastSeen::new(pool.clone(), metrics)),
        })
    }

    #[test]
    fn stale_snapshot_cannot_restore_previous_owner_or_version() {
        let Some(service) = fixture() else {
            return;
        };
        let pool = service.db.clone();
        service
            .record_client_activity(1, "switching", Some("old"))
            .unwrap();
        assert_eq!(service.pending.lock().unwrap().snapshot().len(), 1);
        service
            .record_client_activity(2, "switching", Some("new"))
            .unwrap();
        service.flush_pending_activity().unwrap();
        service.flush_pending_activity().unwrap();
        let (owner, version) = clients::table
            .find("switching")
            .select((clients::last_active_uid, clients::last_app_version))
            .first::<(i32, Option<String>)>(&mut pool.get().unwrap())
            .unwrap();
        assert_eq!(owner, 2);
        assert_eq!(version.as_deref(), Some("new"));
        let (new_clients, rebinds) = crate::schema::activity_daily_metrics::table
            .find(Utc::now().date_naive())
            .select((
                crate::schema::activity_daily_metrics::new_clients,
                crate::schema::activity_daily_metrics::client_rebinds,
            ))
            .first::<(i64, i64)>(&mut pool.get().unwrap())
            .unwrap();
        assert_eq!((new_clients, rebinds), (1, 1));
        pool.get().unwrap().batch_execute("ALTER TABLE clients ADD CONSTRAINT reject_bad_version CHECK (last_app_version <> 'bad')").unwrap();
        service
            .record_client_activity(3, "a-failing", Some("bad"))
            .unwrap();
        service
            .record_client_activity(4, "b-independent", Some("good"))
            .unwrap();
        assert!(service.flush_pending_activity().is_err());
        let version = clients::table
            .find("b-independent")
            .select(clients::last_app_version)
            .first::<Option<String>>(&mut pool.get().unwrap())
            .unwrap();
        assert_eq!(version.as_deref(), Some("good"));
        pool.get()
            .unwrap()
            .batch_execute("ALTER TABLE clients DROP CONSTRAINT reject_bad_version")
            .unwrap();
        service.flush_pending_activity().unwrap();
        let version = clients::table
            .find("a-failing")
            .select(clients::last_app_version)
            .first::<Option<String>>(&mut pool.get().unwrap())
            .unwrap();
        assert_eq!(version.as_deref(), Some("bad"));
    }

    #[test]
    fn binding_initializes_user_before_handler_and_counts_once_after_flush() {
        let Some(service) = fixture() else {
            return;
        };
        use crate::schema::{activity_daily_metrics, user_extra};
        service.record_activity(17, "new-user", None).unwrap();
        let preferences = user_extra::table
            .find(17)
            .select(user_extra::sticker_pack_order)
            .first::<serde_json::Value>(&mut service.db.get().unwrap())
            .unwrap();
        assert_eq!(preferences, serde_json::json!([]));
        // Business work can update the initialized row before analytics persist.
        diesel::update(user_extra::table.find(17))
            .set(user_extra::sticker_pack_order.eq(serde_json::json!([7])))
            .execute(&mut service.db.get().unwrap())
            .unwrap();
        service.flush_pending_activity().unwrap();
        service.flush_pending_activity().unwrap();
        let counts = activity_daily_metrics::table
            .find(Utc::now().date_naive())
            .select((
                activity_daily_metrics::new_users,
                activity_daily_metrics::active_users,
            ))
            .first::<(i64, i64)>(&mut service.db.get().unwrap())
            .unwrap();
        assert_eq!(counts, (1, 1));
        let preferences = user_extra::table
            .find(17)
            .select(user_extra::sticker_pack_order)
            .first::<serde_json::Value>(&mut service.db.get().unwrap())
            .unwrap();
        assert_eq!(preferences, serde_json::json!([7]));
    }
}
