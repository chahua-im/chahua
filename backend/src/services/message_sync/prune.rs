use std::time::Duration;

use chrono::{DateTime, TimeDelta, Utc};
use diesel::{dsl::max, prelude::*, sql_types::Timestamptz};

use crate::{
    errors::AppError,
    schema::{message_sync_change as change, message_sync_head as head},
    state::DbPool,
};

pub fn start_pruning(pool: DbPool, retention_hours: u32) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3600));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let pool = pool.clone();
            match tokio::task::spawn_blocking(move || prune(&pool, retention_hours)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => tracing::error!(?error, "message sync pruning failed"),
                Err(error) => tracing::error!(?error, "message sync pruning worker failed"),
            }
        }
    });
}

fn prune(pool: &DbPool, retention_hours: u32) -> Result<(), AppError> {
    let mut conn = pool.get()?;
    let now: DateTime<Utc> = diesel::select(diesel::dsl::sql::<Timestamptz>("clock_timestamp()"))
        .get_result(&mut conn)?;
    let cutoff = now - TimeDelta::hours(i64::from(retention_hours));
    let chats = change::table
        .filter(change::recorded_at.lt(cutoff))
        .select(change::chat_id)
        .distinct()
        .load::<i64>(&mut conn)?;
    for chat_id in chats {
        prune_chat(&mut conn, chat_id, cutoff)?;
    }
    Ok(())
}

pub(super) fn prune_chat(
    conn: &mut PgConnection,
    chat_id: i64,
    cutoff: DateTime<Utc>,
) -> QueryResult<()> {
    conn.transaction(|conn| {
        let Some(head) = head::table
            .find(chat_id)
            .select(head::head)
            .for_update()
            .first::<i64>(conn)
            .optional()?
        else {
            return Ok(());
        };

        let changes = change::table.filter(change::chat_id.eq(chat_id));
        // A clock adjustment can make a newer sequence appear expired before
        // an older one. Prune only a contiguous prefix of fully expired sequences.
        let first_retained = changes
            .filter(change::recorded_at.ge(cutoff))
            .select(change::seq)
            .order(change::seq.asc())
            .first::<i64>(conn)
            .optional()?;
        let through = match first_retained {
            Some(seq) => changes
                .filter(change::seq.lt(seq))
                .select(max(change::seq))
                .get_result::<Option<i64>>(conn)?,
            None => Some(head),
        };
        if let Some(through) = through {
            diesel::delete(changes.filter(change::seq.le(through))).execute(conn)?;
            diesel::update(
                head::table
                    .find(chat_id)
                    .filter(head::retained_after.lt(through)),
            )
            .set(head::retained_after.eq(through))
            .execute(conn)?;
        }
        Ok(())
    })
}
