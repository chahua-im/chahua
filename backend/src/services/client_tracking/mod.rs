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
    ActivityDailyMetric, ClientRecord, FriendAddVerificationMode, NewActivityDailyMetric,
    NewClientRecord, NewUserExtra, UserExtra,
};
use crate::schema::{activity_daily_metrics, clients, push_subscriptions, user_extra};
use crate::utils::auth::{extract_auth_context, X_APP_VERSION, X_ON_BEHALF_OF};

const ACTIVITY_WRITE_THROTTLE: Duration = Duration::from_secs(5 * 60);
const PURGE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const PURGE_RESTART_DELAY: Duration = Duration::from_secs(1);
const STALE_CLIENT_RETENTION_DAYS: u64 = 45;
const WS_UPGRADE_PATHS: [&str; 2] = ["/ws", "/ws/"];

#[derive(Clone)]
struct CachedActivity {
    last_written_at: Instant,
    uid: i32,
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

pub struct ClientTrackingService {
    db: Pool<ConnectionManager<PgConnection>>,
    metrics: Arc<ClientTrackingMetrics>,
    recent_writes: DashMap<String, CachedActivity>,
}

impl ClientTrackingService {
    pub fn start(
        db: Pool<ConnectionManager<PgConnection>>,
        metrics: Arc<ClientTrackingMetrics>,
    ) -> Arc<Self> {
        let service = Arc::new(Self {
            db,
            metrics,
            recent_writes: DashMap::new(),
        });

        if let Err(error) = service.refresh_today_metrics_gauges() {
            warn!(
                "client tracking: failed to initialize today's activity gauges: {}",
                error
            );
        }

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
        if let Some(entry) = self.recent_writes.get(client_id) {
            let app_version_changed = app_version
                .is_some_and(|version| entry.last_app_version.as_deref() != Some(version));
            if entry.uid == uid
                && !app_version_changed
                && entry.last_written_at.elapsed() < ACTIVITY_WRITE_THROTTLE
            {
                self.metrics.record_activity_write_skipped("throttled");
                return Ok(());
            }
        }

        let now = Utc::now().naive_utc();
        let today = now.date();
        let conn = &mut self.db.get().map_err(|e| {
            error!("client tracking: failed to get DB connection: {:?}", e);
            self.metrics.record_activity_write("error");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Database connection failed",
            )
        })?;

        let recorded_app_version = conn
            .transaction::<Option<String>, diesel::result::Error, _>(|conn| {
                let existing_client = clients::table
                    .find(client_id)
                    .select(ClientRecord::as_select())
                    .first::<ClientRecord>(conn)
                    .optional()?;
                let existing_user = user_extra::table
                    .find(uid)
                    .select(UserExtra::as_select())
                    .first::<UserExtra>(conn)
                    .optional()?;

                let active_client_delta = i64::from(
                    existing_client
                        .as_ref()
                        .is_none_or(|client| client.last_active.date() != today),
                );
                let new_client_delta = i64::from(existing_client.is_none());
                let active_user_delta = i64::from(
                    existing_user
                        .as_ref()
                        .is_none_or(|user| user.last_seen_at.date() != today),
                );
                let new_user_delta = i64::from(existing_user.is_none());
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

                let new_user = NewUserExtra {
                    uid,
                    first_seen_at: existing_user
                        .as_ref()
                        .map_or(now, |user| user.first_seen_at),
                    last_seen_at: now,
                    sticker_pack_order: existing_user
                        .as_ref()
                        .map_or(serde_json::json!([]), |u| u.sticker_pack_order.clone()),
                    verification_mode: FriendAddVerificationMode::Direct,
                    verification_question: None,
                };

                diesel::insert_into(user_extra::table)
                    .values(&new_user)
                    .on_conflict(user_extra::uid)
                    .do_update()
                    .set(user_extra::last_seen_at.eq(now))
                    .execute(conn)?;

                self.upsert_daily_metrics(
                    conn,
                    DailyMetricDelta {
                        day: today,
                        active_users: active_user_delta,
                        new_users: new_user_delta,
                        active_clients: active_client_delta,
                        new_clients: new_client_delta,
                        client_rebinds: rebind_delta,
                        stale_clients_purged: 0,
                        legacy_subscriptions_purged: 0,
                    },
                    now,
                )?;

                Ok(last_app_version)
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
        self.recent_writes.insert(
            client_id.to_string(),
            CachedActivity {
                last_written_at: Instant::now(),
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
        loop {
            interval.tick().await;
            if let Err(error) = self.purge_stale_subscriptions() {
                warn!("client tracking purge failed: {}", error);
            }
        }
    }

    fn purge_stale_subscriptions(&self) -> Result<(), String> {
        let now = Utc::now().naive_utc();
        let today = now.date();
        let stale_cutoff = now
            .checked_sub_days(Days::new(STALE_CLIENT_RETENTION_DAYS))
            .ok_or_else(|| "failed to compute stale client cutoff".to_string())?;

        let conn = &mut self
            .db
            .get()
            .map_err(|e| format!("failed to get DB connection: {:?}", e))?;

        let stale_client_ids: Vec<String> = clients::table
            .filter(clients::last_active.lt(stale_cutoff))
            .select(clients::client_id)
            .load(conn)
            .map_err(|e| format!("failed to load stale client ids: {:?}", e))?;

        let mut deleted_subscriptions = 0;
        let mut deleted_clients = 0;

        if !stale_client_ids.is_empty() {
            deleted_subscriptions += diesel::delete(
                push_subscriptions::table
                    .filter(push_subscriptions::client_id.eq_any(&stale_client_ids)),
            )
            .execute(conn)
            .map_err(|e| format!("failed to delete stale subscriptions: {:?}", e))?;

            deleted_clients =
                diesel::delete(clients::table.filter(clients::client_id.eq_any(&stale_client_ids)))
                    .execute(conn)
                    .map_err(|e| format!("failed to delete stale clients: {:?}", e))?;

            for client_id in &stale_client_ids {
                self.recent_writes.remove(client_id);
            }
        }

        self.upsert_daily_metrics(
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
        )
        .map_err(|e| format!("failed to update daily purge metrics: {:?}", e))?;

        if deleted_clients > 0 {
            self.metrics
                .record_purge("stale_clients", deleted_clients as u64);
        }

        if deleted_subscriptions > 0 || deleted_clients > 0 {
            info!(
                "client tracking purge removed {} push subscriptions and {} clients",
                deleted_subscriptions, deleted_clients
            );
        }

        Ok(())
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
        &self,
        conn: &mut PgConnection,
        delta: DailyMetricDelta,
        now: NaiveDateTime,
    ) -> Result<(), diesel::result::Error> {
        if delta.is_zero() {
            return Ok(());
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

        self.metrics.set_activity_today(
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
        );
        self.metrics.record_daily_rollup_update("success");
        if delta.client_rebinds > 0 {
            self.metrics.record_rebind();
        }
        Ok(())
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

fn should_record_client_activity(headers: &HeaderMap) -> bool {
    !headers.contains_key(X_ON_BEHALF_OF)
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
    fn delegated_requests_do_not_record_client_activity() {
        let mut headers = HeaderMap::new();
        assert!(should_record_client_activity(&headers));

        headers.insert(X_ON_BEHALF_OF, axum::http::HeaderValue::from_static("42"));
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
        let service = ClientTrackingService {
            db: pool,
            metrics: Arc::new(ClientTrackingMetrics::new(&prometheus::Registry::new())),
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
}
