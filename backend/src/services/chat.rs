use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::PgConnection;

use crate::errors::AppError;
use crate::schema::{group_membership, groups, messages as messages_schema};
use crate::services::unread::UnreadService;

/// Call after membership commits, even when its system announcement is hidden or fails.
pub fn publish_membership_changed(
    registry: &super::ws_registry::ConnectionRegistry,
    uid: i32,
    chat_id: i64,
) {
    registry.broadcast_to_uids(
        &[uid],
        std::sync::Arc::new(crate::dto::ws::ServerWsMessage::ChatMembershipChanged(
            crate::dto::ws::ChatMembershipChangedPayload { chat_id },
        )),
    );
}

pub fn indefinite_mute_until() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("9999-12-31T23:59:59Z")
        .expect("valid indefinite mute timestamp")
        .with_timezone(&Utc)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatReadState {
    pub last_read_message_id: Option<i64>,
    pub unread_count: i64,
    pub receipt_advanced: bool,
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

    let message_id = if super::system_messages::load_membership_message_filter(conn, uid, chat_id)?
    {
        skip_hidden_membership_tail(conn, chat_id, message_id)?
    } else {
        message_id
    };
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

    // Unread reactions are NOT acknowledged here: the reaction cursor is
    // independent of the message read position and only advances through the
    // explicit reaction-acknowledge endpoint, so entering/reading messages
    // never clears a reaction badge as a side effect.

    Ok(updated > 0)
}

/// Use a single statement snapshot: a visible arrival between two separate
/// queries must never be skipped. Both probes use the chat/id range indexes;
/// the first also matches the visible-message partial index. Every eligible row
/// before that first visible message is hidden, so the second probe needs no kind filter.
fn skip_hidden_membership_tail(
    conn: &mut PgConnection,
    chat_id: i64,
    message_id: i64,
) -> QueryResult<i64> {
    #[derive(QueryableByName)]
    struct Boundary {
        #[diesel(sql_type = diesel::sql_types::BigInt)]
        id: i64,
    }
    let query = format!(
        "WITH next_visible AS (
        SELECT id FROM messages WHERE chat_id = $1 AND id > $2
          AND is_published = true AND reply_root_id IS NULL
          AND (deleted_at IS NULL OR has_thread = true) AND {}
        ORDER BY id ASC LIMIT 1
    ) SELECT COALESCE((
        SELECT id FROM messages WHERE chat_id = $1 AND id > $2
          AND id < COALESCE((SELECT id FROM next_visible), 9223372036854775807)
          AND is_published = true AND reply_root_id IS NULL
          AND (deleted_at IS NULL OR has_thread = true)
        ORDER BY id DESC LIMIT 1
    ), $2) AS id",
        super::system_messages::NON_MEMBERSHIP_PREDICATE
    );
    Ok(diesel::sql_query(query)
        .bind::<diesel::sql_types::BigInt, _>(chat_id)
        .bind::<diesel::sql_types::BigInt, _>(message_id)
        .get_result::<Boundary>(conn)?
        .id)
}

pub fn mark_chat_as_read_state(
    conn: &mut PgConnection,
    unread_service: &UnreadService,
    chat_id: i64,
    uid: i32,
    message_id: i64,
) -> Result<ChatReadState, diesel::result::Error> {
    let receipt_advanced = conn.transaction(|conn| {
        mark_chat_as_read(conn, chat_id, uid, message_id)?;
        crate::services::read_receipts::advance_chat_read_receipt(conn, chat_id, uid, message_id)
    })?;

    let last_read_message_id = get_chat_last_read_message_id(conn, chat_id, uid)?;
    let unread_count =
        unread_service.count_chat_unread(conn, uid, chat_id, last_read_message_id)?;

    Ok(ChatReadState {
        last_read_message_id,
        unread_count,
        receipt_advanced,
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
    fn hidden_membership_unreads_and_read_advancement_preserve_visible_messages() {
        use super::*;
        use crate::dto::users::UpdateChatSettings;
        use diesel::connection::SimpleConnection;
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
            let uid = 987669100;
            let other = uid + 1;
            let chat = 987669200;
            conn.batch_execute("INSERT INTO groups(id, name) VALUES (987669200, 'visible-read');
                INSERT INTO group_membership(chat_id, uid, last_read_message_id, mute_override)
                    VALUES (987669200, 987669100, 987669300, false), (987669200, 987669101, 987669300, false);
                INSERT INTO messages(id, chat_id, sender_uid, client_generated_id, message_type, system_kind, created_at)
                    VALUES (987669300, 987669200, 1717, 'baseline', 'text', NULL, NOW()),
                           (987669301, 987669200, 1717, 'hidden-1', 'system', 'member_joined', NOW()),
                           (987669302, 987669200, 1717, 'unread-visible', 'text', NULL, NOW()),
                           (987669303, 987669200, 1717, 'hidden-2', 'system', 'member_removed', NOW()),
                           (987669304, 987669200, 1717, 'unread-unknown', 'system', 'unknown', NOW());
                INSERT INTO messages(id, chat_id, sender_uid, client_generated_id, message_type, system_kind, created_at)
                    SELECT 987669304 + n, 987669200, 1717, 'tail-' || n, 'system', 'member_left', NOW()
                    FROM generate_series(1, 1200) n;")?;
            crate::services::user::save_chat_settings(conn, uid, UpdateChatSettings {show_membership_messages: false})?;
            let unread = UnreadService::new();
            assert_eq!(unread.count_chat_unread(conn, uid, chat, Some(987669300))?, 2);
            assert_eq!(unread.count_chat_unread(conn, other, chat, Some(987669300))?, 1000);
            let counts = unread.count_users_unread_totals(conn, &[uid, other])?;
            assert_eq!(counts[&uid], 2);
            assert_eq!(counts[&other], 1000);
            assert_eq!(unread.count_user_unread_summary(conn, uid)?.unread_count, 2);
            // Reading the old boundary may skip 301, but never the unseen normal message 302.
            let state = mark_chat_as_read_state(conn, &unread, chat, uid, 987669300)?;
            assert_eq!(state.last_read_message_id, Some(987669301));
            assert_eq!(state.unread_count, 2);
            // Reading 302 skips 303 and stops at the unknown (visible) system event.
            let state = mark_chat_as_read_state(conn, &unread, chat, uid, 987669302)?;
            assert_eq!(state.last_read_message_id, Some(987669303));
            assert_eq!(state.unread_count, 1);
            let state = mark_chat_as_read_state(conn, &unread, chat, uid, 987669304)?;
            assert_eq!(state.last_read_message_id, Some(987670504));
            assert_eq!(state.unread_count, 0);
            mark_chat_as_read(conn, chat, uid, 987669300)?;
            assert_eq!(get_chat_last_read_message_id(conn, chat, uid)?, state.last_read_message_id);
            // Re-enabling cannot resurrect unread events already covered by the saved cursor.
            crate::services::user::save_chat_settings(conn, uid, UpdateChatSettings {show_membership_messages: true})?;
            assert_eq!(unread.count_chat_unread(conn, uid, chat, state.last_read_message_id)?, 0);
            mark_chat_as_read(conn, chat, other, 987669302)?;
            assert_eq!(get_chat_last_read_message_id(conn, chat, other)?, Some(987669302));
            // The account switch applies to group main scopes only, never DMs.
            crate::services::user::save_chat_settings(conn, uid, UpdateChatSettings {show_membership_messages: false})?;
            conn.batch_execute("UPDATE groups SET kind='dm', dm_uid1=987669100, dm_uid2=987669101 WHERE id=987669200;
                UPDATE group_membership SET last_read_message_id=987669300 WHERE chat_id=987669200 AND uid=987669100;")?;
            assert_eq!(unread.count_chat_unread(conn, uid, chat, Some(987669300))?, 1000);
            mark_chat_as_read(conn, chat, uid, 987669300)?;
            assert_eq!(get_chat_last_read_message_id(conn, chat, uid)?, Some(987669300));
            Ok(())
        });
    }

    #[test]
    fn unread_count_cap_matches_display_overflow_boundary() {
        assert_eq!(MAX_UNREAD_COUNT, 1000);
    }
}
