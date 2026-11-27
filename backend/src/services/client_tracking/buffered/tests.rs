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
fn binding_preserves_metadata_without_counting_activity() {
    let Some(service) = fixture() else {
        return;
    };
    use crate::schema::{activity_daily_metrics, user_extra};
    service
        .record_activity(17, "new-user", Some("1.0"))
        .unwrap();
    service.flush_pending_activity().unwrap();
    assert_eq!(
        user_extra::table
            .find(17)
            .count()
            .get_result::<i64>(&mut service.db.get().unwrap())
            .unwrap(),
        0
    );
    let (active_users, active_clients, new_clients) = activity_daily_metrics::table
        .find(Utc::now().date_naive())
        .select((
            activity_daily_metrics::active_users,
            activity_daily_metrics::active_clients,
            activity_daily_metrics::new_clients,
        ))
        .first::<(i64, i64, i64)>(&mut service.db.get().unwrap())
        .unwrap();
    assert_eq!((active_users, active_clients, new_clients), (0, 0, 1));
    let (last_active, version) = clients::table
        .find("new-user")
        .select((clients::last_active, clients::last_app_version))
        .first::<(NaiveDateTime, Option<String>)>(&mut service.db.get().unwrap())
        .unwrap();
    assert_eq!(last_active, chrono::DateTime::UNIX_EPOCH.naive_utc());
    assert_eq!(version.as_deref(), Some("1.0"));
    service
        .record_client_activity(17, "new-user", None)
        .unwrap();
    service.flush_pending_activity().unwrap();
    let active_clients = activity_daily_metrics::table
        .find(Utc::now().date_naive())
        .select(activity_daily_metrics::active_clients)
        .first::<i64>(&mut service.db.get().unwrap())
        .unwrap();
    assert_eq!(active_clients, 1);
}
