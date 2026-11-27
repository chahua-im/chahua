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
    pub active_at: Option<NaiveDateTime>,
    pub version: Option<String>,
    pub new_clients: i64,
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
        active: bool,
    ) -> bool {
        let key = (at.date(), client.to_owned());
        if !self.entries.contains_key(&key) && self.entries.len() >= MAX_PENDING {
            return false;
        }
        self.sequence += 1;
        let sequence = self.sequence;
        let entry = self.entries.entry(key).or_insert_with(|| Observation {
            uid,
            active_at: None,
            version: None,
            new_clients: 0,
            rebinds: 0,
            sequence,
            queued: Instant::now(),
        });
        entry.uid = uid;
        if active {
            entry.active_at = Some(entry.active_at.map_or(at, |previous| previous.max(at)));
        }
        if let Some(version) = version {
            entry.version = Some(version.to_owned());
        }
        entry.new_clients += i64::from(binding.new_client);
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
                let active = existing.as_ref().map_or(0, |(at, _)| {
                    i64::from(observation.active_at.is_some() && at.date() < day)
                });
                if let Some((last_active, owner)) = existing {
                    let at = observation
                        .active_at
                        .map_or(last_active, |at| last_active.max(at));
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
                        active_users: 0,
                        new_users: 0,
                        active_clients: active,
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
mod tests;
