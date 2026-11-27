use chrono::{DateTime, Utc};
use diesel::prelude::*;

use crate::models::{Message, MessageReaction};
use crate::schema::{group_membership, message_reactions, messages};

/// Call inside a transaction. Lock the author's membership before taking the
/// database timestamp, and hold it until the write or snapshot has completed.
/// This orders reaction inserts, snapshots and acknowledgements across servers.
/// A departed author has no unread state to synchronize.
pub(super) fn lock_scope(
    conn: &mut PgConnection,
    chat_id: i64,
    author_uid: i32,
) -> QueryResult<DateTime<Utc>> {
    group_membership::table
        .filter(group_membership::chat_id.eq(chat_id))
        .filter(group_membership::uid.eq(author_uid))
        .select(group_membership::uid)
        .for_update()
        .first::<i32>(conn)
        .optional()?;

    // Unlike NOW(), clock_timestamp() is evaluated after any lock wait rather
    // than at transaction start. The same database clock supplies read boundaries.
    diesel::select(diesel::dsl::sql::<diesel::sql_types::Timestamptz>(
        "clock_timestamp()",
    ))
    .get_result(conn)
}

pub fn insert_reaction(
    conn: &mut PgConnection,
    message: &Message,
    actor_uid: i32,
    emoji: String,
) -> QueryResult<usize> {
    conn.transaction(|conn| {
        // Match deletion's message-before-membership lock order. This UPDATE
        // takes NO KEY UPDATE, allowing concurrent foreign-key key-share locks.
        diesel::update(messages::table.filter(messages::id.eq(message.id)))
            .set(messages::has_reactions.eq(true))
            .execute(conn)?;
        let created_at = lock_scope(conn, message.chat_id, message.sender_uid)?;
        let inserted = diesel::insert_into(message_reactions::table)
            .values(&MessageReaction {
                message_id: message.id,
                user_uid: actor_uid,
                emoji,
                created_at,
                message_author_uid: message.sender_uid,
            })
            .on_conflict_do_nothing()
            .execute(conn)?;
        Ok(inserted)
    })
}

#[cfg(test)]
mod tests;
