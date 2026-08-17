mod metrics;
pub use metrics::{ActivityTodaySnapshot, ClientTrackingMetrics};

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::State,
    http::{Request, StatusCode},
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
use crate::utils::auth::{extract_auth_context, optional_client_id, X_APP_VERSION};

const ACTIVITY_WRITE_THROTTLE: Duration = Duration::from_secs(5 * 60);
const PURGE_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const PURGE_RESTART_DELAY: Duration = Duration::from_secs(1);
const STALE_CLIENT_RETENTION_DAYS: u64 = 45;
const WS_UPGRADE_PATHS: [&str; 2] = ["/ws", "/ws/"];

#[derive(Clone, Copy)]
struct CachedActivity {
    last_written_at: Instant,
    uid: i32,
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
    ) -> Result<(), (StatusCode, &'static str)> {
        if let Some(entry) = self.recent_writes.get(client_id) {
            if entry.uid == uid && entry.last_written_at.elapsed() < ACTIVITY_WRITE_THROTTLE {
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

        conn.transaction::<(), diesel::result::Error, _>(|conn| {
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

            let new_client = NewClientRecord {
                client_id: client_id.to_string(),
                created_at: existing_client
                    .as_ref()
                    .map_or(now, |client| client.created_at),
                last_active: now,
                last_active_uid: uid,
            };

            diesel::insert_into(clients::table)
                .values(&new_client)
                .on_conflict(clients::client_id)
                .do_update()
                .set((
                    clients::last_active.eq(now),
                    clients::last_active_uid.eq(uid),
                ))
                .execute(conn)?;

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

            Ok(())
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
            },
        );

        Ok(())
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
    let app_version = request
        .headers()
        .get(X_APP_VERSION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    let mut resolved_client_id: Option<String> = None;

    if let Ok(auth) = extract_auth_context(request.headers(), &state) {
        let client_id = auth
            .client_id
            .or_else(|| optional_client_id(request.headers()).ok().flatten());
        if let Some(client_id) = client_id {
            resolved_client_id = Some(client_id.clone());
            if let Err((status, message)) =
                state.client_tracking.record_activity(auth.uid, &client_id)
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
}
