mod last_seen;
pub use last_seen::LastSeen;

mod metrics;
pub use metrics::{ActivityTodaySnapshot, ClientTrackingMetrics};

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::State,
    http::{HeaderMap, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use chrono::{Days, NaiveDate, NaiveDateTime, Utc};
use dashmap::DashMap;
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::PgConnection;
use tracing::{error, info, warn};

use crate::models::{
    ActivityDailyMetric, ClientRecord, NewActivityDailyMetric, NewClientRecord, NewUserExtra,
};
use crate::schema::{activity_daily_metrics, clients, push_subscriptions, user_extra};
use crate::services::service_tokens;
use crate::utils::auth::{bearer_token, extract_auth_context, X_APP_VERSION, X_ON_BEHALF_OF};

const ACTIVITY_WRITE_THROTTLE: Duration = Duration::from_secs(5 * 60);
const PURGE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const PURGE_RESTART_DELAY: Duration = Duration::from_secs(1);
const PURGE_BATCH_SIZE: i64 = 500;
const STALE_CLIENT_RETENTION_DAYS: u64 = 45;
const WS_UPGRADE_PATHS: [&str; 2] = ["/ws", "/ws/"];

#[derive(Clone)]
struct CachedActivity {
    last_written_at: Instant,
    uid: i32,
    day: NaiveDate,
    last_app_version: Option<String>,
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

pub struct ClientTrackingService {
    db: Pool<ConnectionManager<PgConnection>>,
    metrics: Arc<ClientTrackingMetrics>,
    recent_writes: DashMap<String, CachedActivity>,
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
            recent_writes: DashMap::new(),
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

    pub fn record_activity(
        &self,
        uid: i32,
        client_id: &str,
        app_version: Option<&str>,
    ) -> Result<(), (StatusCode, &'static str)> {
        self.last_seen.record(uid, Utc::now().naive_utc());
        self.record_client_activity(uid, client_id, app_version)
    }

    pub fn record_client_activity(
        &self,
        uid: i32,
        client_id: &str,
        app_version: Option<&str>,
    ) -> Result<(), (StatusCode, &'static str)> {
        let now = Utc::now().naive_utc();
        let today = now.date();
        if let Some(entry) = self.recent_writes.get(client_id) {
            let app_version_changed = app_version
                .is_some_and(|version| entry.last_app_version.as_deref() != Some(version));
            if entry.uid == uid
                && !app_version_changed
                && entry.day == today
                && entry.last_written_at.elapsed() < ACTIVITY_WRITE_THROTTLE
            {
                self.metrics.record_activity_write_skipped("throttled");
                return Ok(());
            }
        }

        let conn = &mut self.db.get().map_err(|e| {
            error!("client tracking: failed to get DB connection: {:?}", e);
            self.metrics.record_activity_write("error");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Database connection failed",
            )
        })?;

        let (recorded_app_version, today_metrics, recorded_rebind) = conn
            .transaction::<
                (Option<String>, Option<ActivityTodaySnapshot>, bool),
                diesel::result::Error,
                _,
            >(|conn| {
                let existing_client = clients::table
                    .find(client_id)
                    .select(ClientRecord::as_select())
                    .first::<ClientRecord>(conn)
                    .optional()?;

                let active_client_delta = i64::from(
                    existing_client
                        .as_ref()
                        .is_none_or(|client| client.last_active.date() != today),
                );
                let new_client_delta = i64::from(existing_client.is_none());
                let rebind_delta = i64::from(
                    existing_client
                        .as_ref()
                        .is_some_and(|client| client.last_active_uid != uid),
                );

                if rebind_delta > 0 {
                    diesel::update(
                        push_subscriptions::table
                            .filter(push_subscriptions::client_id.eq(Some(client_id.to_string()))),
                    )
                    .set(push_subscriptions::user_id.eq(uid))
                    .execute(conn)?;
                }

                let new_client_app_version = app_version.map(str::to_owned).or_else(|| {
                    existing_client
                        .as_ref()
                        .and_then(|client| client.last_app_version.clone())
                });
                let new_client = NewClientRecord {
                    client_id: client_id.to_string(),
                    created_at: existing_client
                        .as_ref()
                        .map_or(now, |client| client.created_at),
                    last_active: now,
                    last_active_uid: uid,
                    last_app_version: new_client_app_version,
                };

                let last_app_version = if let Some(version) = app_version {
                    diesel::insert_into(clients::table)
                        .values(&new_client)
                        .on_conflict(clients::client_id)
                        .do_update()
                        .set((
                            clients::last_active.eq(now),
                            clients::last_active_uid.eq(uid),
                            clients::last_app_version.eq(version),
                        ))
                        .returning(clients::last_app_version)
                        .get_result::<Option<String>>(conn)?
                } else {
                    diesel::insert_into(clients::table)
                        .values(&new_client)
                        .on_conflict(clients::client_id)
                        .do_update()
                        .set((
                            clients::last_active.eq(now),
                            clients::last_active_uid.eq(uid),
                        ))
                        .returning(clients::last_app_version)
                        .get_result::<Option<String>>(conn)?
                };

                let new_user_delta = diesel::insert_into(user_extra::table)
                    .values(NewUserExtra::new(uid, now))
                    .on_conflict(user_extra::uid)
                    .do_nothing()
                    .execute(conn)? as i64;

                let today_metrics = Self::upsert_daily_metrics(
                    conn,
                    DailyMetricDelta {
                        day: today,
                        active_users: new_user_delta,
                        new_users: new_user_delta,
                        active_clients: active_client_delta,
                        new_clients: new_client_delta,
                        client_rebinds: rebind_delta,
                        stale_clients_purged: 0,
                        legacy_subscriptions_purged: 0,
                    },
                    now,
                )?;

                Ok((last_app_version, today_metrics, rebind_delta > 0))
            })
            .map_err(|e| {
                error!("client tracking: failed to record activity: {:?}", e);
                self.metrics.record_activity_write("error");
                self.metrics.record_daily_rollup_update("error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to record client activity",
                )
            })?;

        self.metrics.record_activity_write("success");

        if let Some(today_metrics) = today_metrics {
            self.metrics.set_activity_today(today_metrics);
            self.metrics.record_daily_rollup_update("success");
        }
        if recorded_rebind {
            self.metrics.record_rebind();
        }
        self.recent_writes.insert(
            client_id.to_string(),
            CachedActivity {
                last_written_at: Instant::now(),
                day: today,
                uid,
                last_app_version: recorded_app_version,
            },
        );

        Ok(())
    }

    pub fn last_app_versions(
        &self,
        client_ids: &[String],
    ) -> Result<HashMap<String, Option<String>>, (StatusCode, &'static str)> {
        if client_ids.is_empty() {
            return Ok(HashMap::new());
        }

        let conn = &mut self.db.get().map_err(|e| {
            error!("client tracking: failed to get DB connection: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Database connection failed",
            )
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
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to load client app versions",
                )
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
            let batch = tokio::task::spawn_blocking(move || {
                Self::purge_stale_subscriptions_batch(db, now, today, stale_cutoff)
            })
            .await
            .map_err(|error| format!("stale client purge worker failed: {}", error))??;
            let stale_client_count = batch.stale_client_ids.len();

            for client_id in &batch.stale_client_ids {
                self.recent_writes.remove(client_id);
            }
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
        now: NaiveDateTime,
        today: NaiveDate,
        stale_cutoff: NaiveDateTime,
    ) -> Result<PurgeBatch, String> {
        let conn = &mut db
            .get()
            .map_err(|error| format!("failed to get DB connection: {:?}", error))?;

        conn.transaction::<PurgeBatch, diesel::result::Error, _>(|conn| {
            let stale_client_ids: Vec<String> = clients::table
                .filter(clients::last_active.lt(stale_cutoff))
                .order(clients::last_active.asc())
                .for_update()
                .skip_locked()
                .limit(PURGE_BATCH_SIZE)
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
            let deleted_clients =
                diesel::delete(clients::table.filter(clients::client_id.eq_any(&stale_client_ids)))
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
        .map_err(|error| format!("failed to purge stale client batch: {:?}", error))
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
}

/// Flush all users together, including one final batch when the server stops.
pub async fn run_last_seen_worker(
    last_seen: Arc<LastSeen>,
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
        let batch = last_seen.clone();
        match tokio::task::spawn_blocking(move || batch.flush()).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => warn!(%error, "last-seen batch flush failed"),
            Err(error) => warn!(%error, "last-seen batch worker failed"),
        }
        if stopping {
            break;
        }
    }
}

pub async fn track_client_activity(
    State(state): State<crate::AppState>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let record_app_version = should_record_app_version_request(request.uri().path());
    let app_version = app_version_from_headers(request.headers());

    let mut resolved_client_id: Option<String> = None;

    if should_record_client_activity(request.headers()) {
        if let Ok(auth) = extract_auth_context(request.headers(), &state) {
            let client_id = auth.client_id;
            resolved_client_id = Some(client_id.clone());
            if let Err((status, message)) =
                state
                    .client_tracking
                    .record_activity(auth.uid, &client_id, app_version.as_deref())
            {
                return (status, message).into_response();
            }
        }
    }

    if record_app_version {
        let version = app_version.as_deref().unwrap_or("unknown");
        state
            .metrics
            .client_tracking
            .record_app_version_request(version, resolved_client_id.as_deref());
    }

    next.run(request).await
}

pub(crate) fn should_record_client_activity(headers: &HeaderMap) -> bool {
    !headers.contains_key(X_ON_BEHALF_OF)
        && bearer_token(headers).is_ok_and(|token| {
            !token.is_some_and(|token| token.starts_with(service_tokens::TOKEN_PREFIX))
        })
}

fn app_version_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get(X_APP_VERSION)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .map(str::to_owned)
}

fn should_record_app_version_request(path: &str) -> bool {
    !WS_UPGRADE_PATHS.contains(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn throttled_client_activity_still_advances_last_seen() {
        let db = Pool::builder()
            .max_size(1)
            .min_idle(Some(0))
            .build_unchecked(ConnectionManager::<PgConnection>::new(
                "last_seen_test_invalid_option=value",
            ));
        let metrics = Arc::new(ClientTrackingMetrics::new(&prometheus::Registry::new()));
        let last_seen = Arc::new(LastSeen::new(db.clone(), metrics.clone()));
        let service = ClientTrackingService {
            db,
            metrics,
            recent_writes: DashMap::new(),
            last_seen: last_seen.clone(),
        };
        let before = Utc::now().naive_utc();
        last_seen.record(17, before - chrono::Duration::minutes(3));
        service.recent_writes.insert(
            "client".into(),
            CachedActivity {
                last_written_at: Instant::now(),
                uid: 17,
                day: before.date(),
                last_app_version: None,
            },
        );

        service.record_activity(17, "client", None).unwrap();

        assert!(last_seen.latest(17, None).unwrap() >= before);
    }

    #[test]
    fn client_activity_records_last_seen_before_database_failure() {
        let db = Pool::builder()
            .max_size(1)
            .min_idle(Some(0))
            .connection_timeout(Duration::from_millis(1))
            .build_unchecked(ConnectionManager::<PgConnection>::new(
                "last_seen_test_invalid_option=value",
            ));
        let metrics = Arc::new(ClientTrackingMetrics::new(&prometheus::Registry::new()));
        let last_seen = Arc::new(LastSeen::new(db.clone(), metrics.clone()));
        let service = ClientTrackingService {
            db,
            metrics,
            recent_writes: DashMap::new(),
            last_seen: last_seen.clone(),
        };
        let before = Utc::now().naive_utc();

        assert!(service.record_activity(17, "client", None).is_err());

        assert!(last_seen.latest(17, None).unwrap() >= before);
    }

    #[test]
    fn daily_metric_delta_detects_zero_values() {
        assert!(DailyMetricDelta {
            day: NaiveDate::from_ymd_opt(2026, 3, 21).unwrap(),
            active_users: 0,
            new_users: 0,
            active_clients: 0,
            new_clients: 0,
            client_rebinds: 0,
            stale_clients_purged: 0,
            legacy_subscriptions_purged: 0,
        }
        .is_zero());
    }

    #[test]
    fn app_version_tracking_excludes_websocket_upgrade_path() {
        assert!(!should_record_app_version_request("/ws"));
        assert!(!should_record_app_version_request("/ws/"));
        assert!(should_record_app_version_request("/ws/ticket"));
        assert!(should_record_app_version_request("/chats"));
    }

    #[test]
    fn automation_credentials_are_excluded_from_client_tracking() {
        use axum::http::{header::AUTHORIZATION, HeaderValue};

        let mut headers = HeaderMap::new();
        // WebSockets authenticate their session in the first frame, not the upgrade headers.
        assert!(should_record_client_activity(&headers));
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer user-session"),
        );
        assert!(should_record_client_activity(&headers));

        let credential = format!("Bearer svc_{}_{}", "ab".repeat(16), "cd".repeat(32));
        headers.insert(AUTHORIZATION, HeaderValue::from_str(&credential).unwrap());
        assert!(!should_record_client_activity(&headers));
        headers.insert(X_ON_BEHALF_OF, HeaderValue::from_static("42"));
        assert!(!should_record_client_activity(&headers));

        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer user-session"),
        );
        assert!(!should_record_client_activity(&headers));
    }

    #[test]
    fn daily_metric_delta_detects_non_zero_values() {
        assert!(!DailyMetricDelta {
            day: NaiveDate::from_ymd_opt(2026, 3, 21).unwrap(),
            active_users: 1,
            new_users: 0,
            active_clients: 0,
            new_clients: 0,
            client_rebinds: 0,
            stale_clients_purged: 0,
            legacy_subscriptions_purged: 0,
        }
        .is_zero());
    }

    #[test]
    fn activity_daily_metric_model_uses_expected_day_type() {
        let record = crate::models::ActivityDailyMetric {
            day: NaiveDate::from_ymd_opt(2026, 3, 21).unwrap(),
            active_users: 1,
            new_users: 1,
            active_clients: 1,
            new_clients: 1,
            client_rebinds: 0,
            stale_clients_purged: 0,
            legacy_subscriptions_purged: 0,
            updated_at: NaiveDate::from_ymd_opt(2026, 3, 21)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
        };

        assert_eq!(record.day.to_string(), "2026-03-21");
    }
    #[test]
    fn app_version_header_is_trimmed_and_empty_values_are_ignored() {
        let mut headers = HeaderMap::new();
        headers.insert(
            X_APP_VERSION,
            axum::http::HeaderValue::from_static("  1.2.3  "),
        );
        assert_eq!(app_version_from_headers(&headers).as_deref(), Some("1.2.3"));

        headers.insert(X_APP_VERSION, axum::http::HeaderValue::from_static("   "));
        assert_eq!(app_version_from_headers(&headers), None);
    }

    /// Requires a migrated test database (`WETTY_TEST_DATABASE_URL`); skipped
    /// otherwise. All writes roll back, including daily activity metrics.
    #[test]
    fn app_version_persists_through_missing_headers_and_bypasses_throttle_when_changed() {
        use std::sync::atomic::{AtomicI32, Ordering};

        let url = match std::env::var("WETTY_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(_) => {
                eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
                return;
            }
        };
        static NEXT_UID: AtomicI32 = AtomicI32::new(2_000_000_000);
        let uid = NEXT_UID.fetch_add(1, Ordering::SeqCst);
        let client_id = format!("app-version-test-{}", uuid::Uuid::new_v4());
        let pool = Pool::builder()
            .max_size(1)
            .connection_customizer(Box::new(diesel::r2d2::TestCustomizer))
            .build(ConnectionManager::<PgConnection>::new(url))
            .expect("create test database pool");
        let metrics = Arc::new(ClientTrackingMetrics::new(&prometheus::Registry::new()));
        let service = ClientTrackingService {
            last_seen: Arc::new(LastSeen::new(pool.clone(), metrics.clone())),
            db: pool,
            metrics,
            recent_writes: DashMap::new(),
        };

        service
            .record_activity(uid, &client_id, Some("1.0.0"))
            .expect("record initial app version");
        service
            .record_activity(uid, &client_id, None)
            .expect("record activity without app version");
        assert_eq!(
            service
                .last_app_versions(std::slice::from_ref(&client_id))
                .expect("load persisted app version")
                .get(&client_id)
                .cloned(),
            Some(Some("1.0.0".to_owned()))
        );

        service
            .record_activity(uid, &client_id, Some("2.0.0"))
            .expect("record changed app version without waiting for throttle");
        assert_eq!(
            service
                .last_app_versions(std::slice::from_ref(&client_id))
                .expect("load changed app version")
                .get(&client_id)
                .cloned(),
            Some(Some("2.0.0".to_owned()))
        );

        service.recent_writes.clear();
        service
            .record_activity(uid, &client_id, None)
            .expect("persist activity without overwriting the stored version");
        assert_eq!(
            service
                .last_app_versions(std::slice::from_ref(&client_id))
                .expect("load version after an unthrottled versionless write")
                .get(&client_id)
                .cloned(),
            Some(Some("2.0.0".to_owned()))
        );
    }

    /// Requires a migrated test database (`WETTY_TEST_DATABASE_URL`); skipped
    /// otherwise. All writes roll back with the test connection.
    #[test]
    fn stale_client_purge_deletes_at_most_one_batch() {
        let url = match std::env::var("WETTY_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(_) => {
                eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
                return;
            }
        };
        let pool = Pool::builder()
            .max_size(1)
            .connection_customizer(Box::new(diesel::r2d2::TestCustomizer))
            .build(ConnectionManager::<PgConnection>::new(url))
            .expect("create test database pool");
        let now = Utc::now().naive_utc();
        let stale_cutoff = now
            .checked_sub_days(Days::new(STALE_CLIENT_RETENTION_DAYS))
            .expect("compute stale client cutoff");
        let stale_at = stale_cutoff
            .checked_sub_signed(chrono::Duration::seconds(1))
            .expect("compute stale client timestamp");
        let prefix = format!("purge-batch-test-{}", uuid::Uuid::new_v4());
        let stale_clients: Vec<NewClientRecord> = (0..=PURGE_BATCH_SIZE)
            .map(|index| NewClientRecord {
                client_id: format!("{}-{}", prefix, index),
                created_at: stale_at,
                last_active: stale_at,
                last_active_uid: 1,
                last_app_version: None,
            })
            .collect();
        let active_client_id = format!("{}-active", prefix);
        let active_client = NewClientRecord {
            client_id: active_client_id.clone(),
            created_at: now,
            last_active: now,
            last_active_uid: 1,
            last_app_version: None,
        };

        {
            let conn = &mut pool.get().expect("get test database connection");
            use diesel::connection::SimpleConnection;

            conn.batch_execute(
                "CREATE TEMP TABLE clients (LIKE public.clients INCLUDING ALL);
                 CREATE TEMP TABLE push_subscriptions (LIKE public.push_subscriptions INCLUDING ALL);
                 CREATE TEMP TABLE activity_daily_metrics (LIKE public.activity_daily_metrics INCLUDING ALL);",
            )
            .expect("isolate purge fixtures from existing database rows");
            diesel::insert_into(clients::table)
                .values(&stale_clients)
                .execute(conn)
                .expect("insert stale clients");
            diesel::insert_into(clients::table)
                .values(&active_client)
                .execute(conn)
                .expect("insert active client");
        }

        let batch = ClientTrackingService::purge_stale_subscriptions_batch(
            pool.clone(),
            now,
            now.date(),
            stale_cutoff,
        )
        .expect("purge one stale client batch");
        assert_eq!(batch.stale_client_ids.len(), PURGE_BATCH_SIZE as usize);
        assert_eq!(batch.deleted_clients, PURGE_BATCH_SIZE as usize);

        let conn = &mut pool.get().expect("get test database connection");
        let stale_remaining = clients::table
            .filter(clients::client_id.like(format!("{}-%", prefix)))
            .filter(clients::last_active.lt(stale_cutoff))
            .count()
            .get_result::<i64>(conn)
            .expect("count remaining stale clients");
        assert_eq!(stale_remaining, 1);
        let active_remaining = clients::table
            .find(&active_client_id)
            .count()
            .get_result::<i64>(conn)
            .expect("count active client");
        assert_eq!(active_remaining, 1);
    }
}
