mod chat_attachments;
mod messages;
mod reactions;
mod saved_messages;

use axum::{
    extract::{Path, Query, State},
    Json,
};
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::PgConnection;
use utoipa_axum::router::OpenApiRouter;

use crate::{
    dto::{
        attachments::AttachmentResponse,
        chats::{ChatListItem, ListChatsResponse, MarkChatReadStateResponse, UnreadCountResponse},
        messages::{
            ForwardedFromInfo, MentionInfo, MessagePreview, MessagePreviewSticker, MessageResponse,
            MessageStickerResponse, ReactionReactor, ReactionSummary, StickerMediaResponse,
            ThreadInfo,
        },
        users::User,
        ws::{ChatArchiveStateChangedPayload, ServerWsMessage},
    },
    errors::AppError,
    extractors::DbConn,
    handlers::members::check_membership,
    services::{
        chat,
        media::build_public_object_url,
        push::{PushJob, PushMessagePreview, PushMessagePreviewSticker},
        user::{lookup_user_avatars, lookup_user_profiles, UserProfile},
    },
    utils::{auth::CurrentUid, ids, pagination::validate_limit},
};
use crate::{
    models::{Attachment, Media, Message, MessageType, NewMessage, Sticker, TranscodeStatus},
    schema::{
        attachments, group_membership, groups, media, message_reactions,
        messages as messages_schema, sticker_pack_stickers, sticker_packs, stickers,
        user_favorite_stickers, user_sticker_pack_subscriptions,
    },
};
use crate::{AppState, MAX_CHATS_LIMIT};

// ---------------------------------------------------------------------------
// Re-exports for external consumers (pins.rs, threads.rs, invites.rs, ws/messages.rs)
// ---------------------------------------------------------------------------
pub use self::messages::router as messages_router;
pub use self::reactions::router as reactions_router;

// ---------------------------------------------------------------------------
// Mention extraction
// ---------------------------------------------------------------------------

fn parse_mention_token(text: &str, start: usize) -> Option<(i32, usize)> {
    let bytes = text.as_bytes();
    if bytes.get(start) != Some(&b'@') || bytes.get(start + 1) != Some(&b'[') {
        return None;
    }

    let rest = text.get(start + 2..)?;
    let close = rest.find(']')?;
    let inner = &rest[..close];
    let uid = inner.strip_prefix("uid:")?.parse::<i32>().ok()?;

    Some((uid, start + 2 + close + 1))
}

/// Extract `@[uid:<N>]` tokens from a message string.
pub fn extract_mention_uids(text: &str) -> Vec<i32> {
    let mut uids = Vec::new();

    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        if let Some((uid, next)) = parse_mention_token(text, i) {
            if !uids.contains(&uid) {
                uids.push(uid);
            }
            i = next;
            continue;
        }
        i += 1;
    }

    uids
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct ChatIdPath {
    chat_id: i64,
}

pub(crate) struct PreparedMessageSend {
    pub chat_id: i64,
    pub sender_uid: i32,
    pub message: Option<String>,
    pub message_type: MessageType,
    pub sticker_id: Option<i64>,
    pub reply_to_id: Option<i64>,
    pub reply_root_id: Option<i64>,
    pub client_generated_id: String,
    pub attachment_ids: Vec<i64>,
    pub publish_immediately: bool,
    pub forwarded_from_message_id: Option<i64>,
    pub forwarded_from_chat_id: Option<i64>,
    pub forwarded_from_sender_uid: Option<i32>,
}

pub(crate) struct SendMessageResult {
    pub inserted_message: Message,
    pub response: MessageResponse,
    pub member_uids: Vec<i32>,
    pub side_effects: PendingSideEffects,
}

#[must_use = "side effects must be fired via .fire()"]
pub(crate) struct PendingSideEffects {
    pub(crate) ws_msg: std::sync::Arc<ServerWsMessage>,
    pub(crate) broadcast_uids: Vec<i32>,
    pub(crate) push_job: Option<PushJob>,
    pub(crate) unread_event: Option<TopLevelUnreadCacheEvent>,
}

pub(crate) struct TopLevelUnreadCacheEvent {
    pub(crate) chat_id: i64,
    pub(crate) message_id: i64,
    pub(crate) countable: bool,
}

impl PendingSideEffects {
    /// Fire WS broadcast and push notification. Call after transaction commit.
    pub fn fire(self, state: &AppState) {
        if let Some(event) = self.unread_event {
            state.unread_service.observe_top_level_message(
                event.chat_id,
                event.message_id,
                event.countable,
            );
        }
        state
            .ws_registry
            .broadcast_to_uids(&self.broadcast_uids, self.ws_msg);
        if let Some(job) = self.push_job {
            state.push_service.enqueue(job);
        }
    }
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateMessageBody {
    pub message: Option<String>,
    pub message_type: MessageType,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    pub sticker_id: Option<i64>,
    pub client_generated_id: String,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    pub reply_to_id: Option<i64>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}

// ---------------------------------------------------------------------------
// Shared helper functions
// ---------------------------------------------------------------------------

fn load_username_by_uid(conn: &mut PgConnection, uid: i32) -> QueryResult<Option<String>> {
    lookup_user_profiles(conn, &[uid])
        .map(|mut profiles| profiles.remove(&uid).and_then(|profile| profile.username))
}

fn load_usernames_by_uids(
    conn: &mut PgConnection,
    uids: &[i32],
) -> std::collections::HashMap<i32, Option<String>> {
    lookup_user_profiles(conn, uids)
        .unwrap_or_default()
        .into_iter()
        .map(|(uid, profile)| (uid, profile.username))
        .collect()
}

fn load_reply_messages(
    conn: &mut PgConnection,
    reply_ids: &[i64],
) -> QueryResult<std::collections::HashMap<i64, Message>> {
    if reply_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    messages_schema::table
        .filter(messages_schema::id.eq_any(reply_ids))
        .filter(messages_schema::deleted_at.is_null())
        .filter(messages_schema::is_published.eq(true))
        .select(Message::as_select())
        .load::<Message>(conn)
        .map(|rows| rows.into_iter().map(|msg| (msg.id, msg)).collect())
}

fn load_sticker_accessible_ids(
    conn: &mut PgConnection,
    uid: i32,
    sticker_ids: &[i64],
) -> QueryResult<std::collections::HashSet<i64>> {
    if sticker_ids.is_empty() {
        return Ok(std::collections::HashSet::new());
    }

    stickers::table
        .inner_join(sticker_pack_stickers::table)
        .left_join(
            user_sticker_pack_subscriptions::table.on(user_sticker_pack_subscriptions::pack_id
                .eq(sticker_pack_stickers::pack_id)
                .and(user_sticker_pack_subscriptions::uid.eq(uid))),
        )
        .left_join(sticker_packs::table.on(sticker_packs::id.eq(sticker_pack_stickers::pack_id)))
        .filter(stickers::id.eq_any(sticker_ids))
        .filter(
            user_sticker_pack_subscriptions::uid
                .is_not_null()
                .or(sticker_packs::owner_uid.eq(uid)),
        )
        .select(stickers::id)
        .load::<i64>(conn)
        .map(|rows| rows.into_iter().collect())
}

fn load_sticker_rows(
    conn: &mut PgConnection,
    sticker_ids: &[i64],
) -> QueryResult<std::collections::HashMap<i64, (Sticker, Media)>> {
    if sticker_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    stickers::table
        .inner_join(media::table)
        .filter(stickers::id.eq_any(sticker_ids))
        .select((Sticker::as_select(), Media::as_select()))
        .load::<(Sticker, Media)>(conn)
        .map(|rows| {
            rows.into_iter()
                .map(|(sticker, media_row)| (sticker.id, (sticker, media_row)))
                .collect()
        })
}

fn load_favorited_sticker_ids(
    conn: &mut PgConnection,
    uid: i32,
    sticker_ids: &[i64],
) -> QueryResult<std::collections::HashSet<i64>> {
    if sticker_ids.is_empty() {
        return Ok(std::collections::HashSet::new());
    }

    user_favorite_stickers::table
        .filter(user_favorite_stickers::uid.eq(uid))
        .filter(user_favorite_stickers::sticker_id.eq_any(sticker_ids))
        .select(user_favorite_stickers::sticker_id)
        .load::<i64>(conn)
        .map(|rows| rows.into_iter().collect())
}

fn build_message_sticker_response(
    state: &AppState,
    sticker: &Sticker,
    media_row: &Media,
    is_favorited: bool,
) -> MessageStickerResponse {
    MessageStickerResponse {
        id: sticker.id,
        emoji: sticker.emoji.clone(),
        name: sticker.name.clone(),
        description: sticker.description.clone(),
        created_at: sticker.created_at,
        is_favorited,
        media: StickerMediaResponse {
            id: media_row.id,
            url: build_public_object_url(state, &media_row.storage_key),
            content_type: media_row.content_type.clone(),
            size: media_row.size,
            width: media_row.width,
            height: media_row.height,
        },
    }
}

pub(crate) fn build_sender(
    uid: i32,
    user_avatars: &std::collections::HashMap<i32, Option<String>>,
    user_profiles: &std::collections::HashMap<i32, UserProfile>,
) -> User {
    let profile = user_profiles.get(&uid);

    User {
        uid,
        avatar_url: user_avatars.get(&uid).cloned().flatten(),
        name: profile.and_then(|profile| profile.username.clone()),
        gender: profile.map(|profile| profile.gender).unwrap_or(0),
        user_group: profile.and_then(|profile| profile.user_group.clone()),
    }
}

fn message_response_preview(response: MessageResponse) -> MessagePreview {
    let is_deleted = response.is_deleted;
    MessagePreview {
        id: response.id,
        client_generated_id: response.client_generated_id,
        created_at: response.created_at,
        sender: response.sender,
        message: response.message,
        message_type: response.message_type,
        sticker: response.sticker.and_then(|sticker| {
            (!is_deleted).then_some(MessagePreviewSticker {
                emoji: sticker.emoji,
            })
        }),
        first_attachment_kind: response
            .attachments
            .first()
            .map(|attachment| attachment.kind.clone()),
        is_deleted,
        mentions: response.mentions,
    }
}

pub fn build_mention_info(
    uid: i32,
    user_avatars: &std::collections::HashMap<i32, Option<String>>,
    user_profiles: &std::collections::HashMap<i32, UserProfile>,
) -> MentionInfo {
    let profile = user_profiles.get(&uid);
    MentionInfo {
        uid,
        username: profile.and_then(|p| p.username.clone()),
        avatar_url: user_avatars.get(&uid).cloned().flatten(),
        gender: profile.map(|p| p.gender).unwrap_or(0),
        user_group: profile.and_then(|p| p.user_group.clone()),
    }
}

fn first_attachment_kind(
    message_attachments_map: &std::collections::HashMap<i64, Vec<Attachment>>,
    message_id: i64,
) -> Option<String> {
    message_attachments_map
        .get(&message_id)
        .and_then(|attachments| attachments.first())
        .map(|attachment| attachment.kind.clone())
}

fn sticker_preview_text(emoji: Option<&str>) -> String {
    match emoji.filter(|value| !value.trim().is_empty()) {
        Some(emoji) => format!("[Sticker] {emoji}"),
        None => "[Sticker]".to_string(),
    }
}

fn attachment_preview_text(kind: Option<&str>) -> &'static str {
    match kind {
        Some(kind) if kind.starts_with("image/") => "[Image]",
        Some(kind) if kind.starts_with("video/") => "[Video]",
        Some(kind) if kind.starts_with("audio/") => "[Voice message]",
        Some(_) => "[Attachment]",
        None => "[Attachment]",
    }
}

struct PushPreviewBundle {
    message_preview: PushMessagePreview,
    body_preview: Option<String>,
    mentioned_uids: Vec<i32>,
}

/// Replace `@[uid:N]` tokens with `@username` for human-readable previews.
fn render_mentions_as_text(text: &str, mentions: &[MentionInfo]) -> String {
    if mentions.is_empty() {
        return text.to_string();
    }
    let mention_map: std::collections::HashMap<i32, &str> = mentions
        .iter()
        .filter_map(|m| m.username.as_deref().map(|name| (m.uid, name)))
        .collect();

    let mut result = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    let mut copied_until = 0;
    while i < len {
        if let Some((uid, next)) = parse_mention_token(text, i) {
            result.push_str(&text[copied_until..i]);
            let name = mention_map.get(&uid).copied().unwrap_or("Unknown User");
            result.push('@');
            result.push_str(name);
            i = next;
            copied_until = next;
            continue;
        }
        i += 1;
    }
    result.push_str(&text[copied_until..]);
    result
}

fn build_push_preview_bundle(response: &MessageResponse) -> PushPreviewBundle {
    let mentioned_uids = response
        .message
        .as_deref()
        .map(extract_mention_uids)
        .unwrap_or_default();
    let rendered_message = response
        .message
        .as_deref()
        .map(|text| render_mentions_as_text(text, &response.mentions));
    let sticker = response.sticker.as_ref().and_then(|sticker| {
        (!sticker.emoji.trim().is_empty()).then(|| PushMessagePreviewSticker {
            emoji: sticker.emoji.clone(),
        })
    });
    let first_attachment_kind = response
        .attachments
        .first()
        .map(|attachment| attachment.kind.clone());
    let is_deleted = response.is_deleted;

    let body_preview = if is_deleted {
        None
    } else {
        match response.message_type {
            MessageType::Invite => Some("sent an invite".to_string()),
            MessageType::Sticker => Some(sticker_preview_text(
                response.sticker.as_ref().map(|s| s.emoji.as_str()),
            )),
            MessageType::File => {
                Some(attachment_preview_text(first_attachment_kind.as_deref()).to_string())
            }
            _ => rendered_message.clone(),
        }
    };

    let preview_message = if is_deleted {
        None
    } else {
        match response.message_type {
            MessageType::Invite => None,
            _ => rendered_message,
        }
    };

    PushPreviewBundle {
        message_preview: PushMessagePreview {
            message: preview_message,
            message_type: response.message_type.clone(),
            sticker,
            first_attachment_kind,
            is_deleted,
        },
        body_preview,
        mentioned_uids,
    }
}

pub(crate) fn build_message_side_effects(
    conn: &mut PgConnection,
    response: &MessageResponse,
    _state: &AppState,
    sender_uid: i32,
    chat_id: i64,
    enqueue_push: bool,
) -> Result<PendingSideEffects, AppError> {
    let member_uids: Vec<i32> = {
        use crate::schema::group_membership as gm_dsl;
        group_membership::table
            .filter(gm_dsl::chat_id.eq(chat_id))
            .select(group_membership::uid)
            .load(conn)?
    };

    let ws_msg = std::sync::Arc::new(ServerWsMessage::Message(response.clone()));

    let is_system_message = matches!(response.message_type, MessageType::System);
    let push_job = if enqueue_push && !is_system_message {
        let sender_username =
            load_username_by_uid(conn, sender_uid)?.unwrap_or_else(|| "Someone".to_string());
        let chat_name = groups::table
            .filter(groups::dsl::id.eq(chat_id))
            .select(groups::dsl::name)
            .first::<String>(conn)
            .unwrap_or_else(|_| "Chat".to_string());
        let push_preview = build_push_preview_bundle(response);
        Some(PushJob {
            chat_id,
            sender_uid,
            sender_username,
            chat_name,
            message_preview: push_preview.message_preview,
            body_preview: push_preview.body_preview,
            message_id: response.id,
            thread_root_id: response.reply_root_id,
            mentioned_uids: push_preview.mentioned_uids,
            reply_target_uid: response
                .reply_to_message
                .as_ref()
                .map(|message| message.sender.uid),
        })
    } else {
        None
    };

    Ok(PendingSideEffects {
        ws_msg,
        broadcast_uids: member_uids,
        push_job,
        unread_event: response
            .reply_root_id
            .is_none()
            .then_some(TopLevelUnreadCacheEvent {
                chat_id,
                message_id: response.id,
                countable: true,
            }),
    })
}

// ---------------------------------------------------------------------------
// send_prepared_message (shared by messages, invites, pins)
// ---------------------------------------------------------------------------

pub(crate) async fn send_prepared_message(
    conn: &mut PgConnection,
    state: &AppState,
    prepared: PreparedMessageSend,
) -> Result<SendMessageResult, AppError> {
    let id = ids::next_message_id(state.id_gen.as_ref())
        .await
        .map_err(|e| {
            tracing::error!("ferroid next_message_id: {:?}", e);
            AppError::Internal("ID generation failed")
        })?;

    let now = Utc::now();
    let message_type = prepared.message_type.clone();
    let is_system_message = matches!(message_type, MessageType::System);
    let transcode_status = if matches!(message_type, MessageType::Audio) {
        if prepared.publish_immediately {
            TranscodeStatus::Done
        } else {
            TranscodeStatus::Pending
        }
    } else {
        TranscodeStatus::None
    };

    let new_msg = NewMessage {
        id,
        message: prepared.message,
        message_type,
        sticker_id: prepared.sticker_id,
        reply_to_id: prepared.reply_to_id,
        reply_root_id: prepared.reply_root_id,
        created_at: now,
        client_generated_id: prepared.client_generated_id,
        sender_uid: prepared.sender_uid,
        chat_id: prepared.chat_id,
        updated_at: None,
        deleted_at: None,
        has_attachments: !prepared.attachment_ids.is_empty(),
        has_thread: false,
        has_reactions: false,
        is_published: prepared.publish_immediately,
        transcode_status,
        forwarded_from_message_id: prepared.forwarded_from_message_id,
        forwarded_from_chat_id: prepared.forwarded_from_chat_id,
        forwarded_from_sender_uid: prepared.forwarded_from_sender_uid,
    };

    let inserted_msg: Message = diesel::insert_into(messages_schema::table)
        .values(&new_msg)
        .returning(Message::as_returning())
        .get_result(conn)?;
    state.metrics.record_message(prepared.chat_id);

    if prepared.publish_immediately && prepared.reply_root_id.is_none() {
        use crate::schema::groups::dsl as g_dsl;
        diesel::update(groups::table.filter(g_dsl::id.eq(prepared.chat_id)))
            .set((
                g_dsl::last_message_id.eq(Some(id)),
                g_dsl::last_message_at.eq(Some(now)),
            ))
            .execute(conn)?;
    }

    if !prepared.attachment_ids.is_empty() {
        use crate::schema::attachments::dsl as a_dsl;
        diesel::update(attachments::table.filter(a_dsl::id.eq_any(&prepared.attachment_ids)))
            .set(a_dsl::message_id.eq(id))
            .execute(conn)?;
    }

    let response = attach_metadata(conn, vec![inserted_msg.clone()], state, prepared.sender_uid)
        .await
        .into_iter()
        .next()
        .ok_or(AppError::Internal("Failed to build message response"))?;

    let (member_uids, side_effects) = if prepared.publish_immediately {
        let side_effects = build_message_side_effects(
            conn,
            &response,
            state,
            prepared.sender_uid,
            prepared.chat_id,
            !is_system_message,
        )?;
        let member_uids = side_effects.broadcast_uids.clone();
        (member_uids, side_effects)
    } else {
        (
            Vec::new(),
            PendingSideEffects {
                ws_msg: std::sync::Arc::new(ServerWsMessage::Message(response.clone())),
                broadcast_uids: Vec::new(),
                push_job: None,
                unread_event: prepared.reply_root_id.is_none().then_some(
                    TopLevelUnreadCacheEvent {
                        chat_id: prepared.chat_id,
                        message_id: response.id,
                        countable: false,
                    },
                ),
            },
        )
    };

    Ok(SendMessageResult {
        inserted_message: inserted_msg,
        response,
        member_uids,
        side_effects,
    })
}

// ---------------------------------------------------------------------------
// attach_metadata (shared by messages, threads, pins)
// ---------------------------------------------------------------------------

/// Attach reply_to_message to a list of messages by fetching referenced messages in one query.
pub async fn attach_metadata(
    conn: &mut PgConnection,
    messages_to_process: Vec<Message>,
    state: &AppState,
    current_user_uid: i32,
) -> Vec<MessageResponse> {
    let reply_ids: Vec<i64> = messages_to_process
        .iter()
        .filter_map(|m| m.reply_to_id)
        .collect();

    let message_ids: Vec<i64> = messages_to_process.iter().map(|m| m.id).collect();
    let reply_messages_map = load_reply_messages(conn, &reply_ids).unwrap_or_default();

    let mut avatar_uids = std::collections::HashSet::new();
    for m in &messages_to_process {
        avatar_uids.insert(m.sender_uid);
    }
    for reply_msg in reply_messages_map.values() {
        avatar_uids.insert(reply_msg.sender_uid);
    }
    // Also collect forwarded-from sender UIDs for avatar resolution.
    for m in &messages_to_process {
        if let Some(fwd_uid) = m.forwarded_from_sender_uid {
            avatar_uids.insert(fwd_uid);
        }
    }
    let target_uids: Vec<i32> = avatar_uids.into_iter().collect();
    let mut user_avatars = lookup_user_avatars(state, &target_uids);
    let mut user_profiles = lookup_user_profiles(conn, &target_uids).unwrap_or_default();

    let mut message_attachments_map: std::collections::HashMap<i64, Vec<Attachment>> =
        std::collections::HashMap::new();
    let attachment_message_ids: Vec<i64> = message_ids
        .iter()
        .copied()
        .chain(reply_ids.iter().copied())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    if !attachment_message_ids.is_empty() {
        use crate::schema::attachments::dsl as a_dsl;
        let attachments: Vec<Attachment> = match attachments::table
            .filter(a_dsl::message_id.eq_any(&attachment_message_ids))
            .order((a_dsl::message_id.asc(), a_dsl::order.asc(), a_dsl::id.asc()))
            .select(Attachment::as_select())
            .load(conn)
        {
            Ok(attachments) => attachments,
            Err(err) => {
                tracing::error!(
                    error = ?err,
                    message_ids = ?attachment_message_ids,
                    "attach_metadata: failed to load attachments"
                );
                Vec::new()
            }
        };
        for att in attachments {
            if let Some(msg_id) = att.message_id {
                message_attachments_map.entry(msg_id).or_default().push(att);
            }
        }
    }

    let sticker_ids: Vec<i64> = messages_to_process
        .iter()
        .filter_map(|m| m.sticker_id)
        .chain(
            reply_messages_map
                .values()
                .filter_map(|reply_msg| reply_msg.sticker_id),
        )
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    let sticker_rows = load_sticker_rows(conn, &sticker_ids).unwrap_or_default();
    let favorited_sticker_ids =
        load_favorited_sticker_ids(conn, current_user_uid, &sticker_ids).unwrap_or_default();

    let mut thread_counts_map: std::collections::HashMap<i64, i64> =
        std::collections::HashMap::new();
    let thread_root_ids: Vec<i64> = messages_to_process
        .iter()
        .filter(|m| m.has_thread)
        .map(|m| m.id)
        .collect();
    if !thread_root_ids.is_empty() {
        use crate::schema::messages::dsl as m_dsl;
        let counts: Vec<(Option<i64>, i64)> = messages_schema::table
            .filter(m_dsl::reply_root_id.eq_any(&thread_root_ids))
            .filter(m_dsl::deleted_at.is_null())
            .filter(m_dsl::is_published.eq(true))
            .group_by(m_dsl::reply_root_id)
            .select((m_dsl::reply_root_id, diesel::dsl::count_star()))
            .load(conn)
            .unwrap_or_default();
        for (root_id_opt, count) in counts {
            if let Some(root_id) = root_id_opt {
                thread_counts_map.insert(root_id, count);
            }
        }
    }

    // --- Reactions ---
    let mut reaction_summaries_map: std::collections::HashMap<i64, Vec<ReactionSummary>> =
        std::collections::HashMap::new();
    let reacted_message_ids: Vec<i64> = messages_to_process
        .iter()
        .filter(|m| m.has_reactions)
        .map(|m| m.id)
        .collect();
    if !reacted_message_ids.is_empty() {
        let counts: Vec<(i64, String, i64)> = message_reactions::table
            .filter(message_reactions::message_id.eq_any(&reacted_message_ids))
            .group_by((message_reactions::message_id, message_reactions::emoji))
            .select((
                message_reactions::message_id,
                message_reactions::emoji,
                diesel::dsl::count_star(),
            ))
            .load(conn)
            .unwrap_or_default();

        let my_reactions: std::collections::HashSet<(i64, String)> = message_reactions::table
            .filter(message_reactions::message_id.eq_any(&reacted_message_ids))
            .filter(message_reactions::user_uid.eq(current_user_uid))
            .select((message_reactions::message_id, message_reactions::emoji))
            .load::<(i64, String)>(conn)
            .unwrap_or_default()
            .into_iter()
            .collect();

        // Query 3: Fetch reactor UIDs per (message_id, emoji)
        let raw_reactors: Vec<(i64, String, i32)> = message_reactions::table
            .filter(message_reactions::message_id.eq_any(&reacted_message_ids))
            .select((
                message_reactions::message_id,
                message_reactions::emoji,
                message_reactions::user_uid,
            ))
            .load(conn)
            .unwrap_or_default();

        // Group by (msg_id, emoji) -> Vec<uid>, capped at 5
        let mut reactor_uids_map: std::collections::HashMap<(i64, String), Vec<i32>> =
            std::collections::HashMap::new();
        for (msg_id, emoji, uid) in &raw_reactors {
            let entry = reactor_uids_map
                .entry((*msg_id, emoji.clone()))
                .or_default();
            if entry.len() < 5 {
                entry.push(*uid);
            }
        }

        // Batch-resolve names + avatars for all reactor UIDs
        let all_reactor_uids: Vec<i32> = reactor_uids_map
            .values()
            .flatten()
            .copied()
            .collect::<std::collections::HashSet<i32>>()
            .into_iter()
            .collect();
        let reactor_names = load_usernames_by_uids(conn, &all_reactor_uids);
        let reactor_avatars = lookup_user_avatars(state, &all_reactor_uids);

        for (msg_id, emoji, count) in counts {
            let reacted_by_me = Some(my_reactions.contains(&(msg_id, emoji.clone())));
            let reactors = reactor_uids_map.get(&(msg_id, emoji.clone())).map(|uids| {
                uids.iter()
                    .map(|&uid| ReactionReactor {
                        uid,
                        name: reactor_names.get(&uid).cloned().flatten(),
                        avatar_url: reactor_avatars.get(&uid).cloned().flatten(),
                        sort_index: None,
                    })
                    .collect()
            });
            reaction_summaries_map
                .entry(msg_id)
                .or_default()
                .push(ReactionSummary {
                    emoji,
                    count,
                    reacted_by_me,
                    reactors,
                });
        }
    }

    // --- Mentions ---
    // Collect all mentioned UIDs across all messages (and their reply messages)
    // so we can batch-resolve profiles.
    let mut all_mentioned_uids = std::collections::HashSet::new();
    let mut per_message_mentions: Vec<Vec<i32>> = Vec::with_capacity(messages_to_process.len());
    for m in &messages_to_process {
        if let Some(ref text) = m.message {
            if m.deleted_at.is_none() {
                let uids = extract_mention_uids(text);
                for &uid in &uids {
                    all_mentioned_uids.insert(uid);
                }
                per_message_mentions.push(uids);
                continue;
            }
        }
        per_message_mentions.push(Vec::new());
    }
    // Also collect mention UIDs from reply-to messages.
    for reply_msg in reply_messages_map.values() {
        if reply_msg.deleted_at.is_none() {
            if let Some(ref text) = reply_msg.message {
                for uid in extract_mention_uids(text) {
                    all_mentioned_uids.insert(uid);
                }
            }
        }
    }
    // Resolve profiles and avatars for mentioned UIDs not already loaded
    let extra_mention_uids: Vec<i32> = all_mentioned_uids
        .iter()
        .copied()
        .filter(|uid| !user_profiles.contains_key(uid))
        .collect();
    if !extra_mention_uids.is_empty() {
        user_profiles.extend(lookup_user_profiles(conn, &extra_mention_uids).unwrap_or_default());
        user_avatars.extend(lookup_user_avatars(state, &extra_mention_uids));
    }

    // Load forwarded-from messages' reply_to for preview building.
    let fwd_message_ids: Vec<i64> = messages_to_process
        .iter()
        .filter_map(|m| m.forwarded_from_message_id)
        .collect();
    let fwd_messages_map: std::collections::HashMap<i64, Message> = if !fwd_message_ids.is_empty() {
        use crate::schema::messages::dsl as m_dsl;
        messages_schema::table
            .filter(m_dsl::id.eq_any(&fwd_message_ids))
            .select(Message::as_select())
            .load(conn)
            .unwrap_or_default()
            .into_iter()
            .map(|m: Message| (m.id, m))
            .collect()
    } else {
        std::collections::HashMap::new()
    };
    let fwd_reply_ids: Vec<i64> = fwd_messages_map
        .values()
        .filter_map(|m| m.reply_to_id)
        .collect();
    let fwd_reply_messages_map = load_reply_messages(conn, &fwd_reply_ids).unwrap_or_default();

    let mut responses = Vec::with_capacity(messages_to_process.len());
    for (idx, m) in messages_to_process.into_iter().enumerate() {
        let reply_to_message = m.reply_to_id.and_then(|reply_id| {
            reply_messages_map.get(&reply_id).map(|reply_msg| {
                if reply_msg.has_attachments
                    && message_attachments_map
                        .get(&reply_msg.id)
                        .is_none_or(|attachments| attachments.is_empty())
                {
                    tracing::warn!(
                        reply_id = reply_msg.id,
                        parent_message_id = m.id,
                        chat_id = m.chat_id,
                        "attach_metadata: reply message has_attachments=true but no attachments were hydrated"
                    );
                }

                Box::new(MessagePreview {
                    id: reply_msg.id,
                    client_generated_id: reply_msg.client_generated_id.clone(),
                    created_at: reply_msg.created_at,
                    sender: build_sender(reply_msg.sender_uid, &user_avatars, &user_profiles),
                    message: if reply_msg.deleted_at.is_some() {
                        None
                    } else {
                        reply_msg.message.clone()
                    },
                    message_type: reply_msg.message_type.clone(),
                    sticker: reply_msg.sticker_id.and_then(|sticker_id| {
                        sticker_rows.get(&sticker_id).and_then(|(sticker, _)| {
                            (reply_msg.deleted_at.is_none()).then_some(MessagePreviewSticker {
                                emoji: sticker.emoji.clone(),
                            })
                        })
                    }),
                    first_attachment_kind: first_attachment_kind(
                        &message_attachments_map,
                        reply_msg.id,
                    ),
                    is_deleted: reply_msg.deleted_at.is_some(),
                    mentions: reply_msg
                        .message
                        .as_deref()
                        .filter(|_| reply_msg.deleted_at.is_none())
                        .map(|text| {
                            extract_mention_uids(text)
                                .into_iter()
                                .map(|uid| {
                                    build_mention_info(uid, &user_avatars, &user_profiles)
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                })
            })
        });

        let mut attachments = Vec::new();
        if let Some(atts) = message_attachments_map.get(&m.id) {
            for att in atts {
                attachments.push(AttachmentResponse {
                    id: att.id,
                    url: build_public_object_url(state, &att.external_reference),
                    kind: att.kind.clone(),
                    size: att.size,
                    file_name: att.file_name.clone(),
                    width: att.width,
                    height: att.height,
                });
            }
        }

        responses.push(MessageResponse {
            id: m.id,
            message: if m.deleted_at.is_some() {
                None
            } else {
                m.message
            },
            message_type: m.message_type,
            sticker: m.sticker_id.and_then(|sticker_id| {
                sticker_rows.get(&sticker_id).map(|(sticker, media_row)| {
                    build_message_sticker_response(
                        state,
                        sticker,
                        media_row,
                        favorited_sticker_ids.contains(&sticker_id),
                    )
                })
            }),
            reply_root_id: m.reply_root_id,
            client_generated_id: m.client_generated_id,
            sender: build_sender(m.sender_uid, &user_avatars, &user_profiles),
            chat_id: m.chat_id,
            created_at: m.created_at,
            is_edited: m.updated_at.is_some(),
            is_deleted: m.deleted_at.is_some(),
            has_attachments: m.has_attachments,
            thread_info: if m.has_thread {
                Some(ThreadInfo {
                    reply_count: *thread_counts_map.get(&m.id).unwrap_or(&0),
                })
            } else {
                None
            },
            reply_to_message,
            attachments,
            reactions: reaction_summaries_map.remove(&m.id).unwrap_or_default(),
            mentions: {
                per_message_mentions[idx]
                    .iter()
                    .map(|&uid| build_mention_info(uid, &user_avatars, &user_profiles))
                    .collect()
            },
            forwarded_from: m.forwarded_from_message_id.and_then(|fwd_msg_id| {
                let fwd_chat_id = m.forwarded_from_chat_id?;
                let fwd_sender_uid = m.forwarded_from_sender_uid?;
                let original_reply_to = fwd_messages_map
                    .get(&fwd_msg_id)
                    .and_then(|fwd_msg| fwd_msg.reply_to_id)
                    .and_then(|reply_id| {
                        fwd_reply_messages_map.get(&reply_id).map(|reply_msg| {
                            Box::new(MessagePreview {
                                id: reply_msg.id,
                                client_generated_id: reply_msg.client_generated_id.clone(),
                                created_at: reply_msg.created_at,
                                sender: build_sender(
                                    reply_msg.sender_uid,
                                    &user_avatars,
                                    &user_profiles,
                                ),
                                message: if reply_msg.deleted_at.is_some() {
                                    None
                                } else {
                                    reply_msg.message.clone()
                                },
                                message_type: reply_msg.message_type.clone(),
                                sticker: reply_msg.sticker_id.and_then(|sticker_id| {
                                    sticker_rows.get(&sticker_id).and_then(|(sticker, _)| {
                                        (reply_msg.deleted_at.is_none()).then_some(
                                            MessagePreviewSticker {
                                                emoji: sticker.emoji.clone(),
                                            },
                                        )
                                    })
                                }),
                                first_attachment_kind: first_attachment_kind(
                                    &message_attachments_map,
                                    reply_msg.id,
                                ),
                                is_deleted: reply_msg.deleted_at.is_some(),
                                mentions: Vec::new(),
                            })
                        })
                    });
                Some(ForwardedFromInfo {
                    sender: build_sender(fwd_sender_uid, &user_avatars, &user_profiles),
                    original_chat_id: fwd_chat_id,
                    original_message_id: fwd_msg_id,
                    original_reply_to,
                })
            }),
        });
    }
    responses
}

// ---------------------------------------------------------------------------
// Chat listing endpoints
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListChatsQuery {
    #[serde(default)]
    limit: Option<i64>,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    after: Option<i64>,
    #[serde(default)]
    archived: Option<bool>,
}

/// GET /chats — List chats for the current user (cursor-based).
#[utoipa::path(
    get,
    path = "/",
    tag = "chats",
    params(
        ("limit" = Option<i64>, Query, description = "Max number of chats to return"),
        ("after" = Option<String>, Query, description = "Cursor for pagination"),
        ("archived" = Option<bool>, Query, description = "When true, list archived chats instead of active ones"),
    ),
    responses(
        (status = 200, description = "List of chats", body = ListChatsResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn get_chats(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(q): Query<ListChatsQuery>,
) -> Result<Json<ListChatsResponse>, AppError> {
    let conn = &mut *conn;

    let limit = validate_limit(q.limit, MAX_CHATS_LIMIT);
    let archived = q.archived.unwrap_or(false);

    let base_query = groups::table
        .inner_join(group_membership::table)
        .left_join(
            messages_schema::table.on(groups::last_message_id.eq(messages_schema::id.nullable())),
        )
        .left_join(
            media::table.on(groups::avatar_image_id
                .eq(media::id.nullable())
                .and(media::deleted_at.is_null())),
        )
        .filter(group_membership::uid.eq(uid))
        .filter(group_membership::archived.eq(archived));

    type RowType = (
        i64,
        String,
        Option<String>,
        Option<DateTime<Utc>>,
        Option<i64>,
        Option<crate::models::Message>,
        Option<DateTime<Utc>>,
        bool,
    );

    let rows: Vec<RowType> = match q.after {
        None => base_query
            .select((
                groups::id,
                groups::name,
                media::storage_key.nullable(),
                groups::last_message_at,
                group_membership::last_read_message_id,
                messages_schema::all_columns.nullable(),
                group_membership::muted_until,
                group_membership::archived,
            ))
            .order_by((
                groups::last_message_at.desc().nulls_last(),
                groups::id.desc(),
            ))
            .limit(limit + 1)
            .load(conn)?,
        Some(after_id) => {
            let cursor_at: Option<Option<DateTime<Utc>>> = groups::table
                .inner_join(group_membership::table)
                .filter(group_membership::uid.eq(uid))
                .filter(groups::id.eq(after_id))
                .select(groups::last_message_at)
                .first(conn)
                .optional()?;

            let cursor_at = match cursor_at {
                Some(c) => c,
                None => {
                    return Ok(Json(ListChatsResponse {
                        chats: vec![],
                        next_cursor: None,
                    }))
                }
            };
            let cursor_id = after_id;

            match cursor_at {
                Some(c_at) => base_query
                    .select((
                        groups::id,
                        groups::name,
                        media::storage_key.nullable(),
                        groups::last_message_at,
                        group_membership::last_read_message_id,
                        messages_schema::all_columns.nullable(),
                        group_membership::muted_until,
                        group_membership::archived,
                    ))
                    .filter(
                        groups::last_message_at
                            .lt(c_at)
                            .or(groups::last_message_at
                                .eq(c_at)
                                .and(groups::id.lt(cursor_id)))
                            .or(groups::last_message_at.is_null()),
                    )
                    .order_by((
                        groups::last_message_at.desc().nulls_last(),
                        groups::id.desc(),
                    ))
                    .limit(limit + 1)
                    .load(conn)?,
                None => base_query
                    .select((
                        groups::id,
                        groups::name,
                        media::storage_key.nullable(),
                        groups::last_message_at,
                        group_membership::last_read_message_id,
                        messages_schema::all_columns.nullable(),
                        group_membership::muted_until,
                        group_membership::archived,
                    ))
                    .filter(
                        groups::last_message_at
                            .is_null()
                            .and(groups::id.lt(cursor_id)),
                    )
                    .order_by((
                        groups::last_message_at.desc().nulls_last(),
                        groups::id.desc(),
                    ))
                    .limit(limit + 1)
                    .load(conn)?,
            }
        }
    };

    let has_more = rows.len() as i64 > limit;
    let items_to_process: Vec<RowType> = rows.into_iter().take(limit as usize).collect();

    let messages_to_process: Vec<crate::models::Message> = items_to_process
        .iter()
        .filter_map(|(_, _, _, _, _, msg, _, _)| msg.clone())
        .collect();

    let memberships = items_to_process
        .iter()
        .map(
            |(
                id,
                _name,
                _avatar_key,
                _last_message_at,
                last_read_message_id,
                _msg,
                muted_until,
                archived,
            )| crate::services::unread::ChatUnreadMembership {
                chat_id: *id,
                last_read_message_id: *last_read_message_id,
                archived: *archived,
                muted_until: *muted_until,
            },
        )
        .collect::<Vec<_>>();
    let unread_counts = state
        .unread_service
        .count_membership_unreads(conn, &memberships)?;

    let message_responses = attach_metadata(conn, messages_to_process, &state, uid).await;

    let mut message_response_map: std::collections::HashMap<i64, MessageResponse> =
        message_responses
            .into_iter()
            .map(|mr| (mr.id, mr))
            .collect();

    let chats: Vec<ChatListItem> = items_to_process
        .into_iter()
        .map(
            |(
                id,
                name,
                avatar_key,
                last_message_at,
                last_read_message_id,
                msg,
                muted_until,
                archived,
            )| {
                let unread_count = unread_counts.get(&id).copied().unwrap_or(0);
                let mr = msg
                    .and_then(|m| message_response_map.remove(&m.id))
                    .map(message_response_preview);
                ChatListItem {
                    id,
                    name: Some(name),
                    avatar: avatar_key
                        .as_deref()
                        .map(|storage_key| build_public_object_url(&state, storage_key)),
                    last_message_at,
                    unread_count,
                    last_read_message_id,
                    last_message: mr,
                    muted_until,
                    archived,
                }
            },
        )
        .collect();

    let next_cursor = has_more.then(|| chats.last().map(|c| c.id)).flatten();

    Ok(Json(ListChatsResponse { chats, next_cursor }))
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarkAsReadBody {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    #[schema(value_type = String)]
    message_id: i64,
}

/// POST /chats/:chat_id/messages/read — Mark messages as read up to a specific message ID.
#[utoipa::path(
    post,
    path = "/read",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    request_body = MarkAsReadBody,
    responses(
        (status = 200, description = "Updated read state", body = MarkChatReadStateResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn mark_as_read(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Json(body): Json<MarkAsReadBody>,
) -> Result<Json<MarkChatReadStateResponse>, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    let read_state = crate::services::chat::mark_chat_as_read_state(
        conn,
        state.unread_service.as_ref(),
        chat_id,
        uid,
        body.message_id,
    )?;

    Ok(Json(MarkChatReadStateResponse {
        last_read_message_id: read_state.last_read_message_id,
        unread_count: read_state.unread_count,
    }))
}

/// Optional body for the unread endpoint — allows resetting read position to a specific message.
#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MarkAsUnreadBody {
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    message_id: Option<i64>,
}

/// POST /chats/:chat_id/unread — Mark a chat as unread by rewinding the read pointer.
#[utoipa::path(
    post,
    path = "/unread",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    request_body(content = Option<MarkAsUnreadBody>),
    responses(
        (status = 200, description = "Updated read state", body = MarkChatReadStateResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn mark_as_unread(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    body: Option<Json<MarkAsUnreadBody>>,
) -> Result<Json<MarkChatReadStateResponse>, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    let explicit_id = body.and_then(|Json(b)| b.message_id);

    let (new_read_id, unread_count) = if let Some(message_id) = explicit_id {
        use crate::schema::group_membership::dsl as gm_dsl;
        diesel::update(
            group_membership::table.filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(uid))),
        )
        .set(gm_dsl::last_read_message_id.eq(Some(message_id)))
        .execute(conn)?;

        let unread_count =
            state
                .unread_service
                .count_chat_unread(conn, chat_id, Some(message_id))?;
        (Some(message_id), unread_count)
    } else {
        use crate::schema::messages::dsl;
        let last_two: Vec<i64> = messages_schema::table
            .filter(
                dsl::chat_id
                    .eq(chat_id)
                    .and(dsl::reply_root_id.is_null())
                    .and(dsl::deleted_at.is_null())
                    .and(dsl::is_published.eq(true)),
            )
            .order(dsl::id.desc())
            .limit(2)
            .select(dsl::id)
            .load(conn)?;

        // If < 2 public messages, set to NULL (entire chat unread); otherwise second-to-last
        let new_read_id = if last_two.len() >= 2 {
            Some(last_two[1])
        } else {
            None
        };

        use crate::schema::group_membership::dsl as gm_dsl;
        diesel::update(
            group_membership::table.filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(uid))),
        )
        .set(gm_dsl::last_read_message_id.eq(new_read_id))
        .execute(conn)?;

        let unread_count = if new_read_id.is_some() {
            1
        } else {
            last_two.len() as i64
        };
        (new_read_id, unread_count)
    };

    Ok(Json(MarkChatReadStateResponse {
        last_read_message_id: new_read_id,
        unread_count,
    }))
}

/// GET /chats/:chat_id/unread — Get capped unread count for a single chat.
#[utoipa::path(
    get,
    path = "/unread",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    responses(
        (status = 200, description = "Capped chat unread count", body = MarkChatReadStateResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn get_chat_unread_count(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
) -> Result<Json<MarkChatReadStateResponse>, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    use crate::schema::group_membership::dsl as gm_dsl;
    let last_read_message_id: Option<i64> = group_membership::table
        .filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(uid)))
        .select(gm_dsl::last_read_message_id)
        .first(conn)?;

    let unread_count =
        state
            .unread_service
            .count_chat_unread(conn, chat_id, last_read_message_id)?;

    Ok(Json(MarkChatReadStateResponse {
        last_read_message_id,
        unread_count,
    }))
}

/// GET /chats/unread — Get total unread message and chat counts for the current user.
#[utoipa::path(
    get,
    path = "/unread",
    tag = "chats",
    responses(
        (status = 200, description = "Total unread count", body = UnreadCountResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn get_unread_count(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<Json<UnreadCountResponse>, AppError> {
    let conn = &mut *conn;

    let counts = state.unread_service.count_user_unread_summary(conn, uid)?;

    Ok(Json(UnreadCountResponse {
        unread_count: counts.unread_count,
        archived_unread_count: counts.archived_unread_count,
        unread_chat_count: counts.unread_chat_count,
        archived_unread_chat_count: counts.archived_unread_chat_count,
    }))
}

/// PUT /chats/:chat_id/archive — Archive a chat and mute it indefinitely.
#[utoipa::path(
    put,
    path = "/archive",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn archive_chat(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
) -> Result<axum::http::StatusCode, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    diesel::update(
        group_membership::table.filter(
            group_membership::chat_id
                .eq(chat_id)
                .and(group_membership::uid.eq(uid)),
        ),
    )
    .set((
        group_membership::archived.eq(true),
        group_membership::muted_until.eq(Some(chat::indefinite_mute_until())),
    ))
    .execute(conn)?;

    state.ws_registry.broadcast_to_uids(
        &[uid],
        std::sync::Arc::new(ServerWsMessage::ChatArchiveStateChanged(
            ChatArchiveStateChangedPayload {
                chat_id,
                archived: true,
                muted_until: Some(chat::indefinite_mute_until()),
            },
        )),
    );

    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// DELETE /chats/:chat_id/archive — Unarchive a chat and unmute it.
#[utoipa::path(
    delete,
    path = "/archive",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn unarchive_chat(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
) -> Result<axum::http::StatusCode, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    diesel::update(
        group_membership::table.filter(
            group_membership::chat_id
                .eq(chat_id)
                .and(group_membership::uid.eq(uid)),
        ),
    )
    .set((
        group_membership::archived.eq(false),
        group_membership::muted_until.eq(None::<DateTime<Utc>>),
    ))
    .execute(conn)?;

    state.ws_registry.broadcast_to_uids(
        &[uid],
        std::sync::Arc::new(ServerWsMessage::ChatArchiveStateChanged(
            ChatArchiveStateChangedPayload {
                chat_id,
                archived: false,
                muted_until: None,
            },
        )),
    );

    Ok(axum::http::StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Recalculate a group's `last_message_id` and `last_message_at` columns
/// by finding the most recent non-deleted, top-level message in the group.
///
/// Call this after soft-deleting messages that might have been the latest.
pub(crate) fn recalculate_group_last_message(
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

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(get_chats))
        .routes(utoipa_axum::routes!(get_unread_count))
        .nest(
            "/{chat_id}",
            OpenApiRouter::new()
                .routes(utoipa_axum::routes!(archive_chat, unarchive_chat))
                .nest(
                    "/messages",
                    messages_router().nest("/{message_id}/reactions", reactions_router()),
                )
                .nest("/attachments", self::chat_attachments::router())
                .routes(utoipa_axum::routes!(mark_as_read))
                .routes(utoipa_axum::routes!(mark_as_unread))
                .routes(utoipa_axum::routes!(get_chat_unread_count))
                .routes(utoipa_axum::routes!(self::messages::post_thread_message))
                .nest(
                    "/threads/{thread_root_id}",
                    super::threads::subscribe_router(),
                )
                .nest("/saved-messages", self::saved_messages::router())
                .nest("/pins", super::pins::router()),
        )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{
        attachment_preview_text, build_push_preview_bundle, extract_mention_uids,
        first_attachment_kind, render_mentions_as_text, sticker_preview_text, MentionInfo,
        MessagePreview,
    };
    use crate::{
        dto::{attachments::AttachmentResponse, users::User},
        models::{Attachment, MessageType},
    };
    use chrono::Utc;
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn sticker_preview_text_includes_emoji_when_available() {
        assert_eq!(sticker_preview_text(Some("🙂")), "[Sticker] 🙂");
        assert_eq!(sticker_preview_text(None), "[Sticker]");
    }

    #[test]
    fn attachment_preview_text_uses_specific_labels() {
        assert_eq!(attachment_preview_text(Some("image/png")), "[Image]");
        assert_eq!(attachment_preview_text(Some("video/mp4")), "[Video]");
        assert_eq!(
            attachment_preview_text(Some("audio/webm")),
            "[Voice message]"
        );
        assert_eq!(
            attachment_preview_text(Some("application/pdf")),
            "[Attachment]"
        );
        assert_eq!(attachment_preview_text(None), "[Attachment]");
    }

    #[test]
    fn render_mentions_as_text_preserves_cjk_text() {
        let text = "@[uid:7] 你好，世界";
        let mentions = vec![MentionInfo {
            uid: 7,
            username: Some("Alice".to_string()),
            avatar_url: None,
            gender: 0,
            user_group: None,
        }];

        assert_eq!(
            render_mentions_as_text(text, &mentions),
            "@Alice 你好，世界"
        );
    }

    #[test]
    fn extract_mention_uids_keeps_scanning_after_cjk_text() {
        let text = "@[uid:7] 你好 @[uid:8]";
        assert_eq!(extract_mention_uids(text), vec![7, 8]);
    }

    #[test]
    fn render_mentions_as_text_leaves_invalid_tokens_untouched() {
        let text = "@[user:7] 你好";
        let mentions = vec![MentionInfo {
            uid: 7,
            username: Some("Alice".to_string()),
            avatar_url: None,
            gender: 0,
            user_group: None,
        }];

        assert_eq!(render_mentions_as_text(text, &mentions), text);
        assert!(extract_mention_uids(text).is_empty());
    }

    #[test]
    fn build_push_preview_bundle_uses_typed_invite_preview() {
        let response = super::MessageResponse {
            id: 1,
            message: Some("abc123".to_string()),
            message_type: MessageType::Invite,
            sticker: None,
            reply_root_id: None,
            client_generated_id: "cgid".to_string(),
            sender: User {
                uid: 7,
                avatar_url: None,
                name: Some("Alice".to_string()),
                gender: 0,
                user_group: None,
            },
            chat_id: 10,
            created_at: Utc::now(),
            is_edited: false,
            is_deleted: false,
            has_attachments: false,
            thread_info: None,
            reply_to_message: None,
            attachments: Vec::new(),
            reactions: Vec::new(),
            mentions: Vec::new(),
            forwarded_from: None,
        };

        let preview = build_push_preview_bundle(&response);
        assert_eq!(preview.body_preview, Some("sent an invite".to_string()));
        assert_eq!(preview.message_preview.message_type, MessageType::Invite);
        assert_eq!(preview.message_preview.message, None);
    }

    #[test]
    fn build_push_preview_bundle_uses_attachment_label_for_file_messages() {
        let response = super::MessageResponse {
            id: 1,
            message: Some("look at this".to_string()),
            message_type: MessageType::File,
            sticker: None,
            reply_root_id: None,
            client_generated_id: "cgid".to_string(),
            sender: User {
                uid: 7,
                avatar_url: None,
                name: Some("Alice".to_string()),
                gender: 0,
                user_group: None,
            },
            chat_id: 10,
            created_at: Utc::now(),
            is_edited: false,
            is_deleted: false,
            has_attachments: true,
            thread_info: None,
            reply_to_message: None,
            attachments: vec![AttachmentResponse {
                id: 1,
                url: "https://example.com/image.png".to_string(),
                kind: "image/png".to_string(),
                size: 123,
                file_name: "image.png".to_string(),
                width: Some(100),
                height: Some(100),
            }],
            reactions: Vec::new(),
            mentions: Vec::new(),
            forwarded_from: None,
        };

        let preview = build_push_preview_bundle(&response);
        assert_eq!(preview.body_preview, Some("[Image]".to_string()));
        assert_eq!(
            preview.message_preview.message,
            Some("look at this".to_string())
        );
        assert_eq!(
            preview.message_preview.first_attachment_kind,
            Some("image/png".to_string())
        );
    }

    #[test]
    fn serializes_reply_to_message_type_and_camel_case_keys() {
        let reply = MessagePreview {
            id: 42,
            client_generated_id: "cgid".to_string(),
            created_at: Utc::now(),
            sender: User {
                uid: 7,
                avatar_url: None,
                name: Some("Alice".to_string()),
                gender: 0,
                user_group: None,
            },
            message: Some("voice".to_string()),
            message_type: MessageType::Audio,
            sticker: None,
            first_attachment_kind: Some("audio/webm".to_string()),
            is_deleted: false,
            mentions: Vec::new(),
        };

        let value = serde_json::to_value(reply).expect("serialize reply_to_message");
        assert_eq!(value["clientGeneratedId"], json!("cgid"));
        assert_eq!(value["messageType"], json!("audio"));
        assert_eq!(value["isDeleted"], json!(false));
        assert_eq!(value["firstAttachmentKind"], json!("audio/webm"));
        assert!(value.get("message_type").is_none());
    }

    #[test]
    fn first_attachment_kind_can_be_read_multiple_times_for_same_message() {
        let attachment = Attachment {
            id: 1,
            message_id: Some(42),
            file_name: "image.png".to_string(),
            kind: "image/png".to_string(),
            external_reference: "attachments/image.png".to_string(),
            size: 123,
            created_at: Utc::now(),
            deleted_at: None,
            width: Some(100),
            height: Some(100),
            order: 0,
        };

        let mut attachments_map = HashMap::new();
        attachments_map.insert(42, vec![attachment]);

        assert_eq!(
            first_attachment_kind(&attachments_map, 42),
            Some("image/png".to_string())
        );
        assert_eq!(
            first_attachment_kind(&attachments_map, 42),
            Some("image/png".to_string())
        );
    }
}
