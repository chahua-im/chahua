mod buffered;
mod last_seen;
pub use last_seen::LastSeen;

mod metrics;
pub use metrics::{ActivityTodaySnapshot, ClientTrackingMetrics};

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    extract::State,
    http::{
        header::{CONNECTION, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_VERSION, UPGRADE},
        HeaderMap, Method, Request,
    },
    middleware::Next,
    response::{IntoResponse, Response},
};
use chrono::{Days, NaiveDate, NaiveDateTime, Utc};
use dashmap::DashMap;
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::PgConnection;
use tracing::{error, info, warn};

use crate::errors::AppError;
use crate::models::{ActivityDailyMetric, ClientRecord, NewActivityDailyMetric, NewClientRecord};
use crate::schema::{activity_daily_metrics, clients, push_subscriptions};
use crate::services::service_tokens;
use crate::utils::auth::{bearer_token, extract_auth_context, X_APP_VERSION, X_ON_BEHALF_OF};

const ACTIVITY_WRITE_THROTTLE: Duration = Duration::from_secs(5 * 60);
const APP_VERSION_REFRESH_INTERVAL: Duration = Duration::from_secs(60);
const PURGE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const PURGE_RESTART_DELAY: Duration = Duration::from_secs(1);
const PURGE_BATCH_SIZE: i64 = 500;
const STALE_CLIENT_RETENTION_DAYS: u64 = 45;
const WS_UPGRADE_PATHS: [&str; 2] = ["/ws", "/ws/"];
#[derive(Clone)]
struct CachedActivity {
    last_written_at: Option<Instant>,
    last_observed_at: Instant,
    uid: i32,
    day: NaiveDate,
    last_app_version: Option<String>,
}

#[derive(Default, Clone, Copy)]
struct BindingChange {
    new_client: bool,
    rebound: bool,
}

#[derive(Clone, Copy)]
struct DailyMetricDelta {
    day: NaiveDate,
    active_users: i64,
    new_users: i64,
    active_clients: i64,
    new_clients: i64,
    client_rebinds: i64,
    stale_clients_purged: i64,
    legacy_subscriptions_purged: i64,
}

impl DailyMetricDelta {
    fn is_zero(self) -> bool {
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

struct PurgeBatch {
    stale_client_ids: Vec<String>,
    deleted_subscriptions: usize,
    deleted_clients: usize,
    today_metrics: Option<ActivityTodaySnapshot>,
}

/// Loads a shared database snapshot using a caller-supplied clock for a stable cutoff.
pub(crate) fn active_app_version_snapshot(
    conn: &mut PgConnection,
    now: NaiveDateTime,
) -> QueryResult<HashMap<String, i64>> {
    let started = Instant::now();
    let query_metrics = crate::metrics::queries::connection_metrics(conn);
    let result = (|| {
        let rows = clients::table
            .filter(clients::last_active.ge(now - chrono::Duration::hours(24)))
            .group_by(clients::last_app_version)
            .select((clients::last_app_version, diesel::dsl::count_star()))
            .load::<(Option<String>, i64)>(conn)?;
        let mut snapshot = HashMap::new();
        for (version, count) in rows {
            let version = version
                .as_deref()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or("unknown");
            *snapshot.entry(version.to_owned()).or_insert(0) += count;
        }
        Ok(snapshot)
    })();
    if let Some(metrics) = query_metrics {
        metrics.record_app_version_aggregation(started, result.is_ok());
    }
    result
}

/// Publish only after the query succeeds, preserving the previous snapshot on failure.
pub(crate) fn refresh_app_version_snapshot(
    conn: &mut PgConnection,
    metrics: &ClientTrackingMetrics,
    now: NaiveDateTime,
) -> QueryResult<()> {
    let snapshot = active_app_version_snapshot(conn, now)?;
    metrics.set_app_version_active_clients(&snapshot);
    Ok(())
}

pub struct ClientTrackingService {
    db: Pool<ConnectionManager<PgConnection>>,
    metrics: Arc<ClientTrackingMetrics>,
    recent_writes: Arc<DashMap<String, Arc<Mutex<Option<CachedActivity>>>>>,
    pending: Mutex<buffered::Pending>,
    activity_flush_lock: Mutex<()>,
    pub last_seen: Arc<LastSeen>,
}

impl ClientTrackingService {
    pub fn start(
        db: Pool<ConnectionManager<PgConnection>>,
        metrics: Arc<ClientTrackingMetrics>,
    ) -> Arc<Self> {
        let service = Arc::new(Self {
            db: db.clone(),
            metrics: metrics.clone(),
            recent_writes: Arc::new(DashMap::new()),
            pending: Mutex::new(buffered::Pending::default()),
            activity_flush_lock: Mutex::new(()),
            last_seen: Arc::new(LastSeen::new(db.clone(), metrics.clone())),
        });

        let gauge_service = service.clone();
        tokio::spawn(async move {
            match tokio::task::spawn_blocking(move || gauge_service.refresh_today_metrics_gauges())
                .await
            {
                Ok(Ok(())) => {}
                Ok(Err(error)) => warn!(
                    "client tracking: failed to initialize today's activity gauges: {}",
                    error
                ),
                Err(error) => warn!(
                    "client tracking: activity gauge initialization worker failed: {}",
                    error
                ),
            }
        });
        let version_db = db.clone();
        let version_metrics = metrics.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(APP_VERSION_REFRESH_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let db = version_db.clone();
                let metrics = version_metrics.clone();
                match tokio::task::spawn_blocking(move || {
                    let mut conn = db.get().map_err(|error| error.to_string())?;
                    refresh_app_version_snapshot(&mut conn, &metrics, Utc::now().naive_utc())
                        .map_err(|error| error.to_string())
                })
                .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        warn!(
                            "client tracking: app version snapshot refresh failed: {}",
                            error
                        )
                    }
                    Err(error) => {
                        warn!(
                            "client tracking: app version snapshot worker failed: {}",
                            error
                        )
                    }
                }
            }
        });

        let worker_service = service.clone();
        tokio::spawn(async move {
            super::push::supervise_worker(
                "client activity purge worker",
                PURGE_RESTART_DELAY,
                move || {
                    let worker_service = worker_service.clone();
                    async move {
                        worker_service.run_purge_worker().await;
                    }
                },
            )
            .await;
        });

        service
    }

    /// Binds the client and updates its metadata without observing usage.
    pub fn record_activity(
        &self,
        uid: i32,
        client_id: &str,
        app_version: Option<&str>,
    ) -> Result<(), AppError> {
        self.record_client_activity_at(uid, client_id, app_version, Utc::now().naive_utc(), false)
    }

    pub fn record_client_activity(
        &self,
        uid: i32,
        client_id: &str,
        app_version: Option<&str>,
    ) -> Result<(), AppError> {
        self.record_client_activity_at(uid, client_id, app_version, Utc::now().naive_utc(), true)
    }

    fn record_client_activity_at(
        &self,
        uid: i32,
        client_id: &str,
        app_version: Option<&str>,
        now: NaiveDateTime,
        active: bool,
    ) -> Result<(), AppError> {
        let slot = match self.recent_writes.get(client_id) {
            Some(slot) => slot.clone(),
            None => self
                .recent_writes
                .entry(client_id.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(None)))
                .clone(),
        };
        let mut cached = slot.lock().unwrap();
        let mut change = BindingChange::default();
        let bound = cached.as_ref().is_none_or(|entry| entry.uid != uid);
        if bound {
            let conn = &mut self.db.get().map_err(|error| {
                error!("client tracking: failed to get DB connection: {:?}", error);
                AppError::Internal("Database connection failed")
            })?;
            let (existing, inserted, rebound) = conn
                .transaction::<_, diesel::result::Error, _>(|conn| {
                    let existing = clients::table
                        .find(client_id)
                        .select(ClientRecord::as_select())
                        .first::<ClientRecord>(conn)
                        .optional()?;
                    let inserted = existing.is_none();
                    let rebound = existing
                        .as_ref()
                        .is_some_and(|row| row.last_active_uid != uid);
                    if inserted {
                        diesel::insert_into(clients::table)
                            .values(&NewClientRecord {
                                client_id: client_id.to_owned(),
                                created_at: now,
                                last_active: chrono::DateTime::UNIX_EPOCH.naive_utc(),
                                last_active_uid: uid,
                                last_app_version: None,
                            })
                            .execute(conn)?;
                    } else if rebound {
                        diesel::update(clients::table.find(client_id))
                            .set(clients::last_active_uid.eq(uid))
                            .execute(conn)?;
                    }
                    if inserted || rebound {
                        diesel::update(
                            push_subscriptions::table.filter(
                                push_subscriptions::client_id.eq(Some(client_id.to_owned())),
                            ),
                        )
                        .set(push_subscriptions::user_id.eq(uid))
                        .execute(conn)?;
                    }
                    Ok((existing, inserted, rebound))
                })
                .map_err(|error| {
                    error!("client tracking: failed to bind client: {:?}", error);
                    AppError::Internal("Failed to record client activity")
                })?;
            change = BindingChange {
                new_client: inserted,
                rebound,
            };
            *cached = Some(CachedActivity {
                uid,
                day: now.date(),
                last_written_at: None,
                last_observed_at: Instant::now(),
                last_app_version: existing.and_then(|row| row.last_app_version),
            });
            if rebound {
                self.metrics.record_rebind();
            }
        }
        let entry = cached.as_mut().unwrap();
        entry.last_observed_at = Instant::now();
        let changed =
            app_version.is_some_and(|version| entry.last_app_version.as_deref() != Some(version));
        if bound
            || changed
            || (active
                && (entry.day != now.date()
                    || entry
                        .last_written_at
                        .is_none_or(|at| at.elapsed() >= ACTIVITY_WRITE_THROTTLE)))
        {
            if self
                .pending
                .lock()
                .unwrap()
                .record(client_id, uid, now, app_version, change, active)
            {
                if active {
                    entry.day = now.date();
                    entry.last_written_at = Some(Instant::now());
                }
                if let Some(version) = app_version {
                    entry.last_app_version = Some(version.to_owned());
                }
            } else {
                self.metrics.record_activity_dropped();
            }
        } else {
            self.metrics.record_activity_write_skipped("throttled");
        }
        Ok(())
    }

    pub fn last_app_versions(
        &self,
        client_ids: &[String],
    ) -> Result<HashMap<String, Option<String>>, crate::errors::AppError> {
        if client_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let conn = &mut self.db.get().map_err(|e| {
            error!("client tracking: failed to get DB connection: {:?}", e);
            crate::errors::AppError::Internal("Database connection failed")
        })?;

        clients::table
            .filter(clients::client_id.eq_any(client_ids))
            .select((clients::client_id, clients::last_app_version))
            .load::<(String, Option<String>)>(conn)
            .map(|rows| rows.into_iter().collect())
            .map_err(|e| {
                error!(
                    "client tracking: failed to load client app versions: {:?}",
                    e
                );
                crate::errors::AppError::Internal("Failed to load client app versions")
            })
    }

    async fn run_purge_worker(self: Arc<Self>) {
        let mut interval = tokio::time::interval(PURGE_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            interval.tick().await;
            if let Err(error) = self.purge_stale_subscriptions().await {
                warn!("client tracking purge failed: {}", error);
            }
        }
    }

    async fn purge_stale_subscriptions(&self) -> Result<(), String> {
        let now = Utc::now().naive_utc();
        let today = now.date();
        let stale_cutoff = now
            .checked_sub_days(Days::new(STALE_CLIENT_RETENTION_DAYS))
            .ok_or_else(|| "failed to compute stale client cutoff".to_string())?;
        let mut deleted_subscriptions = 0;
        let mut deleted_clients = 0;

        loop {
            let db = self.db.clone();
            let cache = self.recent_writes.clone();
            let batch = tokio::task::spawn_blocking(move || {
                Self::purge_stale_subscriptions_batch(db, cache, now, today, stale_cutoff)
            })
            .await
            .map_err(|error| format!("stale client purge worker failed: {}", error))??;
            let stale_client_count = batch.stale_client_ids.len();

            if let Some(today_metrics) = batch.today_metrics {
                self.metrics.set_activity_today(today_metrics);
                self.metrics.record_daily_rollup_update("success");
            }
            if batch.deleted_clients > 0 {
                self.metrics
                    .record_purge("stale_clients", batch.deleted_clients as u64);
            }

            deleted_subscriptions += batch.deleted_subscriptions;
            deleted_clients += batch.deleted_clients;
            if stale_client_count < PURGE_BATCH_SIZE as usize {
                break;
            }

            tokio::task::yield_now().await;
        }

        if deleted_subscriptions > 0 || deleted_clients > 0 {
            info!(
                "client tracking purge removed {} push subscriptions and {} clients",
                deleted_subscriptions, deleted_clients
            );
        }

        Ok(())
    }

    fn purge_stale_subscriptions_batch(
        db: Pool<ConnectionManager<PgConnection>>,
        cache: Arc<DashMap<String, Arc<Mutex<Option<CachedActivity>>>>>,
        now: NaiveDateTime,
        today: NaiveDate,
        stale_cutoff: NaiveDateTime,
    ) -> Result<PurgeBatch, String> {
        let conn = &mut db
            .get()
            .map_err(|error| format!("failed to get DB connection: {:?}", error))?;

        let candidates: Vec<String> = clients::table
            .filter(clients::last_active.lt(stale_cutoff))
            .filter(clients::created_at.lt(stale_cutoff))
            .order(clients::last_active.asc())
            .limit(PURGE_BATCH_SIZE)
            .select(clients::client_id)
            .load(conn)
            .map_err(|error| format!("failed to select stale clients: {error:?}"))?;
        let slots: Vec<_> = candidates
            .iter()
            .map(|id| {
                cache
                    .entry(id.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(None)))
                    .clone()
            })
            .collect();
        let mut guards: Vec<_> = slots.iter().map(|slot| slot.try_lock().ok()).collect();
        // Clients with buffered recent activity are not purge candidates. Release
        // their locks before any database work so their requests remain memory-only.
        for guard in &mut guards {
            if guard.as_ref().is_some_and(|entry| {
                entry.as_ref().is_some_and(|cached| {
                    cached.last_observed_at.elapsed()
                        < Duration::from_secs(STALE_CLIENT_RETENTION_DAYS * 86400)
                })
            }) {
                *guard = None;
            }
        }
        let eligible: Vec<_> = candidates
            .iter()
            .zip(guards.iter())
            .filter_map(|(id, guard)| guard.as_ref().map(|_| id.clone()))
            .collect();
        let batch = conn
            .transaction::<PurgeBatch, diesel::result::Error, _>(|conn| {
                let stale_client_ids: Vec<String> = clients::table
                    .filter(clients::client_id.eq_any(&eligible))
                    .filter(clients::last_active.lt(stale_cutoff))
                    .for_update()
                    .skip_locked()
                    .select(clients::client_id)
                    .load(conn)?;

                if stale_client_ids.is_empty() {
                    return Ok(PurgeBatch {
                        stale_client_ids,
                        deleted_subscriptions: 0,
                        deleted_clients: 0,
                        today_metrics: None,
                    });
                }

                let deleted_subscriptions = diesel::delete(
                    push_subscriptions::table
                        .filter(push_subscriptions::client_id.eq_any(&stale_client_ids)),
                )
                .execute(conn)?;
                let deleted_clients = diesel::delete(
                    clients::table.filter(clients::client_id.eq_any(&stale_client_ids)),
                )
                .execute(conn)?;
                let today_metrics = Self::upsert_daily_metrics(
                    conn,
                    DailyMetricDelta {
                        day: today,
                        active_users: 0,
                        new_users: 0,
                        active_clients: 0,
                        new_clients: 0,
                        client_rebinds: 0,
                        stale_clients_purged: deleted_clients as i64,
                        legacy_subscriptions_purged: 0,
                    },
                    now,
                )?;

                Ok(PurgeBatch {
                    stale_client_ids,
                    deleted_subscriptions,
                    deleted_clients,
                    today_metrics,
                })
            })
            .map_err(|error| format!("failed to purge stale client batch: {:?}", error))?;
        for (id, guard) in candidates.iter().zip(guards.iter_mut()) {
            if batch.stale_client_ids.contains(id) {
                if let Some(guard) = guard {
                    **guard = None;
                }
            }
        }
        drop(guards);
        drop(slots);
        for id in &batch.stale_client_ids {
            // Keep a slot while another request holds it, so concurrent binds
            // cannot acquire different locks for the same client.
            cache.remove_if(id, |_, slot| Arc::strong_count(slot) == 1);
        }
        Ok(batch)
    }

    fn refresh_today_metrics_gauges(&self) -> Result<(), String> {
        let today = Utc::now().date_naive();
        let conn = &mut self
            .db
            .get()
            .map_err(|e| format!("failed to get DB connection: {:?}", e))?;

        let today_metrics = activity_daily_metrics::table
            .find(today)
            .select(ActivityDailyMetric::as_select())
            .first::<ActivityDailyMetric>(conn)
            .optional()
            .map_err(|e| format!("failed to load today's activity metrics: {:?}", e))?;

        if let Some(metrics) = today_metrics {
            self.metrics.set_activity_today(ActivityTodaySnapshot {
                active_users: metrics.active_users,
                new_users: metrics.new_users,
                active_clients: metrics.active_clients,
                new_clients: metrics.new_clients,
                client_rebinds: metrics.client_rebinds,
                stale_clients_purged: metrics.stale_clients_purged,
                legacy_subscriptions_purged: metrics.legacy_subscriptions_purged,
            });
        } else {
            self.metrics
                .set_activity_today(ActivityTodaySnapshot::zero());
        }

        Ok(())
    }

    fn upsert_daily_metrics(
        conn: &mut PgConnection,
        delta: DailyMetricDelta,
        now: NaiveDateTime,
    ) -> Result<Option<ActivityTodaySnapshot>, diesel::result::Error> {
        if delta.is_zero() {
            return Ok(None);
        }

        let new_row = NewActivityDailyMetric {
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
            .values(&new_row)
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

        let today_metrics = activity_daily_metrics::table
            .find(delta.day)
            .select(ActivityDailyMetric::as_select())
            .first::<ActivityDailyMetric>(conn)?;

        Ok(Some(
            DailyMetricDelta {
                day: today_metrics.day,
                active_users: today_metrics.active_users,
                new_users: today_metrics.new_users,
                active_clients: today_metrics.active_clients,
                new_clients: today_metrics.new_clients,
                client_rebinds: today_metrics.client_rebinds,
                stale_clients_purged: today_metrics.stale_clients_purged,
                legacy_subscriptions_purged: today_metrics.legacy_subscriptions_purged,
            }
            .as_activity_today_snapshot(),
        ))
    }

    pub fn flush_pending_activity(&self) -> Result<(), String> {
        let _guard = self.activity_flush_lock.lock().unwrap();
        let (count, age) = self.pending.lock().unwrap().stats();
        let (seen_count, seen_age) = self.last_seen.stats();
        self.metrics
            .set_pending_activity(count + seen_count, age.max(seen_age));
        let started = Instant::now();
        let clients = self.flush_clients();
        let seen = self.last_seen.flush();
        let result = clients.and(seen);
        if count + seen_count > 0 {
            self.metrics
                .record_activity_flush(started.elapsed(), result.is_ok());
        }
        let (count, age) = self.pending.lock().unwrap().stats();
        let (seen_count, seen_age) = self.last_seen.stats();
        self.metrics
            .set_pending_activity(count + seen_count, age.max(seen_age));
        result
    }
}

/// Flush all users together, including one final batch when the server stops.
pub async fn run_activity_worker(
    service: Arc<ClientTrackingService>,
    mut shutdown: tokio::sync::oneshot::Receiver<()>,
) {
    let period = Duration::from_secs(15);
    let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let stopping = tokio::select! {
            _ = &mut shutdown => true,
            _ = interval.tick() => false,
        };
        let batch = service.clone();
        match tokio::task::spawn_blocking(move || batch.flush_pending_activity()).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => warn!(%error, "activity batch flush failed"),
            Err(error) => warn!(%error, "activity batch worker failed"),
        }
        if stopping {
            break;
        }
    }
}

/// Preserves the legacy best-effort header behavior: absent or malformed
/// credentials do not reject an HTTP request or a just-upgraded legacy socket.
/// A persistence failure remains observable to the adapter because it was
/// previously an HTTP response failure before the middleware was deferred.
pub(crate) fn record_header_activity(
    state: &crate::AppState,
    headers: &HeaderMap,
) -> Result<(), AppError> {
    if !should_record_client_activity(headers) {
        return Ok(());
    }

    let Ok(auth) = extract_auth_context(headers, state) else {
        return Ok(());
    };
    state.client_tracking.record_activity(
        auth.uid,
        &auth.client_id,
        app_version_from_headers(headers).as_deref(),
    )
}

pub async fn track_client_activity(
    State(state): State<crate::AppState>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let request =
        if !is_websocket_upgrade_request(request.method(), request.uri().path(), request.headers())
            && request
                .headers()
                .contains_key(axum::http::header::AUTHORIZATION)
            && should_record_client_activity(request.headers())
        {
            match tokio::task::spawn_blocking(move || {
                let result = record_header_activity(&state, request.headers());
                (request, result)
            })
            .await
            {
                Ok((request, Ok(()))) => request,
                Ok((_, Err(error))) => return error.into_response(),
                Err(error) => {
                    error!(?error, "client activity worker failed");
                    return AppError::Internal("Failed to record client activity").into_response();
                }
            }
        } else {
            request
        };

    next.run(request).await
}

pub(crate) fn should_record_client_activity(headers: &HeaderMap) -> bool {
    !headers.contains_key(X_ON_BEHALF_OF)
        && bearer_token(headers).is_ok_and(|token| {
            !token.is_some_and(|token| token.starts_with(service_tokens::TOKEN_PREFIX))
        })
}

/// Matches the WebSocket extractor's HTTP-upgrade shape so ordinary `/ws`
/// requests, including ticket and client endpoints, retain middleware auth.
pub(crate) fn is_websocket_upgrade_request(
    method: &Method,
    path: &str,
    headers: &HeaderMap,
) -> bool {
    method == Method::GET
        && WS_UPGRADE_PATHS.contains(&path)
        && headers
            .get(UPGRADE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
        && headers
            .get_all(CONNECTION)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .any(|value| {
                value
                    .split(',')
                    .any(|item| item.trim().eq_ignore_ascii_case("upgrade"))
            })
        && headers.contains_key(SEC_WEBSOCKET_KEY)
        && headers.contains_key(SEC_WEBSOCKET_VERSION)
}

fn app_version_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get(X_APP_VERSION)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests;
