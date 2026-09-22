//! Per-user settings stored as dedicated columns on `user_extra`.

use chrono::Utc;
use diesel::prelude::*;

use crate::errors::AppError;
use crate::models::FriendAddVerificationMode;
use crate::schema::user_extra;

/// Namespace of the two-integer advisory lock key covering reaction writes and
/// notification-setting changes.
const USER_SETTINGS_LOCK_NAMESPACE: i32 = 1;

/// Whether the user wants unread-reaction badges and directed reaction
/// notifications. No `user_extra` row means `false`.
pub fn reaction_notifications_enabled(conn: &mut PgConnection, uid: i32) -> QueryResult<bool> {
    user_extra::table
        .filter(user_extra::uid.eq(uid))
        .select(user_extra::reaction_notifications_enabled)
        .first::<bool>(conn)
        .optional()
        .map(|enabled| enabled.unwrap_or(false))
}

/// Acquire the per-user lock, held for the enclosing transaction. Reaction
/// inserts, acknowledgements, toggle changes, and rejoin seeding all take it,
/// ordering their database timestamps per message author.
pub fn lock_user_settings(conn: &mut PgConnection, uid: i32) -> QueryResult<()> {
    diesel::sql_query("SELECT pg_advisory_xact_lock($1, $2)")
        .bind::<diesel::sql_types::Integer, _>(USER_SETTINGS_LOCK_NAMESPACE)
        .bind::<diesel::sql_types::Integer, _>(uid)
        .execute(conn)?;
    Ok(())
}

/// Mark all currently reactable messages authored by `uid` as viewed (an
/// enable/rejoin baseline, not an implicit browsing event); with `chat_id`,
/// only that chat.
fn seed_reaction_views(conn: &mut PgConnection, uid: i32, chat_id: Option<i64>) -> QueryResult<()> {
    let chat_filter = if chat_id.is_some() {
        "AND m.chat_id = $2"
    } else {
        ""
    };
    let sql = format!(
        "WITH view_time AS (SELECT clock_timestamp() AS viewed_at),
              reacted_messages AS (
                  SELECT DISTINCT m.id
                  FROM messages m
                  JOIN message_reactions mr ON mr.message_id = m.id
                  WHERE m.sender_uid = $1
                    AND mr.user_uid <> $1
                    AND m.deleted_at IS NULL
                    AND m.is_published = TRUE
                    {chat_filter}
              )
         INSERT INTO message_views (uid, message_id, viewed_at)
         SELECT $1, reacted_messages.id, view_time.viewed_at
         FROM reacted_messages
         CROSS JOIN view_time
         ON CONFLICT (uid, message_id) DO UPDATE
         SET viewed_at = GREATEST(message_views.viewed_at, EXCLUDED.viewed_at)"
    );

    match chat_id {
        Some(chat_id) => {
            diesel::sql_query(sql)
                .bind::<diesel::sql_types::Integer, _>(uid)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
        }
        None => {
            diesel::sql_query(sql)
                .bind::<diesel::sql_types::Integer, _>(uid)
                .execute(conn)?;
        }
    }
    Ok(())
}

/// Seed views for a user joining or rejoining a chat (only while the toggle is
/// on). Must run in the membership insert transaction.
pub fn seed_membership_reaction_views(
    conn: &mut PgConnection,
    uid: i32,
    chat_id: i64,
) -> QueryResult<()> {
    lock_user_settings(conn, uid)?;
    if reaction_notifications_enabled(conn, uid)? {
        seed_reaction_views(conn, uid, Some(chat_id))?;
    }
    Ok(())
}

/// Upsert the toggle. Only a false→true transition seeds views (clearing
/// backlog accumulated while off); repeated `true` never resets new reactions.
pub fn set_reaction_notifications_enabled(
    conn: &mut PgConnection,
    uid: i32,
    enabled: bool,
) -> Result<bool, AppError> {
    conn.transaction::<bool, AppError, _>(|conn| {
        lock_user_settings(conn, uid)?;

        let previously_enabled = reaction_notifications_enabled(conn, uid)?;

        let now = Utc::now().naive_utc();
        let result = diesel::insert_into(user_extra::table)
            .values((
                user_extra::uid.eq(uid),
                user_extra::first_seen_at.eq(now),
                user_extra::last_seen_at.eq(now),
                user_extra::sticker_pack_order.eq(serde_json::json!([])),
                user_extra::verification_mode.eq(FriendAddVerificationMode::Direct),
                user_extra::verification_question.eq(None::<String>),
                user_extra::reaction_notifications_enabled.eq(enabled),
            ))
            .on_conflict(user_extra::uid)
            .do_update()
            .set(user_extra::reaction_notifications_enabled.eq(enabled))
            .returning(user_extra::reaction_notifications_enabled)
            .get_result::<bool>(conn)?;

        if enabled && !previously_enabled {
            seed_reaction_views(conn, uid, None)?;
        }

        Ok(result)
    })
}
