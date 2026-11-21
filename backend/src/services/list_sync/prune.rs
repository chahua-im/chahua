use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use diesel::{prelude::*, sql_types::Timestamptz};

use crate::{errors::AppError, schema::list_sync_meta as meta, state::DbPool};

pub(crate) fn start_pruning(pool: DbPool, retention_days: u32) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3600));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let pool = pool.clone();
            match tokio::task::spawn_blocking(move || prune(&pool, retention_days)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => tracing::error!(?error, "list sync pruning failed"),
                Err(error) => tracing::error!(?error, "list sync pruning worker failed"),
            }
        }
    });
}

fn prune(pool: &DbPool, retention_days: u32) -> Result<(), AppError> {
    let mut conn = pool.get()?;
    let now: DateTime<Utc> = diesel::select(diesel::dsl::sql::<Timestamptz>("clock_timestamp()"))
        .get_result(&mut conn)?;
    prune_before(&mut conn, now - TimeDelta::days(i64::from(retention_days)))?;
    Ok(())
}

pub(super) fn prune_before(conn: &mut PgConnection, cutoff: DateTime<Utc>) -> QueryResult<()> {
    conn.transaction(|conn| {
        // Use the writer's singleton-first order. The delete and floor update
        // are one transaction, so a response snapshot sees both or neither.
        meta::table
            .filter(meta::singleton.eq(true))
            .select(meta::head)
            .for_update()
            .first::<i64>(conn)?;
        // The partial removal index bounds the age lookup. Check final live
        // membership/subscription too; never prune a key that became live again.
        diesel::sql_query(
            "WITH removed AS (
                DELETE FROM list_sync_personal p
                WHERE p.removed AND p.recorded_at < $1
                  AND NOT EXISTS (
                    SELECT 1 FROM group_membership gm
                    WHERE gm.uid = p.uid AND gm.chat_id = p.chat_id
                      AND (p.thread_root_id = 0 OR EXISTS (
                        SELECT 1 FROM thread_user_states ts
                        WHERE ts.uid = p.uid AND ts.chat_id = p.chat_id
                          AND ts.thread_root_id = p.thread_root_id AND ts.subscribed
                      ))
                  )
                RETURNING p.seq
             )
             UPDATE list_sync_meta m SET retained_after = expired.through
             FROM (SELECT max(seq) AS through FROM removed) expired
             WHERE m.singleton AND m.retained_after < expired.through",
        )
        .bind::<Timestamptz, _>(cutoff)
        .execute(conn)?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::sync_test_support::SyncFixture;
    use diesel::{
        connection::SimpleConnection,
        sql_types::{BigInt, Bool},
    };

    #[derive(QueryableByName)]
    struct Counts {
        #[diesel(sql_type = BigInt)]
        removed: i64,
        #[diesel(sql_type = BigInt)]
        live: i64,
        #[diesel(sql_type = BigInt)]
        floor: i64,
        #[diesel(sql_type = Bool)]
        account_kept: bool,
    }

    #[test]
    fn list_sync_pruning_advances_only_to_deleted_removals_and_keeps_live_keys() {
        let Some(fixture) = SyncFixture::new() else {
            return;
        };
        let mut conn = fixture.connect();
        conn.batch_execute(
            "BEGIN;
             INSERT INTO groups(id,name) VALUES (1,'removed'),(2,'live');
             INSERT INTO group_membership(chat_id,uid) VALUES (1,1),(2,1);
             INSERT INTO user_extra(uid,first_seen_at,last_seen_at,mute_group_chats_by_default)
                 VALUES (1,now(),now(),true);
             COMMIT;
             BEGIN; DELETE FROM group_membership WHERE chat_id=1; COMMIT;
             UPDATE list_sync_personal SET recorded_at='2026-01-01 00:00:00+00';
             UPDATE list_sync_personal SET removed=true WHERE chat_id=2;",
        )
        .unwrap();
        let cutoff = DateTime::parse_from_rfc3339("2026-02-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        prune_before(&mut conn, cutoff).unwrap();
        let counts = diesel::sql_query(
            "SELECT (SELECT count(*) FROM list_sync_personal WHERE chat_id=1) AS removed,
                    (SELECT count(*) FROM list_sync_personal WHERE chat_id=2) AS live,
                    retained_after AS floor,
                    EXISTS(SELECT 1 FROM list_sync_account WHERE uid=1) AS account_kept
             FROM list_sync_meta",
        )
        .get_result::<Counts>(&mut conn)
        .unwrap();
        assert_eq!((counts.removed, counts.live, counts.floor), (0, 1, 2));
        assert!(counts.account_kept);
        conn.batch_execute(
            "BEGIN;
             INSERT INTO groups(id,name) VALUES (3,'boundary');
             INSERT INTO group_membership(chat_id,uid) VALUES (3,1);
             COMMIT;
             BEGIN; DELETE FROM group_membership WHERE chat_id=3; COMMIT;
             UPDATE list_sync_personal SET recorded_at='2026-02-01 00:00:00+00' WHERE chat_id=3;",
        )
        .unwrap();
        prune_before(&mut conn, cutoff).unwrap();
        let floor = meta::table
            .select(meta::retained_after)
            .first::<i64>(&mut conn)
            .unwrap();
        assert_eq!(floor, 2);
        prune_before(&mut conn, cutoff + TimeDelta::seconds(1)).unwrap();
        let floor = meta::table
            .select(meta::retained_after)
            .first::<i64>(&mut conn)
            .unwrap();
        assert_eq!(floor, 4);
    }
}
