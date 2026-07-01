use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use diesel::prelude::*;
use diesel::PgConnection;
use unicode_segmentation::UnicodeSegmentation;
use utoipa_axum::router::OpenApiRouter;

use crate::{
    dto::{
        messages::{ReactionDetailGroup, ReactionDetailResponse, ReactionReactor, ReactionSummary},
        ws::{ReactionUpdatePayload, ServerWsMessage},
    },
    errors::AppError,
    extractors::DbConn,
    handlers::members::check_membership,
    models::{Message, MessageReaction},
    schema::{group_membership, message_reactions, messages},
    services::user::lookup_user_avatars,
    utils::auth::CurrentUid,
    AppState,
};

use super::load_usernames_by_uids;

fn validate_emoji(input: &str) -> Result<String, AppError> {
    if input.is_empty() {
        return Err(AppError::BadRequest("Invalid emoji"));
    }

    let graphemes: Vec<&str> = input.graphemes(true).collect();

    if graphemes.len() != 1 {
        return Err(AppError::BadRequest("Invalid emoji"));
    }

    if !graphemes.iter().all(|g| emojis::get(g).is_some()) {
        return Err(AppError::BadRequest("Invalid emoji"));
    }

    Ok(input.to_string())
}

fn broadcast_reaction_update(
    conn: &mut PgConnection,
    state: &AppState,
    chat_id: i64,
    message_id: i64,
) {
    let counts: Vec<(String, i64)> = message_reactions::table
        .filter(message_reactions::message_id.eq(message_id))
        .group_by(message_reactions::emoji)
        .select((message_reactions::emoji, diesel::dsl::count_star()))
        .load(conn)
        .unwrap_or_default();

    // Load reactor UIDs (capped at 5 per emoji)
    let raw_reactors: Vec<(String, i32)> = message_reactions::table
        .filter(message_reactions::message_id.eq(message_id))
        .select((message_reactions::emoji, message_reactions::user_uid))
        .load(conn)
        .unwrap_or_default();

    let mut reactor_uids_map: std::collections::HashMap<String, Vec<i32>> =
        std::collections::HashMap::new();
    for (emoji, uid) in &raw_reactors {
        let entry = reactor_uids_map.entry(emoji.clone()).or_default();
        if entry.len() < 5 {
            entry.push(*uid);
        }
    }

    let all_uids: Vec<i32> = reactor_uids_map
        .values()
        .flatten()
        .copied()
        .collect::<std::collections::HashSet<i32>>()
        .into_iter()
        .collect();
    let names = load_usernames_by_uids(conn, &all_uids);
    let avatars = lookup_user_avatars(state, &all_uids);

    let reactions: Vec<ReactionSummary> = counts
        .into_iter()
        .map(|(emoji, count)| {
            let reactors = reactor_uids_map.get(&emoji).map(|uids| {
                uids.iter()
                    .map(|&uid| ReactionReactor {
                        uid,
                        name: names.get(&uid).cloned().flatten(),
                        avatar_url: avatars.get(&uid).cloned().flatten(),
                        sort_index: None,
                    })
                    .collect()
            });
            ReactionSummary {
                emoji,
                count,
                reacted_by_me: None,
                reactors,
            }
        })
        .collect();

    let member_uids: Vec<i32> = group_membership::table
        .filter(group_membership::chat_id.eq(chat_id))
        .select(group_membership::uid)
        .load(conn)
        .unwrap_or_default();

    let ws_msg = std::sync::Arc::new(ServerWsMessage::ReactionUpdated(ReactionUpdatePayload {
        message_id,
        chat_id,
        reactions,
    }));
    state.ws_registry.broadcast_to_uids(&member_uids, ws_msg);
}

#[utoipa::path(
    get,
    path = "/",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("message_id" = i64, Path, description = "Message ID"),
    ),
    responses(
        (status = 200, description = "Reaction details", body = ReactionDetailResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn get_reaction_details(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path((chat_id, message_id)): Path<(i64, i64)>,
    mut conn: DbConn,
) -> Result<Json<ReactionDetailResponse>, AppError> {
    let conn = &mut *conn;
    check_membership(conn, chat_id, uid)?;

    // Verify message exists in this chat (allow deleted messages with threads to show existing reactions)
    let _message: Message = messages::table
        .filter(messages::id.eq(message_id))
        .filter(messages::chat_id.eq(chat_id))
        .filter(
            messages::deleted_at
                .is_null()
                .or(messages::has_thread.eq(true)),
        )
        .filter(messages::is_published.eq(true))
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Message not found"))?;

    // Load all reactions for this message
    let raw: Vec<(String, i32)> = message_reactions::table
        .filter(message_reactions::message_id.eq(message_id))
        .order(message_reactions::created_at.asc())
        .select((message_reactions::emoji, message_reactions::user_uid))
        .load(conn)?;

    // Group by emoji, preserving order
    let mut groups: Vec<ReactionDetailGroup> = Vec::new();
    let mut emoji_index: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut all_uids = std::collections::HashSet::new();

    for (idx, (emoji, uid)) in raw.iter().enumerate() {
        all_uids.insert(*uid);
        if let Some(&gi) = emoji_index.get(emoji) {
            groups[gi].reactors.push(ReactionReactor {
                uid: *uid,
                name: None,
                avatar_url: None,
                sort_index: Some(idx as i32),
            });
        } else {
            let gi = groups.len();
            emoji_index.insert(emoji.clone(), gi);
            groups.push(ReactionDetailGroup {
                emoji: emoji.clone(),
                reactors: vec![ReactionReactor {
                    uid: *uid,
                    name: None,
                    avatar_url: None,
                    sort_index: Some(idx as i32),
                }],
            });
        }
    }

    // Resolve names + avatars
    let uids_vec: Vec<i32> = all_uids.into_iter().collect();
    let names = load_usernames_by_uids(conn, &uids_vec);
    let avatars = lookup_user_avatars(&state, &uids_vec);

    for group in &mut groups {
        for reactor in &mut group.reactors {
            reactor.name = names.get(&reactor.uid).cloned().flatten();
            reactor.avatar_url = avatars.get(&reactor.uid).cloned().flatten();
        }
    }

    Ok(Json(ReactionDetailResponse { reactions: groups }))
}

#[utoipa::path(
    put,
    path = "/{emoji}",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("message_id" = i64, Path, description = "Message ID"),
        ("emoji" = String, Path, description = "Emoji character"),
    ),
    responses(
        (status = 204, description = "Reaction added"),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn put_reaction(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path((chat_id, message_id, emoji)): Path<(i64, i64, String)>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;
    let emoji = validate_emoji(&emoji)?;
    check_membership(conn, chat_id, uid)?;

    // Verify message exists and belongs to this chat
    let _message: Message = messages::table
        .filter(messages::id.eq(message_id))
        .filter(messages::chat_id.eq(chat_id))
        .filter(messages::deleted_at.is_null())
        .filter(messages::is_published.eq(true))
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Message not found"))?;

    // Insert reaction (ON CONFLICT DO NOTHING for idempotency)
    diesel::insert_into(message_reactions::table)
        .values(&MessageReaction {
            message_id,
            user_uid: uid,
            emoji,
            created_at: Utc::now(),
        })
        .on_conflict_do_nothing()
        .execute(conn)?;

    // Set denormalized flag
    diesel::update(messages::table.filter(messages::id.eq(message_id)))
        .set(messages::has_reactions.eq(true))
        .execute(conn)?;

    broadcast_reaction_update(conn, &state, chat_id, message_id);

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete,
    path = "/{emoji}",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("message_id" = i64, Path, description = "Message ID"),
        ("emoji" = String, Path, description = "Emoji character"),
    ),
    responses(
        (status = 204, description = "Reaction removed"),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn delete_reaction(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path((chat_id, message_id, emoji)): Path<(i64, i64, String)>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;
    let emoji = validate_emoji(&emoji)?;
    check_membership(conn, chat_id, uid)?;

    // Verify message exists and is not deleted (no reaction removal on deleted messages)
    let _message: Message = messages::table
        .filter(messages::id.eq(message_id))
        .filter(messages::chat_id.eq(chat_id))
        .filter(messages::deleted_at.is_null())
        .filter(messages::is_published.eq(true))
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Message not found"))?;

    let deleted = diesel::delete(
        message_reactions::table
            .filter(message_reactions::message_id.eq(message_id))
            .filter(message_reactions::user_uid.eq(uid))
            .filter(message_reactions::emoji.eq(&emoji)),
    )
    .execute(conn)?;

    if deleted > 0 {
        let remaining: i64 = message_reactions::table
            .filter(message_reactions::message_id.eq(message_id))
            .count()
            .get_result(conn)
            .unwrap_or(0);

        if remaining == 0 {
            diesel::update(messages::table.filter(messages::id.eq(message_id)))
                .set(messages::has_reactions.eq(false))
                .execute(conn)?;
        }

        broadcast_reaction_update(conn, &state, chat_id, message_id);
    }

    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(get_reaction_details))
        .routes(utoipa_axum::routes!(put_reaction, delete_reaction))
}

#[cfg(test)]
mod tests {
    use super::validate_emoji;
    use crate::errors::AppError;

    #[test]
    fn reaction_emoji_must_be_exactly_one_grapheme() {
        for emoji in ["🙂", "👍🏽", "👨‍👩‍👧‍👦", "❤️"] {
            assert_eq!(
                validate_emoji(emoji).expect("single grapheme emoji should pass"),
                emoji
            );
        }

        for emoji in ["🙂👍", "👍🏽🙂", "❤️🔥", "👨‍👩‍👧‍👦🙂"] {
            assert!(matches!(
                validate_emoji(emoji).expect_err("multiple grapheme emoji should fail"),
                AppError::BadRequest("Invalid emoji")
            ));
        }
    }
}
