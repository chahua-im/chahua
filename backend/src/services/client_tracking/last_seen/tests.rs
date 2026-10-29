use std::sync::Arc;

use chrono::{NaiveDate, NaiveDateTime};
use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::PgConnection;

use super::{ClientTrackingMetrics, LastSeen};
use crate::models::NewUserExtra;
use crate::schema::{activity_daily_metrics, user_extra};
use crate::state::DbPool;

fn timestamp(day: NaiveDate, hour: u32, minute: u32, second: u32) -> NaiveDateTime {
    day.and_hms_opt(hour, minute, second)
        .expect("valid test timestamp")
}

fn test_pool() -> Option<DbPool> {
    let url = match std::env::var("WETTY_TEST_DATABASE_URL") {
        Ok(url) => url,
        Err(_) => {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return None;
        }
    };

    Some(
        Pool::builder()
            .max_size(1)
            .connection_customizer(Box::new(diesel::r2d2::TestCustomizer))
            .build(ConnectionManager::<PgConnection>::new(url))
            .expect("create test database pool"),
    )
}

fn last_seen(pool: DbPool) -> LastSeen {
    LastSeen::new(
        pool,
        Arc::new(ClientTrackingMetrics::new(&prometheus::Registry::new())),
    )
}

fn create_activity_tables(pool: &DbPool) {
    pool.get()
        .expect("get test database connection")
        .batch_execute(
            "CREATE TEMP TABLE user_extra (LIKE public.user_extra INCLUDING ALL);
             CREATE TEMP TABLE activity_daily_metrics (LIKE public.activity_daily_metrics INCLUDING ALL);",
        )
        .expect("create isolated activity tables");
}

fn insert_user(pool: &DbPool, uid: i32, seen_at: NaiveDateTime) {
    diesel::insert_into(user_extra::table)
        .values(NewUserExtra::new(uid, seen_at))
        .execute(&mut pool.get().expect("get test database connection"))
        .expect("insert isolated user");
}

fn persisted_last_seen(pool: &DbPool, uid: i32) -> NaiveDateTime {
    user_extra::table
        .find(uid)
        .select(user_extra::last_seen_at)
        .first(&mut pool.get().expect("get test database connection"))
        .expect("load persisted last seen")
}

fn active_users(pool: &DbPool, day: NaiveDate) -> i64 {
    activity_daily_metrics::table
        .find(day)
        .select(activity_daily_metrics::active_users)
        .first(&mut pool.get().expect("get test database connection"))
        .expect("load daily active users")
}

#[test]
fn latest_immediately_prefers_buffered_activity_over_persisted_value() {
    let pool = DbPool::builder()
        .max_size(1)
        .min_idle(Some(0))
        .build_unchecked(ConnectionManager::<PgConnection>::new(
            "last_seen_test_invalid_option=value",
        ));
    let last_seen = last_seen(pool);
    let day = NaiveDate::from_ymd_opt(2026, 8, 12).expect("valid test day");
    let persisted = timestamp(day, 9, 0, 0);
    let observed = timestamp(day, 10, 0, 0);

    last_seen.record(17, observed);

    assert_eq!(last_seen.latest(17, Some(persisted)), Some(observed));
}

#[test]
fn stale_observations_do_not_replace_newer_buffered_activity() {
    let pool = DbPool::builder()
        .max_size(1)
        .min_idle(Some(0))
        .build_unchecked(ConnectionManager::<PgConnection>::new(
            "last_seen_test_invalid_option=value",
        ));
    let last_seen = last_seen(pool);
    let day = NaiveDate::from_ymd_opt(2026, 8, 12).expect("valid test day");
    let newer = timestamp(day, 10, 0, 0);

    last_seen.record(17, newer);
    last_seen.record(17, timestamp(day, 9, 0, 0));

    assert_eq!(last_seen.latest(17, None), Some(newer));
}

#[test]
fn acknowledging_in_flight_activity_keeps_newer_observations_pending() {
    let pool = DbPool::builder()
        .max_size(1)
        .min_idle(Some(0))
        .build_unchecked(ConnectionManager::<PgConnection>::new(
            "last_seen_test_invalid_option=value",
        ));
    let last_seen = last_seen(pool);
    let day = NaiveDate::from_ymd_opt(2026, 8, 12).unwrap();
    let original = timestamp(day, 10, 0, 0);
    let newer = timestamp(day, 10, 0, 1);
    last_seen.record(17, original);
    let batch = last_seen.snapshot();

    last_seen.record(17, newer);
    let persisted: Vec<_> = batch[&day].iter().map(|(uid, at)| (*uid, *at)).collect();
    last_seen.acknowledge(day, &persisted);

    assert_eq!(last_seen.latest(17, Some(original)), Some(newer));
    assert_eq!(last_seen.snapshot()[&day][&17], newer);
}

#[test]
fn flush_persists_multiple_users_and_daily_active_count() {
    let Some(pool) = test_pool() else {
        return;
    };
    create_activity_tables(&pool);
    let day = NaiveDate::from_ymd_opt(2026, 8, 12).expect("valid test day");
    let initial = timestamp(day.pred_opt().expect("previous test day"), 0, 0, 0);
    insert_user(&pool, 101, initial);
    insert_user(&pool, 102, initial);
    let last_seen = last_seen(pool.clone());
    let first = timestamp(day, 8, 30, 0);
    let second = timestamp(day, 18, 45, 0);

    last_seen.record(101, first);
    last_seen.record(102, second);
    last_seen.flush().expect("flush multiple users");

    assert_eq!(persisted_last_seen(&pool, 101), first);
    assert_eq!(persisted_last_seen(&pool, 102), second);
    assert_eq!(active_users(&pool, day), 2);
}

#[test]
fn stale_instance_flush_does_not_regress_persisted_activity() {
    let Some(pool) = test_pool() else {
        return;
    };
    create_activity_tables(&pool);
    let day = NaiveDate::from_ymd_opt(2026, 8, 12).expect("valid test day");
    let initial = timestamp(day.pred_opt().expect("previous test day"), 0, 0, 0);
    insert_user(&pool, 151, initial);
    let newer_instance = last_seen(pool.clone());
    let stale_instance = last_seen(pool.clone());
    let newer = timestamp(day, 10, 0, 0);

    newer_instance.record(151, newer);
    newer_instance.flush().expect("flush newer activity");
    stale_instance.record(151, timestamp(day, 9, 0, 0));
    stale_instance.flush().expect("flush stale activity");

    assert_eq!(persisted_last_seen(&pool, 151), newer);
    assert_eq!(active_users(&pool, day), 1);
}

#[test]
fn flush_preserves_activity_on_each_side_of_utc_midnight() {
    let Some(pool) = test_pool() else {
        return;
    };
    create_activity_tables(&pool);
    let previous_day = NaiveDate::from_ymd_opt(2026, 8, 12).expect("valid test day");
    let current_day = previous_day.succ_opt().expect("next test day");
    let initial = timestamp(
        previous_day.pred_opt().expect("preceding test day"),
        0,
        0,
        0,
    );
    insert_user(&pool, 201, initial);
    let last_seen = last_seen(pool.clone());
    let before_midnight = timestamp(previous_day, 23, 59, 59);
    let at_midnight = timestamp(current_day, 0, 0, 0);

    last_seen.record(201, before_midnight);
    last_seen.record(201, at_midnight);
    last_seen.flush().expect("flush midnight activity");

    assert_eq!(persisted_last_seen(&pool, 201), at_midnight);
    assert_eq!(active_users(&pool, previous_day), 1);
    assert_eq!(active_users(&pool, current_day), 1);
}

#[test]
fn failed_flush_retains_activity_until_a_newer_observation_can_persist() {
    let Some(pool) = test_pool() else {
        return;
    };
    pool.get()
        .expect("get test database connection")
        .batch_execute(
            "CREATE TEMP TABLE user_extra (
                LIKE public.user_extra INCLUDING ALL,
                CONSTRAINT test_last_seen_limit
                    CHECK (last_seen_at < TIMESTAMP '2026-08-12 10:00:00')
             );
             CREATE TEMP TABLE activity_daily_metrics (LIKE public.activity_daily_metrics INCLUDING ALL);",
        )
        .expect("create constrained isolated activity tables");
    let day = NaiveDate::from_ymd_opt(2026, 8, 12).expect("valid test day");
    let initial = timestamp(day.pred_opt().expect("previous test day"), 8, 0, 0);
    insert_user(&pool, 301, initial);
    let last_seen = last_seen(pool.clone());
    let rejected = timestamp(day, 10, 0, 0);
    let newer = timestamp(day, 11, 0, 0);

    last_seen.record(301, rejected);
    assert!(last_seen.flush().is_err());
    assert_eq!(last_seen.latest(301, Some(initial)), Some(rejected));

    pool.get()
        .expect("get test database connection")
        .batch_execute("ALTER TABLE user_extra DROP CONSTRAINT test_last_seen_limit;")
        .expect("remove test-only constraint");
    last_seen.record(301, newer);
    last_seen.flush().expect("flush retained newer activity");

    assert_eq!(persisted_last_seen(&pool, 301), newer);
    assert_eq!(active_users(&pool, day), 1);
}
