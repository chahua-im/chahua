use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::PgConnection;

use crate::errors::AppError;
use crate::schema::{group_membership, groups, messages as messages_schema};
use crate::services::unread::UnreadService;

pub fn indefinite_mute_until() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("9999-12-31T23:59:59Z")
        .expect("valid indefinite mute timestamp")
        .with_timezone(&Utc)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatReadState {
    pub last_read_message_id: Option<i64>,
    pub unread_count: i64,
}

pub fn get_chat_last_read_message_id(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
) -> Result<Option<i64>, diesel::result::Error> {
    use crate::schema::group_membership::dsl as gm_dsl;

    group_membership::table
        .filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(uid)))
        .select(gm_dsl::last_read_message_id)
        .first(conn)
}

pub fn mark_chat_as_read(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
    message_id: i64,
) -> Result<bool, diesel::result::Error> {
    use crate::schema::group_membership::dsl as gm_dsl;

    let updated = diesel::update(
        group_membership::table.filter(
            gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(uid)).and(
                gm_dsl::last_read_message_id
                    .is_null()
                    .or(gm_dsl::last_read_message_id.lt(message_id)),
            ),
        ),
    )
    .set(gm_dsl::last_read_message_id.eq(Some(message_id)))
    .execute(conn)?;

    Ok(updated > 0)
}

pub fn mark_chat_as_read_state(
    conn: &mut PgConnection,
    unread_service: &UnreadService,
    chat_id: i64,
    uid: i32,
    message_id: i64,
) -> Result<ChatReadState, diesel::result::Error> {
    mark_chat_as_read(conn, chat_id, uid, message_id)?;

    let last_read_message_id = get_chat_last_read_message_id(conn, chat_id, uid)?;
    let unread_count = unread_service.count_chat_unread(conn, chat_id, last_read_message_id)?;

    Ok(ChatReadState {
        last_read_message_id,
        unread_count,
    })
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Recalculate a group's `last_message_id` and `last_message_at` columns
/// by finding the most recent non-deleted, top-level message in the group.
///
/// Call this after soft-deleting messages that might have been the latest.
pub fn recalculate_group_last_message(
    conn: &mut PgConnection,
    chat_id: i64,
) -> Result<(), AppError> {
    use crate::schema::groups::dsl as g_dsl;
    use crate::schema::messages::dsl;

    let prev_message: Option<(i64, DateTime<Utc>)> = messages_schema::table
        .filter(dsl::chat_id.eq(chat_id))
        .filter(dsl::deleted_at.is_null())
        .filter(dsl::is_published.eq(true))
        .filter(dsl::reply_root_id.is_null())
        .order(dsl::id.desc())
        .select((dsl::id, dsl::created_at))
        .first(conn)
        .optional()?;

    match prev_message {
        Some((prev_id, prev_at)) => {
            diesel::update(groups::table.filter(g_dsl::id.eq(chat_id)))
                .set((
                    g_dsl::last_message_id.eq(Some(prev_id)),
                    g_dsl::last_message_at.eq(Some(prev_at)),
                ))
                .execute(conn)?;
        }
        None => {
            diesel::update(groups::table.filter(g_dsl::id.eq(chat_id)))
                .set((
                    g_dsl::last_message_id.eq(None::<i64>),
                    g_dsl::last_message_at.eq(None::<DateTime<Utc>>),
                ))
                .execute(conn)?;
        }
    }

    Ok(())
}

/// After a top-level message with no thread is soft-deleted, any
/// `group_membership.last_read_message_id` anchored on it dangles — the PWA
/// resume flow fetches `around=<last_read_message_id>` and strands scroll when
/// that id is absent from the window (the around filter is `is_published AND
/// reply_root_id IS NULL AND (deleted_at IS NULL OR has_thread)`). Shift every
/// anchored pointer to the newest surviving top-level message strictly older
/// than the deleted one (or NULL when none survives).
///
/// Only top-level messages with `has_thread = false` can dangle: a deleted
/// top-level message that still has a thread remains visible in the around
/// window, so its pointer stays addressable. Replies never anchor a chat-level
/// pointer (chat read position tracks top-level messages only), so passing
/// reply ids here is a harmless no-op.
///
/// `deleted_message_ids` must already be soft-deleted (deleted_at set) before
/// this runs, so the clamp subquery's `deleted_at IS NULL` filter excludes them
/// — letting one batched UPDATE handle multi-message deletes correctly.
///
/// Served by `idx_messages_visible_top_level_last` (chat_id, id DESC) WHERE
/// deleted_at IS NULL AND is_published AND reply_root_id IS NULL.
pub fn shift_chat_read_pointers_on_delete(
    conn: &mut PgConnection,
    chat_id: i64,
    deleted_message_ids: &[i64],
) -> Result<usize, diesel::result::Error> {
    if deleted_message_ids.is_empty() {
        return Ok(0);
    }
    diesel::sql_query(
        "UPDATE group_membership
         SET last_read_message_id = (
             SELECT id FROM messages
             WHERE chat_id = $1
               AND id < group_membership.last_read_message_id
               AND reply_root_id IS NULL
               AND (deleted_at IS NULL OR has_thread)
               AND is_published
             ORDER BY id DESC
             LIMIT 1
         )
         WHERE chat_id = $1
           AND last_read_message_id = ANY($2)",
    )
    .bind::<diesel::sql_types::BigInt, _>(chat_id)
    .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(deleted_message_ids)
    .execute(conn)
}

#[cfg(test)]
mod tests {
    use crate::constants::MAX_UNREAD_COUNT;

    #[test]
    fn unread_count_cap_matches_display_overflow_boundary() {
        assert_eq!(MAX_UNREAD_COUNT, 1000);
    }
}
