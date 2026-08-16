//! Message domain: composition rules, sending, previews and response hydration.
//!
//! Handlers own HTTP concerns and delegate here, so background services never
//! need to reach into a handler module for message logic.

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::PgConnection;

use crate::{
    dto::{
        attachments::AttachmentResponse,
        messages::{
            MentionInfo, MessagePreview, MessagePreviewAttachment, MessagePreviewSticker,
            MessageResponse, MessageStickerResponse, ReactionReactor, ReactionSummary,
            StickerMediaResponse, ThreadInfo,
        },
        users::User,
        ws::ServerWsMessage,
    },
    errors::AppError,
    models::{Attachment, Media, Message, MessageType, NewMessage, Sticker, TranscodeStatus},
    schema::{
        attachments, group_membership, groups, media, message_reactions,
        messages as messages_schema, stickers, user_favorite_stickers,
    },
    services::{
        push::{PushJob, PushMessagePreview, PushMessagePreviewSticker},
        user::{lookup_user_profiles, UserProfile},
    },
    utils::ids,
    AppState,
};

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
// Send request/result types
// ---------------------------------------------------------------------------

#[derive(Clone)]
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
}

pub(crate) struct SendMessageResult {
    pub inserted_message: Message,
    pub response: MessageResponse,
    pub member_uids: Vec<i32>,
    pub side_effects: PendingSideEffects,
}

pub(crate) enum SendMessageOutcome {
    Created(Box<SendMessageResult>),
    Duplicate(Box<MessageResponse>),
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

// ---------------------------------------------------------------------------
// Shared helper functions
// ---------------------------------------------------------------------------

fn load_username_by_uid(conn: &mut PgConnection, uid: i32) -> QueryResult<Option<String>> {
    lookup_user_profiles(conn, &[uid])
        .map(|mut profiles| profiles.remove(&uid).and_then(|profile| profile.username))
}

pub(crate) fn load_usernames_by_uids(
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
        .filter(messages_schema::is_published.eq(true))
        .select(Message::as_select())
        .load::<Message>(conn)
        .map(|rows| rows.into_iter().map(|msg| (msg.id, msg)).collect())
}

fn validate_reply_target(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_id: Option<i64>,
    reply_to_id: i64,
) -> Result<(), AppError> {
    let reply_msg = messages_schema::table
        .filter(messages_schema::id.eq(reply_to_id))
        .filter(messages_schema::chat_id.eq(chat_id))
        .filter(messages_schema::deleted_at.is_null())
        .filter(messages_schema::is_published.eq(true))
        .select(Message::as_select())
        .first::<Message>(conn)
        .optional()?;

    let Some(reply_msg) = reply_msg else {
        return Err(AppError::NotFound("Reply target message not found"));
    };

    let matches_thread_context = match thread_id {
        Some(thread_id) => reply_msg.id == thread_id || reply_msg.reply_root_id == Some(thread_id),
        None => reply_msg.reply_root_id.is_none(),
    };

    if !matches_thread_context {
        return Err(AppError::NotFound("Reply target message not found"));
    }

    Ok(())
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
    media: &crate::services::media::MediaStore,
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
            url: media.public_url(&media_row.storage_key),
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

pub(crate) fn message_response_preview(response: MessageResponse) -> MessagePreview {
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
        attachments: response
            .attachments
            .iter()
            .map(|a| MessagePreviewAttachment {
                kind: a.kind.clone(),
            })
            .collect(),
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

fn attachment_previews(
    map: &std::collections::HashMap<i64, Vec<Attachment>>,
    message_id: i64,
) -> Vec<MessagePreviewAttachment> {
    map.get(&message_id)
        .map(|atts| {
            atts.iter()
                .map(|a| MessagePreviewAttachment {
                    kind: a.kind.clone(),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) struct MessagePreviewInput {
    pub id: i64,
    pub client_generated_id: String,
    pub created_at: DateTime<Utc>,
    pub sender: User,
    pub message: Option<String>,
    pub message_type: MessageType,
    pub sticker_id: Option<i64>,
    pub attachments: Vec<MessagePreviewAttachment>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub mention_source: Option<String>,
    pub mention_uids: Option<Vec<i32>>,
}

pub(crate) fn build_message_preview(
    input: MessagePreviewInput,
    sticker_emoji_map: &std::collections::HashMap<i64, String>,
    user_avatars: &std::collections::HashMap<i32, Option<String>>,
    user_profiles: &std::collections::HashMap<i32, UserProfile>,
) -> MessagePreview {
    let MessagePreviewInput {
        id,
        client_generated_id,
        created_at,
        sender,
        message,
        message_type,
        sticker_id,
        attachments,
        deleted_at,
        mention_source,
        mention_uids,
    } = input;
    let is_deleted = deleted_at.is_some();
    let sticker_emoji = sticker_id.and_then(|sid| sticker_emoji_map.get(&sid).cloned());
    MessagePreview {
        id,
        client_generated_id,
        created_at,
        sender,
        message: if is_deleted { None } else { message },
        message_type,
        sticker: sticker_emoji
            .filter(|_| !is_deleted)
            .map(|emoji| MessagePreviewSticker { emoji }),
        attachments: if is_deleted { vec![] } else { attachments },
        is_deleted,
        mentions: mention_source
            .filter(|_| !is_deleted)
            .map(|text| {
                extract_mention_uids(&text)
                    .into_iter()
                    .map(|uid| build_mention_info(uid, user_avatars, user_profiles))
                    .collect()
            })
            .or_else(|| {
                mention_uids.map(|uids| {
                    uids.into_iter()
                        .map(|uid| build_mention_info(uid, user_avatars, user_profiles))
                        .collect()
                })
            })
            .unwrap_or_default(),
    }
}

#[cfg(test)]
pub(crate) fn message_is_visible_in_thread_scope(message: &Message, thread_root_id: i64) -> bool {
    if !message.is_published {
        return false;
    }

    if message.id == thread_root_id {
        return message.reply_root_id.is_none() && message.has_thread;
    }

    message.reply_root_id == Some(thread_root_id) && message.deleted_at.is_none()
}

pub(crate) fn redact_deleted_message_response(response: &mut MessageResponse) {
    if !response.is_deleted {
        return;
    }

    response.message = None;
    response.sticker = None;
    response.has_attachments = false;
    response.attachments.clear();
    response.reactions.clear();
    response.mentions.clear();
}

fn sticker_preview_text(emoji: Option<&str>) -> String {
    match emoji.filter(|value| !value.trim().is_empty()) {
        Some(emoji) => format!("[Sticker] {emoji}"),
        None => "[Sticker]".to_string(),
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
    let push_attachments: Vec<MessagePreviewAttachment> = response
        .attachments
        .iter()
        .map(|a| MessagePreviewAttachment {
            kind: a.kind.clone(),
        })
        .collect();
    let is_deleted = response.is_deleted;

    let body_preview = if is_deleted {
        None
    } else {
        match response.message_type {
            MessageType::Invite => Some("sent an invite".to_string()),
            MessageType::Sticker => Some(sticker_preview_text(
                response.sticker.as_ref().map(|s| s.emoji.as_str()),
            )),
            MessageType::File => Some("[Attachment]".to_string()),
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
            attachments: push_attachments,
            is_deleted,
        },
        body_preview,
        mentioned_uids,
    }
}

pub(crate) fn build_message_side_effects(
    conn: &mut PgConnection,
    response: &MessageResponse,
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

/// Maximum attachments a single message may carry.
pub(crate) const MAX_ATTACHMENTS_PER_MESSAGE: usize = 20;

/// Parses attachment IDs while preserving the request order.
///
/// The sequence is part of the message-composition contract. Callers that
/// need a deterministic database lock order must order their query separately.
pub(crate) fn parse_attachment_ids(raw_ids: &[String]) -> Result<Vec<i64>, AppError> {
    let mut ids = std::collections::HashSet::with_capacity(raw_ids.len());
    let mut parsed = Vec::with_capacity(raw_ids.len());
    for raw in raw_ids {
        let id = raw
            .parse::<i64>()
            .map_err(|_| AppError::BadRequest("Invalid attachment ID"))?;
        if !ids.insert(id) {
            return Err(AppError::BadRequest("Invalid attachment ID"));
        }
        parsed.push(id);
    }
    if parsed.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(AppError::BadRequest(
            "Too many attachments (maximum of 20 allowed)",
        ));
    }
    Ok(parsed)
}

/// Composition rules that need no attachment rows.
///
/// Checked before the message row is inserted so a malformed request cannot
/// reach the database and surface as a foreign-key 500, and so an idempotent
/// retry of a malformed payload is still rejected.
fn validate_message_shape(
    message_type: &MessageType,
    message: Option<&str>,
    sticker_id: Option<i64>,
) -> Result<(), AppError> {
    if sticker_id.is_some() && !matches!(message_type, MessageType::Sticker) {
        return Err(AppError::BadRequest(
            "Sticker ID is only valid for sticker messages",
        ));
    }
    if matches!(message_type, MessageType::Sticker) {
        if sticker_id.is_none() {
            return Err(AppError::BadRequest("Sticker ID is required"));
        }
        if message.is_some_and(|text| !text.trim().is_empty()) {
            return Err(AppError::BadRequest("Sticker messages cannot include text"));
        }
    }
    Ok(())
}

/// Single authority for message composition rules.
///
/// Every send and edit path routes through this function once the attachment
/// rows are loaded, so message-type semantics live in exactly one place.
/// Row-level attachment checks (ownership, deletion, existing linkage) stay
/// with the queries that lock those rows.
pub(crate) fn validate_message(
    message_type: &MessageType,
    message: Option<&str>,
    sticker_id: Option<i64>,
    attachments: &[Attachment],
) -> Result<(), AppError> {
    validate_message_shape(message_type, message, sticker_id)?;

    let has_text = message.is_some_and(|text| !text.trim().is_empty());
    let is_visual = |attachment: &Attachment| {
        attachment.kind.starts_with("image/") || attachment.kind.starts_with("video/")
    };

    if attachments.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(AppError::BadRequest(
            "Too many attachments (maximum of 20 allowed)",
        ));
    }

    match message_type {
        MessageType::Text => {
            if !has_text && attachments.is_empty() {
                Err(AppError::BadRequest("Message cannot be empty"))
            } else if attachments.iter().any(|attachment| !is_visual(attachment)) {
                Err(AppError::BadRequest(
                    "Text messages can only include images or videos",
                ))
            } else {
                Ok(())
            }
        }
        MessageType::File => {
            if has_text {
                Err(AppError::BadRequest("File messages cannot include text"))
            } else if attachments.is_empty() {
                Err(AppError::BadRequest("File messages must include a file"))
            } else {
                Ok(())
            }
        }
        MessageType::Audio => {
            if has_text || attachments.len() != 1 || !attachments[0].kind.starts_with("audio/") {
                Err(AppError::BadRequest(
                    "Voice messages require one audio attachment",
                ))
            } else {
                Ok(())
            }
        }
        MessageType::Sticker => {
            if attachments.is_empty() {
                Ok(())
            } else {
                Err(AppError::BadRequest(
                    "Sticker messages cannot include attachments",
                ))
            }
        }
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// send_prepared_message (shared by messages, invites, pins)
// ---------------------------------------------------------------------------

pub(crate) async fn send_prepared_message(
    conn: &mut PgConnection,
    state: &AppState,
    prepared: PreparedMessageSend,
) -> Result<SendMessageOutcome, AppError> {
    if let Some(reply_to_id) = prepared.reply_to_id {
        validate_reply_target(conn, prepared.chat_id, prepared.reply_root_id, reply_to_id)?;
    }
    validate_message_shape(
        &prepared.message_type,
        prepared.message.as_deref(),
        prepared.sticker_id,
    )?;

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

    // Sticker messages never persist text; validation below still inspects the
    // raw request text so a sticker sent with a caption is rejected, not
    // silently trimmed.
    let stored_message = if matches!(prepared.message_type, MessageType::Sticker) {
        None
    } else {
        prepared.message.clone()
    };

    let new_msg = NewMessage {
        id,
        message: stored_message.clone(),
        message_type,
        sticker_id: prepared.sticker_id,
        reply_to_id: prepared.reply_to_id,
        reply_root_id: prepared.reply_root_id,
        created_at: now,
        client_generated_id: prepared.client_generated_id.clone(),
        sender_uid: prepared.sender_uid,
        chat_id: prepared.chat_id,
        updated_at: None,
        deleted_at: None,
        has_attachments: !prepared.attachment_ids.is_empty(),
        has_thread: false,
        has_reactions: false,
        is_published: prepared.publish_immediately,
        transcode_status,
    };

    let inserted_msg: Option<Message> = diesel::insert_into(messages_schema::table)
        .values(&new_msg)
        .on_conflict(messages_schema::client_generated_id)
        .do_nothing()
        .returning(Message::as_returning())
        .get_result(conn)
        .optional()?;
    let Some(inserted_msg) = inserted_msg else {
        let existing = messages_schema::table
            .filter(messages_schema::client_generated_id.eq(&prepared.client_generated_id))
            .for_update()
            .select(Message::as_select())
            .first::<Message>(conn)
            .optional()?
            .ok_or(AppError::Conflict("Duplicate client generated id"))?;
        let existing_attachment_ids = load_message_attachment_ids(conn, existing.id)?;
        validate_idempotent_message_payload(
            &existing,
            &prepared,
            stored_message.as_deref(),
            &existing_attachment_ids,
        )?;
        let response = attach_metadata(
            conn,
            vec![existing],
            &state.media,
            &state.avatars,
            prepared.sender_uid,
        )
        .await
        .into_iter()
        .next()
        .ok_or(AppError::Internal("Failed to build message response"))?;
        return Ok(SendMessageOutcome::Duplicate(Box::new(response)));
    };

    let locked_attachments = if prepared.attachment_ids.is_empty() {
        Vec::new()
    } else {
        attachments::table
            .filter(crate::schema::attachments::dsl::id.eq_any(&prepared.attachment_ids))
            .order(crate::schema::attachments::dsl::id.asc())
            .for_update()
            .select(Attachment::as_select())
            .load::<Attachment>(conn)?
    };
    if locked_attachments.len() != prepared.attachment_ids.len()
        || locked_attachments.iter().any(|attachment| {
            attachment.deleted_at.is_some()
                || attachment.message_id.is_some()
                || attachment.uploader_uid != Some(prepared.sender_uid)
        })
    {
        return Err(AppError::BadRequest("Invalid attachment selection"));
    }
    validate_message(
        &prepared.message_type,
        prepared.message.as_deref(),
        prepared.sticker_id,
        &locked_attachments,
    )?;

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
        let associated = diesel::update(
            attachments::table
                .filter(a_dsl::id.eq_any(&prepared.attachment_ids))
                .filter(a_dsl::message_id.is_null())
                .filter(a_dsl::uploader_uid.eq(Some(prepared.sender_uid))),
        )
        .set(a_dsl::message_id.eq(id))
        .execute(conn)?;
        if associated != prepared.attachment_ids.len() {
            return Err(AppError::BadRequest("Invalid attachment selection"));
        }
    }

    let response = attach_metadata(
        conn,
        vec![inserted_msg.clone()],
        &state.media,
        &state.avatars,
        prepared.sender_uid,
    )
    .await
    .into_iter()
    .next()
    .ok_or(AppError::Internal("Failed to build message response"))?;

    let (member_uids, side_effects) = if prepared.publish_immediately {
        let side_effects = build_message_side_effects(
            conn,
            &response,
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

    // Counted once here so every sender - chat messages, invites, pins, member
    // system messages - increments the same counter. Duplicate retries return
    // early above and are not counted.
    state.metrics.chat.record_message(prepared.chat_id);

    Ok(SendMessageOutcome::Created(Box::new(SendMessageResult {
        inserted_message: inserted_msg,
        response,
        member_uids,
        side_effects,
    })))
}

fn load_message_attachment_ids(conn: &mut PgConnection, message_id: i64) -> QueryResult<Vec<i64>> {
    use crate::schema::attachments::dsl as a_dsl;
    attachments::table
        .filter(a_dsl::message_id.eq(message_id))
        .filter(a_dsl::deleted_at.is_null())
        .select(a_dsl::id)
        .order(a_dsl::id.asc())
        .load::<i64>(conn)
}

fn validate_idempotent_message_payload(
    existing: &Message,
    prepared: &PreparedMessageSend,
    stored_message: Option<&str>,
    existing_attachment_ids: &[i64],
) -> Result<(), AppError> {
    let mut prepared_attachment_ids = prepared.attachment_ids.clone();
    prepared_attachment_ids.sort_unstable();
    let mut existing_attachment_ids = existing_attachment_ids.to_vec();
    existing_attachment_ids.sort_unstable();

    let attachment_ids_match = existing_attachment_ids == prepared_attachment_ids;

    if existing.chat_id == prepared.chat_id
        && existing.sender_uid == prepared.sender_uid
        && existing.message.as_deref() == stored_message
        && existing.message_type == prepared.message_type
        && existing.sticker_id == prepared.sticker_id
        && existing.reply_to_id == prepared.reply_to_id
        && existing.reply_root_id == prepared.reply_root_id
        && attachment_ids_match
    {
        return Ok(());
    }

    Err(AppError::Conflict(
        "clientGeneratedId already exists with different payload",
    ))
}

// ---------------------------------------------------------------------------
// attach_metadata (shared by messages, threads, pins)
// ---------------------------------------------------------------------------

/// Attach reply_to_message to a list of messages by fetching referenced messages in one query.
pub async fn attach_metadata(
    conn: &mut PgConnection,
    messages_to_process: Vec<Message>,
    media: &crate::services::media::MediaStore,
    avatars: &crate::services::avatars::AvatarService,
    current_user_uid: i32,
) -> Vec<MessageResponse> {
    let mut reply_target_contexts: std::collections::HashMap<
        i64,
        std::collections::HashSet<(i64, Option<i64>)>,
    > = std::collections::HashMap::new();
    for message in &messages_to_process {
        if let Some(reply_to_id) = message.reply_to_id {
            reply_target_contexts
                .entry(reply_to_id)
                .or_default()
                .insert((message.chat_id, message.reply_root_id));
        }
    }
    let reply_ids: Vec<i64> = reply_target_contexts.keys().copied().collect();

    let mut reply_messages_map = load_reply_messages(conn, &reply_ids).unwrap_or_default();
    reply_messages_map.retain(|reply_id, reply_msg| {
        reply_target_contexts.get(reply_id).is_some_and(|contexts| {
            contexts.iter().any(|(chat_id, thread_id)| {
                reply_msg.chat_id == *chat_id
                    && match thread_id {
                        Some(thread_id) => {
                            reply_msg.id == *thread_id
                                || reply_msg.reply_root_id == Some(*thread_id)
                        }
                        None => reply_msg.reply_root_id.is_none(),
                    }
            })
        })
    });

    let mut avatar_uids = std::collections::HashSet::new();
    for m in &messages_to_process {
        avatar_uids.insert(m.sender_uid);
    }
    for reply_msg in reply_messages_map.values() {
        avatar_uids.insert(reply_msg.sender_uid);
    }
    let target_uids: Vec<i32> = avatar_uids.into_iter().collect();
    let mut user_avatars = avatars.lookup(&target_uids);
    let mut user_profiles = lookup_user_profiles(conn, &target_uids).unwrap_or_default();

    let mut message_attachments_map: std::collections::HashMap<i64, Vec<Attachment>> =
        std::collections::HashMap::new();
    let attachment_message_ids: Vec<i64> = messages_to_process
        .iter()
        .filter(|message| message.deleted_at.is_none())
        .map(|message| message.id)
        .chain(reply_messages_map.keys().copied())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    if !attachment_message_ids.is_empty() {
        use crate::schema::attachments::dsl as a_dsl;
        let attachments: Vec<Attachment> = match attachments::table
            .filter(a_dsl::message_id.eq_any(&attachment_message_ids))
            .filter(a_dsl::deleted_at.is_null())
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
        .filter(|m| m.deleted_at.is_none())
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
        let reactor_avatars = avatars.lookup(&all_reactor_uids);

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
        user_avatars.extend(avatars.lookup(&extra_mention_uids));
    }

    let mut responses = Vec::with_capacity(messages_to_process.len());
    for (idx, m) in messages_to_process.into_iter().enumerate() {
        let reply_to_message = m
            .reply_to_id
            .and_then(|reply_id| reply_messages_map.get(&reply_id))
            .filter(|reply_msg| {
                reply_msg.chat_id == m.chat_id
                    && match m.reply_root_id {
                        Some(thread_id) => {
                            reply_msg.id == thread_id || reply_msg.reply_root_id == Some(thread_id)
                        }
                        None => reply_msg.reply_root_id.is_none(),
                    }
            })
            .map(|reply_msg| {
                if reply_msg.deleted_at.is_none()
                    && reply_msg.has_attachments
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

                let sticker_emoji_map: std::collections::HashMap<i64, String> = sticker_rows
                    .iter()
                    .map(|(&id, (sticker, _))| (id, sticker.emoji.clone()))
                    .collect();
                let preview = build_message_preview(
                    MessagePreviewInput {
                        id: reply_msg.id,
                        client_generated_id: reply_msg.client_generated_id.clone(),
                        created_at: reply_msg.created_at,
                        sender: build_sender(reply_msg.sender_uid, &user_avatars, &user_profiles),
                        message: reply_msg.message.clone(),
                        message_type: reply_msg.message_type.clone(),
                        sticker_id: reply_msg.sticker_id,
                        attachments: attachment_previews(&message_attachments_map, reply_msg.id),
                        deleted_at: reply_msg.deleted_at,
                        mention_source: reply_msg.message.clone(),
                        mention_uids: None,
                    },
                    &sticker_emoji_map,
                    &user_avatars,
                    &user_profiles,
                );
                Box::new(preview)
            });

        let mut attachments = Vec::new();
        if m.deleted_at.is_none() {
            if let Some(atts) = message_attachments_map.get(&m.id) {
                for att in atts {
                    attachments.push(AttachmentResponse {
                        id: att.id,
                        url: media.public_url(&att.external_reference),
                        kind: att.kind.clone(),
                        size: att.size,
                        file_name: att.file_name.clone(),
                        width: att.width,
                        height: att.height,
                    });
                }
            }
        }

        let is_deleted = m.deleted_at.is_some();
        let mut response = MessageResponse {
            id: m.id,
            message: if is_deleted { None } else { m.message },
            message_type: m.message_type,
            sticker: m.sticker_id.and_then(|sticker_id| {
                (!is_deleted)
                    .then(|| {
                        sticker_rows.get(&sticker_id).map(|(sticker, media_row)| {
                            build_message_sticker_response(
                                media,
                                sticker,
                                media_row,
                                favorited_sticker_ids.contains(&sticker_id),
                            )
                        })
                    })
                    .flatten()
            }),
            reply_root_id: m.reply_root_id,
            client_generated_id: m.client_generated_id,
            sender: build_sender(m.sender_uid, &user_avatars, &user_profiles),
            chat_id: m.chat_id,
            created_at: m.created_at,
            is_edited: m.updated_at.is_some(),
            is_deleted,
            has_attachments: !is_deleted && m.has_attachments,
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
        };
        redact_deleted_message_response(&mut response);
        responses.push(response);
    }
    responses
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{
        build_message_preview, build_push_preview_bundle, extract_mention_uids,
        message_is_visible_in_thread_scope, parse_attachment_ids, redact_deleted_message_response,
        render_mentions_as_text, sticker_preview_text, validate_message, validate_message_shape,
        MentionInfo, MessagePreview, MessagePreviewAttachment, MessagePreviewInput,
        MessageResponse, MessageStickerResponse, PreparedMessageSend, ReactionSummary,
        StickerMediaResponse,
    };
    use crate::{
        dto::{attachments::AttachmentResponse, users::User},
        models::{Attachment, Message, MessageType, TranscodeStatus},
    };
    use chrono::{TimeZone, Utc};
    use serde_json::json;
    use std::collections::HashMap;

    fn attachment(kind: &str) -> Attachment {
        Attachment {
            id: 1,
            message_id: None,
            uploader_uid: Some(7),
            file_name: "file.bin".to_string(),
            kind: kind.to_string(),
            external_reference: "attachments/file.bin".to_string(),
            size: 10,
            created_at: Utc
                .timestamp_millis_opt(1_700_000_000_000)
                .single()
                .unwrap(),
            deleted_at: None,
            width: None,
            height: None,
            order: 0,
        }
    }

    #[test]
    fn validate_message_enforces_type_composition_rules() {
        // Text: needs content, and only visual attachments.
        assert!(validate_message(&MessageType::Text, Some("hi"), None, &[]).is_ok());
        assert!(validate_message(&MessageType::Text, Some("  "), None, &[]).is_err());
        assert!(
            validate_message(&MessageType::Text, None, None, &[attachment("image/png")]).is_ok()
        );
        assert!(validate_message(
            &MessageType::Text,
            Some("hi"),
            None,
            &[attachment("application/pdf")]
        )
        .is_err());

        // File: needs at least one attachment and cannot carry a caption.
        assert!(
            validate_message(&MessageType::File, None, None, &[attachment("image/png")]).is_ok()
        );
        assert!(validate_message(
            &MessageType::File,
            Some("caption"),
            None,
            &[attachment("application/pdf")]
        )
        .is_err());
        assert!(validate_message(&MessageType::File, None, None, &[]).is_err());

        // Audio: exactly one audio attachment and no text.
        assert!(
            validate_message(&MessageType::Audio, None, None, &[attachment("audio/ogg")]).is_ok()
        );
        assert!(validate_message(
            &MessageType::Audio,
            Some("caption"),
            None,
            &[attachment("audio/ogg")]
        )
        .is_err());

        // Sticker: requires an ID, rejects text and attachments.
        assert!(validate_message(&MessageType::Sticker, None, Some(5), &[]).is_ok());
        assert!(validate_message(&MessageType::Sticker, None, None, &[]).is_err());
        assert!(validate_message(&MessageType::Sticker, Some("hi"), Some(5), &[]).is_err());
        assert!(validate_message(
            &MessageType::Sticker,
            None,
            Some(5),
            &[attachment("image/png")]
        )
        .is_err());

        // A sticker ID never belongs on another message type.
        assert!(validate_message(&MessageType::Text, Some("hi"), Some(5), &[]).is_err());
    }

    /// The pre-insert gate keeps a malformed sticker payload out of the database,
    /// so it cannot surface as a foreign-key 500 or be accepted by an idempotent
    /// retry that never reaches the row-aware rules.
    #[test]
    fn validate_message_shape_rejects_sticker_payloads_without_loading_rows() {
        assert!(validate_message_shape(&MessageType::Sticker, None, Some(5)).is_ok());
        assert!(validate_message_shape(&MessageType::Sticker, Some("caption"), Some(5)).is_err());
        assert!(validate_message_shape(&MessageType::Sticker, None, None).is_err());
        assert!(validate_message_shape(&MessageType::Text, Some("hi"), Some(5)).is_err());

        // Row-dependent rules stay out of the pre-insert gate.
        assert!(validate_message_shape(&MessageType::Text, None, None).is_ok());
        assert!(validate_message_shape(&MessageType::File, None, None).is_ok());
    }

    fn message(id: i64, patch: impl FnOnce(&mut Message)) -> Message {
        let mut message = Message {
            id,
            message: Some(format!("message {id}")),
            message_type: MessageType::Text,
            reply_to_id: None,
            reply_root_id: None,
            client_generated_id: format!("client-{id}"),
            sender_uid: 7,
            chat_id: 10,
            created_at: Utc
                .timestamp_millis_opt(1_700_000_000_000 + id)
                .single()
                .unwrap(),
            updated_at: None,
            deleted_at: None,
            has_attachments: false,
            has_thread: false,
            has_reactions: false,
            sticker_id: None,
            is_published: true,
            transcode_status: TranscodeStatus::None,
        };
        patch(&mut message);
        message
    }

    fn sender() -> User {
        User {
            uid: 7,
            avatar_url: None,
            name: Some("Alice".to_string()),
            gender: 0,
            user_group: None,
        }
    }

    fn attachment_response() -> AttachmentResponse {
        AttachmentResponse {
            id: 1,
            url: "https://example.com/secret.png".to_string(),
            kind: "image/png".to_string(),
            size: 123,
            file_name: "secret.png".to_string(),
            width: Some(100),
            height: Some(100),
        }
    }

    fn sticker_response() -> MessageStickerResponse {
        MessageStickerResponse {
            id: 1,
            emoji: "🙂".to_string(),
            name: Some("smile".to_string()),
            description: None,
            created_at: Utc::now(),
            is_favorited: false,
            media: StickerMediaResponse {
                id: 2,
                url: "https://example.com/sticker.webp".to_string(),
                content_type: "image/webp".to_string(),
                size: 456,
                width: Some(128),
                height: Some(128),
            },
        }
    }
    #[test]
    fn parse_attachment_ids_preserves_request_order() {
        let raw = vec!["30".to_string(), "10".to_string(), "20".to_string()];

        assert_eq!(parse_attachment_ids(&raw).unwrap(), vec![30, 10, 20]);
    }

    #[test]
    fn sticker_preview_text_includes_emoji_when_available() {
        assert_eq!(sticker_preview_text(Some("🙂")), "[Sticker] 🙂");
        assert_eq!(sticker_preview_text(None), "[Sticker]");
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
    fn idempotent_message_payload_accepts_identical_top_level_message() {
        let existing = test_message();
        let prepared = test_prepared_message();

        assert!(super::validate_idempotent_message_payload(
            &existing,
            &prepared,
            Some("hello"),
            &[10, 11]
        )
        .is_ok());
    }

    #[test]
    fn idempotent_message_payload_rejects_different_text() {
        let existing = test_message();
        let prepared = PreparedMessageSend {
            message: Some("different".to_string()),
            ..test_prepared_message()
        };

        assert!(matches!(
            super::validate_idempotent_message_payload(
                &existing,
                &prepared,
                Some("different"),
                &[10, 11]
            ),
            Err(super::AppError::Conflict(_))
        ));
    }

    #[test]
    fn idempotent_message_payload_rejects_different_thread_context() {
        let existing = Message {
            reply_root_id: Some(99),
            ..test_message()
        };
        let prepared = test_prepared_message();

        assert!(matches!(
            super::validate_idempotent_message_payload(
                &existing,
                &prepared,
                Some("hello"),
                &[10, 11]
            ),
            Err(super::AppError::Conflict(_))
        ));
    }

    #[test]
    fn idempotent_message_payload_rejects_different_attachment_set() {
        let existing = test_message();
        let prepared = test_prepared_message();

        assert!(matches!(
            super::validate_idempotent_message_payload(
                &existing,
                &prepared,
                Some("hello"),
                &[10, 12]
            ),
            Err(super::AppError::Conflict(_))
        ));
    }

    #[test]
    fn idempotent_message_payload_accepts_audio_with_original_attachment_id() {
        let existing = Message {
            message_type: MessageType::Audio,
            message: Some(String::new()),
            has_attachments: true,
            transcode_status: TranscodeStatus::Done,
            ..test_message()
        };
        let prepared = PreparedMessageSend {
            message_type: MessageType::Audio,
            message: Some(String::new()),
            attachment_ids: vec![55],
            publish_immediately: false,
            ..test_prepared_message()
        };

        assert!(
            super::validate_idempotent_message_payload(&existing, &prepared, Some(""), &[55])
                .is_ok()
        );
    }

    fn test_message() -> Message {
        Message {
            id: 1,
            message: Some("hello".to_string()),
            message_type: MessageType::Text,
            reply_to_id: Some(5),
            reply_root_id: None,
            client_generated_id: "client-1".to_string(),
            sender_uid: 7,
            chat_id: 42,
            created_at: Utc::now(),
            updated_at: None,
            deleted_at: None,
            has_attachments: true,
            has_thread: false,
            has_reactions: false,
            sticker_id: None,
            is_published: true,
            transcode_status: TranscodeStatus::None,
        }
    }

    fn test_prepared_message() -> PreparedMessageSend {
        PreparedMessageSend {
            chat_id: 42,
            sender_uid: 7,
            message: Some("hello".to_string()),
            message_type: MessageType::Text,
            sticker_id: None,
            reply_to_id: Some(5),
            reply_root_id: None,
            client_generated_id: "client-1".to_string(),
            attachment_ids: vec![10, 11],
            publish_immediately: true,
        }
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
        };

        let preview = build_push_preview_bundle(&response);
        assert_eq!(preview.body_preview, Some("[Attachment]".to_string()));
        assert_eq!(
            preview.message_preview.message,
            Some("look at this".to_string())
        );
        assert_eq!(
            preview.message_preview.attachments,
            vec![MessagePreviewAttachment {
                kind: "image/png".to_string()
            }]
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
            attachments: vec![MessagePreviewAttachment {
                kind: "audio/webm".to_string(),
            }],
            is_deleted: false,
            mentions: Vec::new(),
        };

        let value = serde_json::to_value(reply).expect("serialize reply_to_message");
        assert_eq!(value["clientGeneratedId"], json!("cgid"));
        assert_eq!(value["messageType"], json!("audio"));
        assert_eq!(value["isDeleted"], json!(false));
        assert_eq!(value["attachments"], json!([{"kind": "audio/webm"}]));
        assert!(value.get("message_type").is_none());
    }

    #[test]
    fn thread_scope_visibility_allows_only_deleted_root_shell_exception() {
        let root_id = 10;
        let deleted_root = message(root_id, |message| {
            message.deleted_at = Some(Utc::now());
            message.has_thread = true;
        });
        let deleted_reply = message(11, |message| {
            message.reply_root_id = Some(root_id);
            message.deleted_at = Some(Utc::now());
        });
        let deleted_non_root = message(12, |message| {
            message.deleted_at = Some(Utc::now());
        });
        let visible_reply = message(13, |message| {
            message.reply_root_id = Some(root_id);
        });

        assert!(message_is_visible_in_thread_scope(&deleted_root, root_id));
        assert!(!message_is_visible_in_thread_scope(&deleted_reply, root_id));
        assert!(!message_is_visible_in_thread_scope(
            &deleted_non_root,
            root_id
        ));
        assert!(message_is_visible_in_thread_scope(&visible_reply, root_id));
    }

    #[test]
    fn deleted_message_response_redaction_preserves_metadata_only() {
        let mut response = MessageResponse {
            id: 10,
            message: Some("secret root".to_string()),
            message_type: MessageType::Text,
            sticker: Some(sticker_response()),
            reply_root_id: None,
            client_generated_id: "client-10".to_string(),
            sender: sender(),
            chat_id: 1,
            created_at: Utc::now(),
            is_edited: true,
            is_deleted: true,
            has_attachments: true,
            thread_info: Some(super::ThreadInfo { reply_count: 2 }),
            reply_to_message: None,
            attachments: vec![attachment_response()],
            reactions: vec![ReactionSummary {
                emoji: "👍".to_string(),
                count: 1,
                reacted_by_me: Some(true),
                reactors: None,
            }],
            mentions: vec![MentionInfo {
                uid: 9,
                username: Some("Mentioned".to_string()),
                avatar_url: None,
                gender: 0,
                user_group: None,
            }],
        };

        redact_deleted_message_response(&mut response);

        assert_eq!(response.id, 10);
        assert_eq!(response.client_generated_id, "client-10");
        assert_eq!(response.sender.uid, 7);
        assert!(response.is_edited);
        assert!(response.is_deleted);
        assert_eq!(
            response.thread_info.as_ref().map(|info| info.reply_count),
            Some(2)
        );
        assert_eq!(response.message, None);
        assert!(response.sticker.is_none());
        assert!(!response.has_attachments);
        assert!(response.attachments.is_empty());
        assert!(response.reactions.is_empty());
        assert!(response.mentions.is_empty());
    }

    #[test]
    fn build_message_preview_deleted_message_clears_sensitive_data() {
        let sticker_map = HashMap::from([(42, "🙂".to_string())]);
        let preview = build_message_preview(
            MessagePreviewInput {
                id: 10,
                client_generated_id: "client-10".to_string(),
                created_at: Utc::now(),
                sender: sender(),
                message: Some("secret root".to_string()),
                message_type: MessageType::Text,
                sticker_id: Some(42),
                attachments: vec![MessagePreviewAttachment {
                    kind: "image/png".to_string(),
                }],
                deleted_at: Some(Utc::now()),
                mention_source: Some("@mention".to_string()),
                mention_uids: None,
            },
            &sticker_map,
            &HashMap::new(),
            &HashMap::new(),
        );

        assert_eq!(preview.id, 10);
        assert_eq!(preview.client_generated_id, "client-10");
        assert_eq!(preview.sender.uid, 7);
        assert!(preview.is_deleted);
        assert_eq!(preview.message, None);
        assert!(preview.sticker.is_none());
        assert!(preview.attachments.is_empty());
        assert!(preview.mentions.is_empty());
    }
}
