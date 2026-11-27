use super::*;

#[test]
fn client_binding_does_not_advance_last_seen() {
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
        recent_writes: Arc::new(DashMap::new()),
        pending: Mutex::new(buffered::Pending::default()),
        activity_flush_lock: Mutex::new(()),
        last_seen: last_seen.clone(),
    };
    let before = Utc::now().naive_utc();
    let previous = before - chrono::Duration::minutes(3);
    last_seen.record_end(17, previous);
    service.recent_writes.insert(
        "client".into(),
        Arc::new(Mutex::new(Some(CachedActivity {
            last_written_at: Some(Instant::now()),
            last_observed_at: Instant::now(),
            uid: 17,
            day: before.date(),
            last_app_version: None,
        }))),
    );

    service.record_activity(17, "client", None).unwrap();

    assert_eq!(last_seen.latest(17, None), Some(previous));
}

#[test]
fn binding_failure_does_not_record_last_seen() {
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
        recent_writes: Arc::new(DashMap::new()),
        pending: Mutex::new(buffered::Pending::default()),
        activity_flush_lock: Mutex::new(()),
        last_seen: last_seen.clone(),
    };

    assert!(service.record_activity(17, "client", None).is_err());

    assert_eq!(last_seen.latest(17, None), None);
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
fn automation_credentials_are_excluded_from_client_tracking() {
    use axum::http::{header::AUTHORIZATION, HeaderValue};

    let mut headers = HeaderMap::new();
    // Header eligibility remains shared by HTTP and the deferred legacy
    // WebSocket path; RPC never uses it after first-frame selection.
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
fn only_real_websocket_upgrades_defer_header_authentication_and_activity() {
    use axum::http::{HeaderValue, Method};

    let mut headers = HeaderMap::new();
    assert!(!is_websocket_upgrade_request(&Method::GET, "/ws", &headers));
    headers.insert(UPGRADE, HeaderValue::from_static("websocket"));
    headers.insert(CONNECTION, HeaderValue::from_static("keep-alive, Upgrade"));
    assert!(!is_websocket_upgrade_request(&Method::GET, "/ws", &headers));
    headers.insert(SEC_WEBSOCKET_KEY, HeaderValue::from_static("test-key"));
    headers.insert(SEC_WEBSOCKET_VERSION, HeaderValue::from_static("13"));

    assert!(is_websocket_upgrade_request(&Method::GET, "/ws", &headers));
    assert!(is_websocket_upgrade_request(&Method::GET, "/ws/", &headers));
    assert!(!is_websocket_upgrade_request(
        &Method::POST,
        "/ws",
        &headers
    ));
    assert!(!is_websocket_upgrade_request(
        &Method::GET,
        "/ws/ticket",
        &headers
    ));
    assert!(!is_websocket_upgrade_request(
        &Method::GET,
        "/ws/clients",
        &headers
    ));
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

#[test]
fn app_version_snapshot_tracks_active_clients_and_preserves_last_success() {
    use diesel::connection::SimpleConnection;

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
    let mut conn = pool.get().expect("test connection");
    let query_registry = prometheus::Registry::new();
    crate::metrics::queries::attach_connection_metrics(
        &mut conn,
        Arc::new(crate::metrics::queries::QueryMetrics::new(&query_registry)),
    );
    // Shadow the real table, so unrelated test data cannot affect the snapshot.
    conn.batch_execute(
        "CREATE TEMP TABLE clients (
                client_id varchar(64) PRIMARY KEY,
                last_active timestamp NOT NULL,
                last_active_uid integer NOT NULL,
                last_app_version text
            );
            INSERT INTO clients VALUES
                ('moving', '2026-03-21 12:00:00', 1, 'old'),
                ('boundary', '2026-03-20 12:00:00', 1, 'boundary'),
                ('expired', '2026-03-20 11:59:59.999999', 1, 'expired'),
                ('null', '2026-03-21 12:00:00', 1, NULL),
                ('empty', '2026-03-21 12:00:00', 1, ''),
                ('blank', '2026-03-21 12:00:00', 1, '   '),
                ('literal', '2026-03-21 12:00:00', 1, 'unknown');",
    )
    .expect("create isolated fixtures");
    let now = NaiveDate::from_ymd_opt(2026, 3, 21)
        .unwrap()
        .and_hms_opt(12, 0, 0)
        .unwrap();
    let registry = prometheus::Registry::new();
    let metrics = ClientTrackingMetrics::new(&registry);
    refresh_app_version_snapshot(&mut conn, &metrics, now).unwrap();
    let initial = active_app_version_snapshot(&mut conn, now).unwrap();
    assert_eq!(initial.get("unknown"), Some(&4));
    assert_eq!(initial.get("boundary"), Some(&1));
    assert_eq!(initial.get("old"), Some(&1));
    assert!(!initial.contains_key("expired"));

    // Repeated activity and a rebind update the same row; an upgrade moves it.
    conn.batch_execute(
        "UPDATE clients SET last_active_uid = 2, last_app_version = 'new'
             WHERE client_id = 'moving';
             UPDATE clients SET last_active = '2026-03-21 12:00:00'
             WHERE client_id = 'moving';",
    )
    .unwrap();
    refresh_app_version_snapshot(&mut conn, &metrics, now).unwrap();
    let rendered = crate::metrics::encode(&registry).unwrap();
    assert!(rendered.contains("app_version_active_clients{version=\"new\"} 1"));
    assert!(!rendered.contains("app_version_active_clients{version=\"old\"}"));
    assert!(rendered.contains("app_version_active_clients{version=\"unknown\"} 4"));

    // Advancing the clock removes expired series, including the last one.
    refresh_app_version_snapshot(&mut conn, &metrics, now + chrono::Duration::hours(25)).unwrap();
    assert!(!crate::metrics::encode(&registry)
        .unwrap()
        .contains("app_version_active_clients"));
    refresh_app_version_snapshot(&mut conn, &metrics, now).unwrap();
    let before_failure = crate::metrics::encode(&registry).unwrap();
    conn.batch_execute("ALTER TABLE clients RENAME COLUMN last_active TO unavailable")
        .unwrap();
    assert!(refresh_app_version_snapshot(&mut conn, &metrics, now).is_err());
    assert_eq!(crate::metrics::encode(&registry).unwrap(), before_failure);
    let query_metrics = crate::metrics::encode(&query_registry).unwrap();
    assert!(query_metrics
        .contains("app_version_aggregation_duration_seconds_count{outcome=\"success\"} 5"));
    assert!(query_metrics
        .contains("app_version_aggregation_duration_seconds_count{outcome=\"error\"} 1"));
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
        .connection_timeout(Duration::from_millis(100))
        .connection_customizer(Box::new(diesel::r2d2::TestCustomizer))
        .build(ConnectionManager::<PgConnection>::new(url))
        .expect("create test database pool");
    let metrics = Arc::new(ClientTrackingMetrics::new(&prometheus::Registry::new()));
    let service = ClientTrackingService {
        last_seen: Arc::new(LastSeen::new(pool.clone(), metrics.clone())),
        db: pool,
        metrics,
        recent_writes: Arc::new(DashMap::new()),
        pending: Mutex::new(buffered::Pending::default()),
        activity_flush_lock: Mutex::new(()),
    };

    service
        .record_activity(uid, &client_id, Some("1.0.0"))
        .expect("record initial app version");
    service
        .record_activity(uid, &client_id, None)
        .expect("record activity without app version");
    service.flush_pending_activity().unwrap();
    assert_eq!(
        service
            .last_app_versions(std::slice::from_ref(&client_id))
            .expect("load persisted app version")
            .get(&client_id)
            .cloned(),
        Some(Some("1.0.0".to_owned()))
    );

    let checked_out = service.db.get().unwrap();
    service
        .record_activity(uid, &client_id, Some("2.0.0"))
        .expect("record changed app version without waiting for throttle");
    drop(checked_out);
    service.flush_pending_activity().unwrap();
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
    service.flush_pending_activity().unwrap();
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
        Arc::new(DashMap::new()),
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
