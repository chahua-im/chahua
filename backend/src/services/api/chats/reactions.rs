use diesel::prelude::*;
use diesel::PgConnection;
use unicode_segmentation::UnicodeSegmentation;

use crate::dto::{
    messages::{ReactionDetailGroup, ReactionDetailResponse, ReactionReactor, ReactionSummary},
    ws::{NotificationPayload, NotificationType, ReactionUpdatePayload, ServerWsMessage},
};
use crate::errors::AppError;
use crate::models::Message;
use crate::schema::{group_membership, message_reactions, messages};
use crate::services::api::members::check_membership;
use crate::services::avatars::AvatarService;
use crate::services::messages::{load_username_by_uid, load_usernames_by_uids};
use crate::services::social;
use crate::services::ws_registry::ConnectionRegistry;
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
    avatars: &AvatarService,
    registry: &ConnectionRegistry,
    chat_id: i64,
    message_id: i64,
) -> Vec<i32> {
    let counts: Vec<(String, i64)> = message_reactions::table
        .filter(message_reactions::message_id.eq(message_id))
        .group_by(message_reactions::emoji)
        .select((message_reactions::emoji, diesel::dsl::count_star()))
        .order((
            diesel::dsl::count_star().desc(),
            diesel::dsl::min(message_reactions::created_at).asc(),
            message_reactions::emoji.asc(),
        ))
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
    let avatars = avatars.lookup(&all_uids);

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
    registry.broadcast_to_uids(&member_uids, ws_msg);
    member_uids
}
pub fn get_reaction_details(
    uid: i32,
    chat_id: i64,
    message_id: i64,
    conn: &mut PgConnection,
    avatars: &AvatarService,
) -> Result<ReactionDetailResponse, AppError> {
    check_membership(conn, chat_id, uid)?;

    // Reactions are not exposed for deleted messages (even thread-root placeholders).
    let _message: Message = messages::table
        .filter(messages::id.eq(message_id))
        .filter(diesel::dsl::sql::<diesel::sql_types::Bool>(
            crate::services::system_messages::NON_MEMBERSHIP_PREDICATE,
        ))
        .filter(messages::chat_id.eq(chat_id))
        .filter(messages::deleted_at.is_null())
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
    let avatars = avatars.lookup(&uids_vec);

    for group in &mut groups {
        for reactor in &mut group.reactors {
            reactor.name = names.get(&reactor.uid).cloned().flatten();
            reactor.avatar_url = avatars.get(&reactor.uid).cloned().flatten();
        }
    }

    Ok(ReactionDetailResponse { reactions: groups })
}
pub fn put_reaction(
    uid: i32,
    chat_id: i64,
    message_id: i64,
    emoji: String,
    conn: &mut PgConnection,
    avatars: &AvatarService,
    registry: &ConnectionRegistry,
) -> Result<(), AppError> {
    let emoji = validate_emoji(&emoji)?;
    check_membership(conn, chat_id, uid)?;
    social::require_chat_writable(conn, chat_id, uid)?;

    // Verify message exists and belongs to this chat
    let message: Message = messages::table
        .filter(messages::id.eq(message_id))
        .filter(diesel::dsl::sql::<diesel::sql_types::Bool>(
            crate::services::system_messages::NON_MEMBERSHIP_PREDICATE,
        ))
        .filter(messages::chat_id.eq(chat_id))
        .filter(messages::deleted_at.is_null())
        .filter(messages::is_published.eq(true))
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Message not found"))?;

    let inserted = crate::services::reactions::insert_reaction(conn, &message, uid, emoji)?;

    let member_uids = broadcast_reaction_update(conn, avatars, registry, chat_id, message_id);

    // Directed unread-reaction notification to the message author. Only on a
    // genuinely new row (re-putting the same emoji is a no-op) and never for
    // self-reactions or authors who are no longer chat members.
    if inserted > 0 && message.sender_uid != uid && member_uids.contains(&message.sender_uid) {
        let actor_name = load_username_by_uid(conn, uid)?.unwrap_or_else(|| "Someone".to_string());
        let payload = NotificationPayload {
            notification_type: NotificationType::Reaction,
            chat_id,
            message_id,
            thread_root_id: message.reply_root_id,
            actor_uid: uid,
            actor_name: Some(actor_name),
        };
        registry.broadcast_to_uids(
            &[message.sender_uid],
            std::sync::Arc::new(ServerWsMessage::Notification(payload)),
        );
    }

    Ok(())
}
pub fn delete_reaction(
    uid: i32,
    chat_id: i64,
    message_id: i64,
    emoji: String,
    conn: &mut PgConnection,
    avatars: &AvatarService,
    registry: &ConnectionRegistry,
) -> Result<(), AppError> {
    let emoji = validate_emoji(&emoji)?;
    check_membership(conn, chat_id, uid)?;
    social::require_chat_writable(conn, chat_id, uid)?;

    // Verify message exists and is not deleted (no reaction removal on deleted messages)
    let message: Message = messages::table
        .filter(messages::id.eq(message_id))
        .filter(diesel::dsl::sql::<diesel::sql_types::Bool>(
            crate::services::system_messages::NON_MEMBERSHIP_PREDICATE,
        ))
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

        let member_uids = broadcast_reaction_update(conn, avatars, registry, chat_id, message_id);
        // Removing a reaction changes the author's unread count too. Notify only
        // that user rather than making every chat member refetch unread state.
        if message.sender_uid != uid && member_uids.contains(&message.sender_uid) {
            registry.broadcast_to_uids(
                &[message.sender_uid],
                std::sync::Arc::new(ServerWsMessage::Notification(NotificationPayload {
                    notification_type: NotificationType::Reaction,
                    chat_id,
                    message_id,
                    thread_root_id: message.reply_root_id,
                    actor_uid: uid,
                    actor_name: None,
                })),
            );
        }
    }

    Ok(())
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
