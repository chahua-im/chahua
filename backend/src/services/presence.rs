use chrono::NaiveDateTime;
use diesel::prelude::*;

use crate::models::{FriendAddVerificationMode, NewUserExtra, PresenceVisibility, UserExtra};
use crate::schema::user_extra;
use crate::services::activity_metrics::{ActivityMetricsService, DailyMetricDelta};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresenceObservationCause {
    ActiveCheckpoint,
    ExplicitInactive,
    Disconnect,
    Prune,
}

/// Persist a trusted foreground observation and its user-level daily metrics.
///
/// `observed_at` must be a UTC naive timestamp. The transaction locks the user's
/// row so delayed observations cannot move the stored last-seen value backwards
/// or duplicate daily-user accounting.
pub fn record_presence_observation(
    conn: &mut PgConnection,
    daily_metrics: &ActivityMetricsService,
    uid: i32,
    observed_at: NaiveDateTime,
    _cause: PresenceObservationCause,
) -> QueryResult<NaiveDateTime> {
    conn.transaction(|conn| {
        let skeleton = NewUserExtra {
            uid,
            first_seen_at: observed_at,
            last_seen_at: None,
            presence_visibility: PresenceVisibility::Everyone,
            sticker_pack_order: serde_json::json!([]),
            verification_mode: FriendAddVerificationMode::Direct,
            verification_question: None,
        };
        diesel::insert_into(user_extra::table)
            .values(&skeleton)
            .on_conflict(user_extra::uid)
            .do_nothing()
            .execute(conn)?;

        let existing = user_extra::table
            .find(uid)
            .select(UserExtra::as_select())
            .for_update()
            .first::<UserExtra>(conn)?;

        if let Some(stored) = existing.last_seen_at {
            if observed_at <= stored {
                return Ok(stored);
            }
        }

        let is_new_user = existing.last_seen_at.is_none();
        let active_users = i64::from(
            existing
                .last_seen_at
                .is_none_or(|stored| stored.date() != observed_at.date()),
        );
        let updated_last_seen_at = diesel::update(user_extra::table.find(uid))
            .set((
                user_extra::last_seen_at.eq(Some(observed_at)),
                user_extra::first_seen_at.eq(if is_new_user {
                    observed_at
                } else {
                    existing.first_seen_at
                }),
            ))
            .returning(user_extra::last_seen_at)
            .get_result::<Option<NaiveDateTime>>(conn)?
            .expect("presence observation always writes last_seen_at");

        daily_metrics.upsert(
            conn,
            DailyMetricDelta {
                day: observed_at.date(),
                active_users,
                new_users: i64::from(is_new_user),
                active_clients: 0,
                new_clients: 0,
                client_rebinds: 0,
                stale_clients_purged: 0,
                legacy_subscriptions_purged: 0,
            },
            observed_at,
        )?;
        Ok(updated_last_seen_at)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ActivityDailyMetric;
    use crate::schema::activity_daily_metrics;
    use crate::services::client_tracking::ClientTrackingMetrics;
    use chrono::NaiveDate;
    use diesel::connection::SimpleConnection;
    use diesel::sql_types::{Bool, Text};
    use diesel::Connection;
    use prometheus::Registry;
    use std::sync::atomic::{AtomicI32, Ordering};
    use std::sync::Arc;

    #[derive(diesel::QueryableByName)]
    struct NullableColumn {
        #[diesel(sql_type = Text)]
        is_nullable: String,
    }

    #[derive(diesel::QueryableByName)]
    struct Exists {
        #[diesel(sql_type = Bool)]
        exists: bool,
    }

    #[derive(diesel::QueryableByName)]
    struct TimestampValue {
        #[diesel(sql_type = diesel::sql_types::Timestamp)]
        value: chrono::NaiveDateTime,
    }

    #[derive(diesel::QueryableByName)]
    struct TextValue {
        #[diesel(sql_type = Text)]
        value: String,
    }

    #[test]
    fn observation_causes_remain_distinct() {
        assert_ne!(
            PresenceObservationCause::ActiveCheckpoint,
            PresenceObservationCause::ExplicitInactive
        );
        assert_ne!(
            PresenceObservationCause::Disconnect,
            PresenceObservationCause::Prune
        );
    }

    /// Runs the presence migration down and up inside one PostgreSQL
    /// transaction. The rollback leaves a migrated shared test database exactly
    /// as it was; this still verifies the SQL's nullable/backfill/enum/default
    /// contract rather than merely inspecting the migration files.
    #[test]
    fn presence_visibility_migration_round_trips() {
        let mut db = match std::env::var("WETTY_TEST_DATABASE_URL") {
            Ok(_) => crate::test_support::TestDb::establish(),
            Err(_) => {
                eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
                return;
            }
        };
        let conn = db.conn();
        let down = include_str!(
            "../../migrations/2026-09-14-120116-0000_add_presence_visibility/down.sql"
        );
        let up =
            include_str!("../../migrations/2026-09-14-120116-0000_add_presence_visibility/up.sql");

        conn.test_transaction::<(), diesel::result::Error, _>(|conn| {
            let uid = 1_800_000_001;
            conn.batch_execute(&format!(
                "INSERT INTO user_extra (uid, first_seen_at, last_seen_at, presence_visibility, sticker_pack_order, verification_mode, token_gen) \
                 VALUES ({uid}, '2040-01-02 03:04:05', NULL, 'friends', '[]'::jsonb, 'direct', 0)"
            ))?;
            conn.batch_execute(down)?;

            let down_nullable = diesel::sql_query(
                "SELECT is_nullable FROM information_schema.columns \
                 WHERE table_schema = current_schema() AND table_name = 'user_extra' AND column_name = 'last_seen_at'",
            )
            .get_result::<NullableColumn>(conn)?;
            assert_eq!(down_nullable.is_nullable, "NO");
            let visibility_exists = diesel::sql_query(
                "SELECT EXISTS (SELECT 1 FROM information_schema.columns \
                 WHERE table_schema = current_schema() AND table_name = 'user_extra' AND column_name = 'presence_visibility') AS exists",
            )
            .get_result::<Exists>(conn)?;
            assert!(!visibility_exists.exists);
            let backfilled: chrono::NaiveDateTime = diesel::sql_query(format!(
                "SELECT last_seen_at AS value FROM user_extra WHERE uid = {uid}"
            ))
            .get_result::<TimestampValue>(conn)?
            .value;
            assert_eq!(backfilled, chrono::NaiveDate::from_ymd_opt(2040, 1, 2).unwrap().and_hms_opt(3, 4, 5).unwrap());

            conn.batch_execute(up)?;
            let up_nullable = diesel::sql_query(
                "SELECT is_nullable FROM information_schema.columns \
                 WHERE table_schema = current_schema() AND table_name = 'user_extra' AND column_name = 'last_seen_at'",
            )
            .get_result::<NullableColumn>(conn)?;
            assert_eq!(up_nullable.is_nullable, "YES");
            let default_visibility: String = diesel::sql_query(
                "SELECT column_default AS value FROM information_schema.columns \
                 WHERE table_schema = current_schema() AND table_name = 'user_extra' AND column_name = 'presence_visibility'",
            )
            .get_result::<TextValue>(conn)?
            .value;
            assert!(default_visibility.contains("everyone"));
            Ok(())
        });
    }

    /// Exercises the transaction against Postgres. Requires a migrated test
    /// database (`WETTY_TEST_DATABASE_URL`); skipped otherwise, and always
    /// rolls back its fixture rows and daily-metric changes.
    #[test]
    fn record_observation_is_monotonic_and_counts_utc_days_once() {
        let mut db = match std::env::var("WETTY_TEST_DATABASE_URL") {
            Ok(_) => crate::test_support::TestDb::establish(),
            Err(_) => {
                eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
                return;
            }
        };
        let conn = db.conn();
        let registry = Registry::new();
        let metrics = Arc::new(ClientTrackingMetrics::new(&registry));
        let daily_metrics = ActivityMetricsService::new(metrics);

        static NEXT_UID: AtomicI32 = AtomicI32::new(1_900_000_000);
        let uid = NEXT_UID.fetch_add(1, Ordering::SeqCst);
        let first = NaiveDate::from_ymd_opt(2040, 1, 1)
            .unwrap()
            .and_hms_opt(23, 59, 58)
            .unwrap();
        let current = first + chrono::TimeDelta::seconds(1);
        let old = first - chrono::TimeDelta::days(1);
        let next_utc_day = first + chrono::TimeDelta::seconds(3);

        conn.test_transaction::<(), diesel::result::Error, _>(|conn| {
            assert_eq!(
                record_presence_observation(
                    conn,
                    &daily_metrics,
                    uid,
                    first,
                    PresenceObservationCause::ActiveCheckpoint,
                )?,
                first
            );
            let extra = user_extra::table.find(uid).first::<UserExtra>(conn)?;
            assert_eq!(extra.first_seen_at, first);
            assert_eq!(extra.last_seen_at, Some(first));

            let first_day = activity_daily_metrics::table
                .find(first.date())
                .select(ActivityDailyMetric::as_select())
                .first::<ActivityDailyMetric>(conn)?;
            assert_eq!((first_day.active_users, first_day.new_users), (1, 1));

            // A current observation updates last-seen, but does not double-count
            // either DAU or new users on the same UTC date.
            assert_eq!(
                record_presence_observation(
                    conn,
                    &daily_metrics,
                    uid,
                    current,
                    PresenceObservationCause::ActiveCheckpoint,
                )?,
                current
            );
            let first_day = activity_daily_metrics::table
                .find(first.date())
                .select(ActivityDailyMetric::as_select())
                .first::<ActivityDailyMetric>(conn)?;
            assert_eq!((first_day.active_users, first_day.new_users), (1, 1));

            // A delayed observation never moves the stored UTC timestamp back
            // or records a metric for its past day.
            assert_eq!(
                record_presence_observation(
                    conn,
                    &daily_metrics,
                    uid,
                    old,
                    PresenceObservationCause::Disconnect,
                )?,
                current
            );
            assert!(activity_daily_metrics::table
                .find(old.date())
                .select(ActivityDailyMetric::as_select())
                .first::<ActivityDailyMetric>(conn)
                .optional()?
                .is_none());

            // Crossing midnight is based on the naive timestamp's UTC date:
            // it contributes one DAU on the new day but is not a new user.
            assert_eq!(
                record_presence_observation(
                    conn,
                    &daily_metrics,
                    uid,
                    next_utc_day,
                    PresenceObservationCause::ActiveCheckpoint,
                )?,
                next_utc_day
            );
            let second_day = activity_daily_metrics::table
                .find(next_utc_day.date())
                .select(ActivityDailyMetric::as_select())
                .first::<ActivityDailyMetric>(conn)?;
            assert_eq!((second_day.active_users, second_day.new_users), (1, 0));
            Ok(())
        });
    }

    /// Two connections observing the same uid on the same UTC date must count
    /// the user once: the `FOR UPDATE` row lock serializes the observations
    /// and the second one sees the day as already counted. Uses real
    /// (committed) connections, because two independent transactions must
    /// contend on the user_extra row lock; fixture rows are removed at the end.
    #[test]
    fn concurrent_same_day_observations_count_dau_once() {
        let url = match std::env::var("WETTY_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(_) => {
                eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
                return;
            }
        };
        // Serialize against other DB tests while preparing and asserting on
        // shared rows.
        let mut db = crate::test_support::TestDb::establish();
        let conn = db.conn();

        static SEQ: AtomicI32 = AtomicI32::new(2_100_000_000);
        let uid = SEQ.fetch_add(1, Ordering::SeqCst);
        let at = NaiveDate::from_ymd_opt(2040, 5, 5)
            .unwrap()
            .and_hms_opt(10, 0, 0)
            .unwrap();
        use diesel::RunQueryDsl;
        diesel::insert_into(user_extra::table)
            .values(&crate::models::NewUserExtra {
                uid,
                first_seen_at: at,
                last_seen_at: None,
                presence_visibility: crate::models::PresenceVisibility::Everyone,
                sticker_pack_order: serde_json::json!([]),
                verification_mode: crate::models::FriendAddVerificationMode::Direct,
                verification_question: None,
            })
            .execute(conn)
            .expect("seed user_extra row");

        let stored: Arc<std::sync::Mutex<Vec<chrono::NaiveDateTime>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let url = url.clone();
                let stored = stored.clone();
                std::thread::spawn(move || {
                    let mut conn =
                        diesel::PgConnection::establish(&url).expect("connect for observation");
                    let registry = prometheus::Registry::new();
                    let metrics = Arc::new(ClientTrackingMetrics::new(&registry));
                    let daily_metrics = ActivityMetricsService::new(metrics);
                    let stored_value = record_presence_observation(
                        &mut conn,
                        &daily_metrics,
                        uid,
                        at,
                        PresenceObservationCause::ActiveCheckpoint,
                    )
                    .expect("observation commits");
                    stored.lock().expect("stored lock").push(stored_value);
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("observation thread succeeds");
        }

        // Both observations commit, but the day is counted exactly once.
        let first_day = activity_daily_metrics::table
            .find(at.date())
            .select(ActivityDailyMetric::as_select())
            .first::<ActivityDailyMetric>(conn)
            .expect("metric row exists");
        assert_eq!(
            (first_day.active_users, first_day.new_users),
            (1, 1),
            "two concurrent same-day observations must count the user once"
        );
        let all_stored = stored.lock().expect("stored lock").clone();
        assert!(all_stored.iter().all(|value| *value == at));

        // Cleanup the committed fixture rows.
        {
            use crate::schema::activity_daily_metrics::dsl as adm;
            use crate::schema::user_extra::dsl as ue;
            diesel::delete(adm::activity_daily_metrics.find(at.date()))
                .execute(conn)
                .expect("cleanup metric row");
            diesel::delete(ue::user_extra.find(uid))
                .execute(conn)
                .expect("cleanup user_extra row");
        }
    }

    /// Exercises `visible_presence_records` against Postgres: the missing-row
    /// default (everyone + null), the friend and block filters, and the
    /// viewer-nobody early return that must still resolve self.
    #[test]
    fn visible_presence_records_applies_defaults_friendship_and_blocks() {
        use crate::models::PresenceVisibility;
        use crate::schema::{blocks, friendships, user_extra};

        let mut db = match std::env::var("WETTY_TEST_DATABASE_URL") {
            Ok(_) => crate::test_support::TestDb::establish(),
            Err(_) => {
                eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
                return;
            }
        };
        let conn = db.conn();

        static SEQ: AtomicI32 = AtomicI32::new(2_000_000_000);
        let viewer = SEQ.fetch_add(1, Ordering::SeqCst);
        let friend = SEQ.fetch_add(1, Ordering::SeqCst);
        let restricted = SEQ.fetch_add(1, Ordering::SeqCst);
        let blocked = SEQ.fetch_add(1, Ordering::SeqCst);
        let no_row = SEQ.fetch_add(1, Ordering::SeqCst);

        conn.test_transaction::<(), diesel::result::Error, _>(|conn| {
            let seeded = |conn: &mut diesel::PgConnection,
                          uid: i32,
                          last_seen_at: Option<chrono::NaiveDateTime>,
                          visibility: PresenceVisibility| {
                diesel::insert_into(user_extra::table)
                    .values(&crate::models::NewUserExtra {
                        uid,
                        first_seen_at: last_seen_at.unwrap_or_default(),
                        last_seen_at,
                        presence_visibility: visibility,
                        sticker_pack_order: serde_json::json!([]),
                        verification_mode: crate::models::FriendAddVerificationMode::Direct,
                        verification_question: None,
                    })
                    .execute(conn)
            };
            let last_seen = NaiveDate::from_ymd_opt(2026, 9, 1)
                .unwrap()
                .and_hms_opt(8, 0, 0)
                .unwrap();
            seeded(conn, viewer, None, PresenceVisibility::Everyone)?;
            seeded(conn, friend, Some(last_seen), PresenceVisibility::Friends)?;
            seeded(
                conn,
                restricted,
                Some(last_seen),
                PresenceVisibility::Nobody,
            )?;
            seeded(conn, blocked, Some(last_seen), PresenceVisibility::Everyone)?;
            // `no_row` deliberately has no user_extra row.

            diesel::insert_into(friendships::table)
                .values((
                    friendships::uid1.eq(viewer.min(friend)),
                    friendships::uid2.eq(viewer.max(friend)),
                    friendships::initiated_by.eq(viewer),
                ))
                .execute(conn)?;
            diesel::insert_into(blocks::table)
                .values((
                    blocks::blocker_uid.eq(blocked),
                    blocks::blocked_uid.eq(viewer),
                ))
                .execute(conn)?;

            let records = crate::services::social::visible_presence_records(
                conn,
                viewer,
                &[friend, restricted, blocked, no_row, viewer],
            )?;

            // Friend, but target visibility is `friends`: visible with time.
            assert!(records.get(&friend).unwrap().visible);
            assert_eq!(records.get(&friend).unwrap().last_seen_at, Some(last_seen));
            // `restricted` allows only friends but is not one: hidden.
            assert!(!records.get(&restricted).unwrap().visible);
            assert_eq!(records.get(&restricted).unwrap().last_seen_at, None);
            // Blocked in one direction: hidden either way.
            assert!(!records.get(&blocked).unwrap().visible);
            // Missing user_extra row defaults to `everyone + null`: viewer
            // also allows everyone, so the non-friend is visible with a null
            // last seen.
            assert!(records.get(&no_row).unwrap().visible);
            assert_eq!(records.get(&no_row).unwrap().last_seen_at, None);
            // Self always sees its own (empty) presence.
            assert!(records.get(&viewer).unwrap().visible);

            // A missing row looks like `everyone` to a friend viewer: make the
            // no-row target a friend of viewer and expect visibility.
            diesel::insert_into(friendships::table)
                .values((
                    friendships::uid1.eq(viewer),
                    friendships::uid2.eq(no_row),
                    friendships::initiated_by.eq(viewer),
                ))
                .execute(conn)?;
            let records =
                crate::services::social::visible_presence_records(conn, viewer, &[no_row])?;
            assert!(records.get(&no_row).unwrap().visible);
            assert_eq!(records.get(&no_row).unwrap().last_seen_at, None);

            // Viewer `nobody` (here `restricted`): batch is hidden except
            // self, without consulting friendships or blocks.
            let records = crate::services::social::visible_presence_records(
                conn,
                restricted,
                &[viewer, blocked, restricted],
            )?;
            assert!(!records.get(&viewer).unwrap().visible);
            assert!(!records.get(&blocked).unwrap().visible);
            assert!(records.get(&restricted).unwrap().visible);

            Ok::<(), diesel::result::Error>(())
        });
    }
}
