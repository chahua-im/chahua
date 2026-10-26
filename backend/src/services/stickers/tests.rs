use super::*;
use crate::dto::stickers::{StickerPackDiscoveryQuery, StickerPackSort};
use crate::services::sticker_discovery::discover_packs;
use chrono::{DateTime, Utc};
use diesel::connection::SimpleConnection;

fn connection() -> Option<PgConnection> {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return None;
    };
    Some(PgConnection::establish(&url).expect("connect to test database"))
}

fn fixture() -> Option<PgConnection> {
    let mut conn = connection()?;
    // Session-local tables retain production types, defaults and CHECK constraints.
    conn.batch_execute(
        "CREATE TEMP TABLE sticker_packs (LIKE public.sticker_packs INCLUDING ALL);
         CREATE TEMP TABLE sticker_pack_stickers (LIKE public.sticker_pack_stickers INCLUDING ALL);
         CREATE TEMP TABLE user_sticker_pack_subscriptions (LIKE public.user_sticker_pack_subscriptions INCLUDING ALL);
         CREATE TEMP TABLE user_extra (LIKE public.user_extra INCLUDING ALL);
         CREATE TEMP TABLE user_favorite_stickers (LIKE public.user_favorite_stickers INCLUDING ALL);
         INSERT INTO sticker_packs (id, owner_uid, name, description, visibility) VALUES
             (10, 1, '猫猫日常', NULL, 'public'),
             (20, 1, 'DOG', '开心猫', 'public'),
             (30, 1, '猫%_\\', NULL, 'public'),
             (40, 1, '猫私有', NULL, 'private'),
             (50, 1, '猫空包', NULL, 'public'),
             (60, 1, '猫零订阅', NULL, 'public');
         INSERT INTO sticker_pack_stickers (pack_id, sticker_id) VALUES
             (10, 100), (20, 100), (30, 100), (40, 100), (60, 100);
         INSERT INTO user_sticker_pack_subscriptions (uid, pack_id, subscribed_at) VALUES
             (1, 10, '2026-10-26T08:00:00Z'),
             (2, 10, '2026-09-01T08:00:00Z'),
             (3, 10, '2026-09-26T07:59:59Z'),
             (4, 10, '2026-09-26T08:00:00Z'),
             (1, 20, '2026-10-26T08:00:00Z'),
             (2, 20, '2026-10-26T08:00:00Z'),
             (3, 20, '2026-10-01T08:00:00Z'),
             (1, 30, '2026-10-26T08:00:00Z'),
             (2, 30, '2026-10-26T08:00:01Z'),
             (3, 30, '2026-10-26T08:00:00Z'),
             (4, 30, '2026-09-26T08:00:00Z'),
             (2, 40, '2026-10-26T08:00:00Z'),
             (2, 50, '2026-10-26T08:00:00Z'),
             (1, 60, '2026-10-26T08:00:00Z');",
    )
    .unwrap();
    Some(conn)
}

fn as_of() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-10-26T08:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}

fn query(
    q: Option<&str>,
    sort: StickerPackSort,
    limit: i64,
    offset: i64,
) -> StickerPackDiscoveryQuery {
    StickerPackDiscoveryQuery {
        q: q.map(str::to_owned),
        sort,
        limit,
        offset,
    }
}

#[test]
fn discovery_counts_exclude_owner_and_include_both_recent_boundaries() {
    let Some(mut conn) = fixture() else { return };
    let total = discover_packs(
        &mut conn,
        &query(None, StickerPackSort::Subscribers, 20, 0),
        as_of(),
    )
    .unwrap();
    assert_eq!(
        total
            .rows
            .iter()
            .map(|p| (p.pack_id, p.subscriber_count, p.recent_subscriber_count))
            .collect::<Vec<_>>(),
        [(30, 3, 2), (10, 3, 1), (20, 2, 2), (60, 0, 0)]
    );
    assert_eq!(total.stats_updated_at, as_of());
    assert!(!total.has_more);
    let trending = discover_packs(
        &mut conn,
        &query(None, StickerPackSort::Trending, 20, 0),
        as_of(),
    )
    .unwrap();
    assert_eq!(
        trending.rows.iter().map(|p| p.pack_id).collect::<Vec<_>>(),
        [30, 20, 10, 60]
    );
}

#[test]
fn discovery_search_matches_chinese_description_case_and_literal_wildcards() {
    let Some(mut conn) = fixture() else { return };
    for (q, expected) in [
        ("猫", vec![30, 20, 10, 60]),
        ("开心", vec![20]),
        ("dog", vec![20]),
        ("  DOG  ", vec![20]),
        ("%_\\", vec![30]),
        ("私有", vec![]),
        ("空包", vec![]),
        ("不存在", vec![]),
        ("   ", vec![30, 20, 10, 60]),
    ] {
        let result = discover_packs(
            &mut conn,
            &query(Some(q), StickerPackSort::Trending, 20, 0),
            as_of(),
        )
        .unwrap();
        assert_eq!(
            result.rows.iter().map(|p| p.pack_id).collect::<Vec<_>>(),
            expected,
            "query: {q:?}"
        );
    }
}

#[test]
fn discovery_pagination_and_privacy_filter_happen_before_limit() {
    let Some(mut conn) = fixture() else { return };
    for (offset, expected, more) in [
        (0, vec![30, 20], true),
        (2, vec![10, 60], false),
        (4, vec![], false),
    ] {
        let result = discover_packs(
            &mut conn,
            &query(None, StickerPackSort::Trending, 2, offset),
            as_of(),
        )
        .unwrap();
        assert_eq!(
            result.rows.iter().map(|p| p.pack_id).collect::<Vec<_>>(),
            expected
        );
        assert_eq!(result.has_more, more);
    }
    conn.batch_execute("UPDATE sticker_packs SET visibility = 'private' WHERE id = 30")
        .unwrap();
    let result = discover_packs(
        &mut conn,
        &query(None, StickerPackSort::Trending, 2, 0),
        as_of(),
    )
    .unwrap();
    assert_eq!(
        result.rows.iter().map(|p| p.pack_id).collect::<Vec<_>>(),
        [20, 10]
    );
    assert!(result.has_more);
}

fn visibility_update(
    visibility: crate::models::StickerPackVisibility,
) -> crate::models::UpdateStickerPack {
    crate::models::UpdateStickerPack {
        name: None,
        description: None,
        visibility: Some(visibility),
        updated_at: Utc::now(),
    }
}

fn order_ids(conn: &mut PgConnection, uid: i32) -> Vec<String> {
    let value: serde_json::Value = crate::schema::user_extra::table
        .find(uid)
        .select(crate::schema::user_extra::sticker_pack_order)
        .first(conn)
        .unwrap();
    serde_json::from_value::<Vec<crate::dto::users::StickerPackOrderItem>>(value)
        .unwrap()
        .into_iter()
        .map(|item| item.sticker_pack_id)
        .collect()
}

#[test]
fn private_packs_are_author_only_but_single_sticker_associations_remain_usable() {
    let Some(mut conn) = fixture() else { return };
    assert!(visible_pack(&mut conn, 1, 40).is_ok());
    assert!(matches!(
        visible_pack(&mut conn, 2, 40),
        Err(AppError::NotFound(_))
    ));
    assert!(matches!(
        subscribe(&mut conn, 2, 40),
        Err(AppError::NotFound(_))
    ));
    assert!(subscribe(&mut conn, 1, 40).is_ok());
    let associated = packs_for_sticker(&mut conn, 2, 100).unwrap();
    assert_eq!(associated.len(), 4);
    assert!(!associated.iter().any(|pack| pack.id == 40));
    assert!(packs_for_sticker(&mut conn, 1, 100)
        .unwrap()
        .iter()
        .any(|pack| pack.id == 40));
    assert!(!subscribed_packs(&mut conn, 2)
        .unwrap()
        .iter()
        .any(|pack| pack.id == 40));
    assert!(subscribed_packs(&mut conn, 1)
        .unwrap()
        .iter()
        .any(|pack| pack.id == 40));
    assert!(matches!(
        update_pack(
            &mut conn,
            2,
            40,
            visibility_update(crate::models::StickerPackVisibility::Public)
        ),
        Err(AppError::Forbidden(_))
    ));
}

#[test]
fn privatization_removes_other_subscriptions_and_order_but_keeps_favorites() {
    let Some(mut conn) = fixture() else { return };
    subscribe(&mut conn, 1, 10).unwrap();
    subscribe(&mut conn, 2, 10).unwrap();
    subscribe(&mut conn, 2, 20).unwrap();
    conn.batch_execute("INSERT INTO user_favorite_stickers (uid, sticker_id) VALUES (2, 100)")
        .unwrap();
    let change = update_pack(
        &mut conn,
        1,
        10,
        visibility_update(crate::models::StickerPackVisibility::Private),
    )
    .unwrap();
    assert_eq!(
        change.pack.visibility,
        crate::models::StickerPackVisibility::Private
    );
    assert!(change.orders.iter().any(|item| item.uid == 2));
    assert!(order_ids(&mut conn, 1).contains(&"10".to_owned()));
    assert_eq!(order_ids(&mut conn, 2), ["20"]);
    assert_eq!(
        crate::schema::user_sticker_pack_subscriptions::table
            .filter(crate::schema::user_sticker_pack_subscriptions::pack_id.eq(10))
            .select(crate::schema::user_sticker_pack_subscriptions::uid)
            .load::<i32>(&mut conn)
            .unwrap(),
        [1]
    );
    assert_eq!(
        crate::schema::user_favorite_stickers::table
            .count()
            .get_result::<i64>(&mut conn)
            .unwrap(),
        1
    );
    // Repeated privacy changes and cancellation are harmless. Reopening does not restore subscribers.
    update_pack(
        &mut conn,
        1,
        10,
        visibility_update(crate::models::StickerPackVisibility::Private),
    )
    .unwrap();
    unsubscribe(&mut conn, 2, 10).unwrap();
    update_pack(
        &mut conn,
        1,
        10,
        visibility_update(crate::models::StickerPackVisibility::Public),
    )
    .unwrap();
    assert_eq!(
        crate::schema::user_sticker_pack_subscriptions::table
            .filter(crate::schema::user_sticker_pack_subscriptions::pack_id.eq(10))
            .count()
            .get_result::<i64>(&mut conn)
            .unwrap(),
        1
    );
    assert!(matches!(
        unsubscribe(&mut conn, 1, 10),
        Err(AppError::BadRequest(_))
    ));
}

#[test]
fn subscriptions_preserve_time_until_removed_and_new_packs_default_public() {
    let Some(mut conn) = fixture() else { return };
    let existing: DateTime<Utc> = crate::schema::user_sticker_pack_subscriptions::table
        .find((2_i32, 10_i64))
        .select(crate::schema::user_sticker_pack_subscriptions::subscribed_at)
        .first(&mut conn)
        .unwrap();
    subscribe(&mut conn, 2, 10).unwrap();
    let repeated: DateTime<Utc> = crate::schema::user_sticker_pack_subscriptions::table
        .find((2_i32, 10_i64))
        .select(crate::schema::user_sticker_pack_subscriptions::subscribed_at)
        .first(&mut conn)
        .unwrap();
    assert_eq!(existing, repeated);
    unsubscribe(&mut conn, 2, 10).unwrap();
    subscribe(&mut conn, 2, 10).unwrap();
    let renewed: DateTime<Utc> = crate::schema::user_sticker_pack_subscriptions::table
        .find((2_i32, 10_i64))
        .select(crate::schema::user_sticker_pack_subscriptions::subscribed_at)
        .first(&mut conn)
        .unwrap();
    assert!(renewed > existing);
    conn.batch_execute("INSERT INTO sticker_packs (id, owner_uid, name) VALUES (70, 1, 'default')")
        .unwrap();
    assert_eq!(
        visible_pack(&mut conn, 1, 70).unwrap().visibility,
        crate::models::StickerPackVisibility::Public
    );
    assert!(visible_pack(&mut conn, 2, 70).is_ok());
    assert!(subscribe(&mut conn, 2, 70).is_ok());
}

#[test]
fn failed_privacy_transaction_preserves_visibility_subscription_and_order() {
    let Some(mut conn) = fixture() else { return };
    subscribe(&mut conn, 2, 10).unwrap();
    let result: Result<(), AppError> = conn.transaction(|conn| {
        update_pack(
            conn,
            1,
            10,
            visibility_update(crate::models::StickerPackVisibility::Private),
        )?;
        Err(AppError::BadRequest("force rollback"))
    });
    assert!(result.is_err());
    assert_eq!(
        visible_pack(&mut conn, 2, 10).unwrap().visibility,
        crate::models::StickerPackVisibility::Public
    );
    assert!(order_ids(&mut conn, 2).contains(&"10".to_owned()));
    assert!(subscribed_packs(&mut conn, 2)
        .unwrap()
        .iter()
        .any(|pack| pack.id == 10));
}

fn order_item(pack_id: i64) -> crate::dto::users::UpdateStickerPackOrderItem {
    crate::dto::users::UpdateStickerPackOrderItem {
        sticker_pack_id: pack_id.to_string(),
        last_used_on: 1_700_000_000_000,
        is_auto_sort: None,
    }
}

#[test]
fn stale_order_requests_cannot_restore_a_privatized_pack() {
    let Some(mut conn) = fixture() else { return };
    subscribe(&mut conn, 2, 10).unwrap();
    subscribe(&mut conn, 2, 20).unwrap();
    update_pack(
        &mut conn,
        1,
        10,
        visibility_update(crate::models::StickerPackVisibility::Private),
    )
    .unwrap();
    let order = crate::services::sticker_order::update_order(
        &mut conn,
        2,
        vec![order_item(10), order_item(20)],
    )
    .unwrap();
    assert_eq!(
        order
            .iter()
            .map(|item| item.sticker_pack_id.as_str())
            .collect::<Vec<_>>(),
        ["20"]
    );
}

struct SharedFixture {
    schema: String,
    admin: PgConnection,
}

impl SharedFixture {
    fn new() -> Option<Self> {
        let mut admin = connection()?;
        let schema = format!("sticker_test_{}", uuid::Uuid::new_v4().simple());
        admin.batch_execute(&format!(
            "CREATE SCHEMA {schema};
             CREATE TABLE {schema}.sticker_packs (LIKE public.sticker_packs INCLUDING ALL);
             CREATE TABLE {schema}.user_sticker_pack_subscriptions (LIKE public.user_sticker_pack_subscriptions INCLUDING ALL);
             CREATE TABLE {schema}.user_extra (LIKE public.user_extra INCLUDING ALL);
             INSERT INTO {schema}.sticker_packs (id, owner_uid, name, visibility) VALUES
                 (1, 1, 'race', 'public'), (2, 1, 'unrelated', 'public');
             INSERT INTO {schema}.user_sticker_pack_subscriptions (uid, pack_id) VALUES
                 (1, 1), (1, 2), (2, 2);"
        )).unwrap();
        Some(Self { schema, admin })
    }

    fn connect(&self) -> PgConnection {
        shared_connection(&self.schema)
    }

    fn wait_until_blocked(&mut self, pid: i32) {
        #[derive(QueryableByName)]
        struct Blocked {
            #[diesel(sql_type = diesel::sql_types::Bool)]
            blocked: bool,
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let state =
                diesel::sql_query("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked")
                    .bind::<diesel::sql_types::Integer, _>(pid)
                    .get_result::<Blocked>(&mut self.admin)
                    .unwrap();
            if state.blocked {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "worker did not block on the transaction lock"
            );
            std::thread::yield_now();
        }
    }
}

impl Drop for SharedFixture {
    fn drop(&mut self) {
        let _ = self
            .admin
            .batch_execute(&format!("DROP SCHEMA {} CASCADE", self.schema));
    }
}

fn shared_connection(schema: &str) -> PgConnection {
    let mut conn = connection().unwrap();
    conn.batch_execute(&format!(
        "SET search_path = {schema}, public; SET statement_timeout = '10s'"
    ))
    .unwrap();
    conn
}

fn backend_pid(conn: &mut PgConnection) -> i32 {
    #[derive(QueryableByName)]
    struct Pid {
        #[diesel(sql_type = diesel::sql_types::Integer)]
        pid: i32,
    }
    diesel::sql_query("SELECT pg_backend_pid() AS pid")
        .get_result::<Pid>(conn)
        .unwrap()
        .pid
}

#[test]
fn subscription_and_privacy_transactions_serialize_in_both_orders() {
    for private_first in [false, true] {
        let Some(mut fixture) = SharedFixture::new() else {
            return;
        };
        let mut holder = fixture.connect();
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let schema = fixture.schema.clone();
        let mut worker = None;
        holder
            .transaction::<_, AppError, _>(|conn| {
                if private_first {
                    update_pack(
                        conn,
                        1,
                        1,
                        visibility_update(crate::models::StickerPackVisibility::Private),
                    )?;
                } else {
                    subscribe(conn, 2, 1)?;
                }
                worker = Some(std::thread::spawn(move || {
                    let mut other = shared_connection(&schema);
                    ready_tx.send(backend_pid(&mut other)).unwrap();
                    if private_first {
                        assert!(matches!(
                            subscribe(&mut other, 2, 1),
                            Err(AppError::NotFound(_))
                        ));
                    } else {
                        update_pack(
                            &mut other,
                            1,
                            1,
                            visibility_update(crate::models::StickerPackVisibility::Private),
                        )
                        .unwrap();
                    }
                }));
                let pid = ready_rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                fixture.wait_until_blocked(pid);
                Ok(())
            })
            .unwrap();
        worker.unwrap().join().unwrap();
        assert!(matches!(
            visible_pack(&mut holder, 2, 1),
            Err(AppError::NotFound(_))
        ));
        let count = crate::schema::user_sticker_pack_subscriptions::table
            .find((2_i32, 1_i64))
            .count()
            .get_result::<i64>(&mut holder)
            .unwrap();
        assert_eq!(count, 0);
        let orders = crate::schema::user_extra::table
            .find(2)
            .select(crate::schema::user_extra::sticker_pack_order)
            .first::<serde_json::Value>(&mut holder)
            .optional()
            .unwrap();
        if let Some(orders) = orders {
            assert!(!orders
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["stickerPackId"] == "1"));
        }
    }
}

#[test]
fn order_and_privacy_transactions_serialize_in_both_orders() {
    for private_first in [false, true] {
        let Some(mut fixture) = SharedFixture::new() else {
            return;
        };
        let mut holder = fixture.connect();
        subscribe(&mut holder, 2, 1).unwrap();
        subscribe(&mut holder, 2, 2).unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let schema = fixture.schema.clone();
        let mut worker = None;
        holder
            .transaction::<_, AppError, _>(|conn| {
                if private_first {
                    update_pack(
                        conn,
                        1,
                        1,
                        visibility_update(crate::models::StickerPackVisibility::Private),
                    )?;
                } else {
                    crate::services::sticker_order::update_order(
                        conn,
                        2,
                        vec![order_item(1), order_item(2)],
                    )?;
                }
                worker = Some(std::thread::spawn(move || {
                    let mut other = shared_connection(&schema);
                    ready_tx.send(backend_pid(&mut other)).unwrap();
                    if private_first {
                        crate::services::sticker_order::update_order(
                            &mut other,
                            2,
                            vec![order_item(1), order_item(2)],
                        )
                        .unwrap();
                    } else {
                        update_pack(
                            &mut other,
                            1,
                            1,
                            visibility_update(crate::models::StickerPackVisibility::Private),
                        )
                        .unwrap();
                    }
                }));
                fixture.wait_until_blocked(
                    ready_rx
                        .recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap(),
                );
                Ok(())
            })
            .unwrap();
        worker.unwrap().join().unwrap();
        assert_eq!(order_ids(&mut holder, 2), ["2"]);
        assert!(!subscribed_packs(&mut holder, 2)
            .unwrap()
            .iter()
            .any(|pack| pack.id == 1));
    }
}

#[test]
fn creating_and_deleting_a_pack_keep_subscription_and_order_consistent() {
    let Some(mut conn) = fixture() else { return };
    let now = Utc::now();
    let created = create_pack(
        &mut conn,
        crate::models::NewStickerPack {
            id: 70,
            owner_uid: 2,
            name: "new private pack".to_owned(),
            description: None,
            visibility: crate::models::StickerPackVisibility::Private,
            created_at: now,
            updated_at: now,
        },
    )
    .unwrap();
    assert_eq!(created.pack.id, 70);
    assert_eq!(
        created.pack.visibility,
        crate::models::StickerPackVisibility::Private
    );
    assert!(created
        .orders
        .iter()
        .any(|change| change.uid == 2
            && change.order.iter().any(|item| item.sticker_pack_id == "70")));
    assert!(subscribed_packs(&mut conn, 2)
        .unwrap()
        .iter()
        .any(|pack| pack.id == 70));
    assert!(matches!(
        subscribe(&mut conn, 3, 70),
        Err(AppError::NotFound(_))
    ));
    update_pack(
        &mut conn,
        2,
        70,
        visibility_update(crate::models::StickerPackVisibility::Public),
    )
    .unwrap();
    subscribe(&mut conn, 3, 70).unwrap();
    subscribe(&mut conn, 3, 20).unwrap();
    let orders = delete_pack(&mut conn, 2, 70).unwrap();
    assert!(orders.iter().any(|change| change.uid == 3));
    assert_eq!(order_ids(&mut conn, 3), ["20"]);
    assert!(matches!(
        visible_pack(&mut conn, 2, 70),
        Err(AppError::NotFound(_))
    ));
}

#[test]
fn visibility_migration_preserves_existing_public_packs_and_can_round_trip() {
    let Some(mut conn) = connection() else { return };
    conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
        let schema = format!("sticker_migration_{}", uuid::Uuid::new_v4().simple());
        conn.batch_execute(&format!(
            "CREATE SCHEMA {schema}; SET LOCAL search_path = {schema}, public;
             CREATE TABLE sticker_packs (id bigint PRIMARY KEY, name text NOT NULL);
             INSERT INTO sticker_packs (id, name) VALUES (1, 'existing');"
        ))?;
        let up = include_str!(
            "../../../migrations/2026-10-26-061844-0000_add_sticker_pack_visibility/up.sql"
        );
        let down = include_str!(
            "../../../migrations/2026-10-26-061844-0000_add_sticker_pack_visibility/down.sql"
        );
        conn.batch_execute(up)?;
        conn.batch_execute("INSERT INTO sticker_packs (id, name) VALUES (2, 'new')")?;
        conn.batch_execute(
            "INSERT INTO sticker_packs (id, name, visibility) VALUES (3, 'private', 'private')",
        )?;
        #[derive(QueryableByName)]
        struct Visibility {
            #[diesel(sql_type = diesel::sql_types::Text)]
            visibility: String,
        }
        let rows = diesel::sql_query("SELECT visibility::text FROM sticker_packs ORDER BY id")
            .load::<Visibility>(conn)?;
        assert_eq!(
            rows.iter()
                .map(|row| row.visibility.as_str())
                .collect::<Vec<_>>(),
            ["public", "public", "private"]
        );
        conn.batch_execute(down)?;
        conn.batch_execute(up)?;
        let rows = diesel::sql_query("SELECT visibility::text FROM sticker_packs ORDER BY id")
            .load::<Visibility>(conn)?;
        // A rollback removes privacy information; reapplying treats all as existing packs.
        assert_eq!(
            rows.iter()
                .map(|row| row.visibility.as_str())
                .collect::<Vec<_>>(),
            ["public", "public", "public"]
        );
        Ok(())
    });
}

#[test]
fn bulk_order_revocation_crosses_batches_and_preserves_other_preferences() {
    let Some(mut conn) = fixture() else { return };
    conn.batch_execute(
        r#"INSERT INTO user_extra (uid, first_seen_at, last_seen_at, token_gen, mute_group_chats_by_default, sticker_pack_order)
           VALUES
               (1, '2020-01-01', '2020-02-01', 11, TRUE, '[{"stickerPackId":"10","lastUsedOn":123}]'),
               (2, '2020-01-01', '2020-02-01', 17, TRUE, '[{"stickerPackId":"20","lastUsedOn":456},{"stickerPackId":"10","lastUsedOn":123}]');"#,
    ).unwrap();
    let mut uids: Vec<i32> = (2..=1003).rev().collect();
    uids.push(2);
    let updates = conn
        .transaction::<_, AppError, _>(|conn| {
            crate::services::sticker_order::remove_pack(conn, &uids, 10)
        })
        .unwrap();
    assert_eq!(updates.len(), 1002);
    assert_eq!(updates.first().unwrap().0, 2);
    assert_eq!(updates.last().unwrap().0, 1003);
    assert_eq!(order_ids(&mut conn, 2), ["20"]);
    assert_eq!(order_ids(&mut conn, 1), ["10"]);
    let extra = crate::schema::user_extra::table
        .find(2)
        .select(crate::models::UserExtra::as_select())
        .first::<crate::models::UserExtra>(&mut conn)
        .unwrap();
    assert_eq!(extra.token_gen, 17);
    assert!(extra.mute_group_chats_by_default);
    assert_eq!(extra.first_seen_at.to_string(), "2020-01-01 00:00:00");
    assert_eq!(extra.last_seen_at.to_string(), "2020-02-01 00:00:00");
    assert!(updates.iter().skip(1).all(|(_, order)| order.is_empty()));
}

#[test]
fn subscription_pack_index_migration_can_round_trip() {
    let Some(mut conn) = connection() else { return };
    conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
        let schema = format!("sticker_index_{}", uuid::Uuid::new_v4().simple());
        conn.batch_execute(&format!(
            "CREATE SCHEMA {schema}; SET LOCAL search_path = {schema}, public;
             CREATE TABLE user_sticker_pack_subscriptions (uid integer, pack_id bigint, subscribed_at timestamptz);"
        ))?;
        let up = include_str!("../../../migrations/2026-10-26-062114-0000_add_sticker_subscription_pack_index/up.sql");
        let down = include_str!("../../../migrations/2026-10-26-062114-0000_add_sticker_subscription_pack_index/down.sql");
        conn.batch_execute(up)?;
        conn.batch_execute(down)?;
        conn.batch_execute(up)?;
        #[derive(QueryableByName)]
        struct Index {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            count: i64,
        }
        let index = diesel::sql_query("SELECT count(*) FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_user_sticker_pack_subscriptions_pack_subscribed_at'")
            .bind::<diesel::sql_types::Text, _>(&schema).get_result::<Index>(conn)?;
        assert_eq!(index.count, 1);
        Ok(())
    });
}
