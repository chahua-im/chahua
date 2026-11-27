//! Message domain: composition rules, sending, previews and response hydration.
//!
//! Handlers own HTTP concerns and delegate here, so background services never
//! need to reach into a handler module for message logic.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::PgConnection;

use crate::{
    dto::{
        attachments::{AttachmentResponse, AttachmentSnapshot},
        messages::{
            ForwardedBundlePayloadItem, ForwardedBundleRefSnapshot,
            ForwardedMessagePreviewResponse, ForwardedMessagePreviewSnapshot,
            ForwardedMessageResponse, ForwardedMessageSnapshot, ForwardedMessagesPreviewResponse,
            ForwardedMessagesPreviewSnapshot, ForwardedMessagesResponse, ForwardedReplyResponse,
            ForwardedReplySnapshot, ForwardedStickerSnapshot, MentionInfo, MessagePreview,
            MessagePreviewAttachment, MessagePreviewSticker, MessageResponse,
            MessageStickerResponse, ReactionReactor, ReactionSummary, StickerMediaResponse,
            ThreadInfo,
        },
        users::User,
        ws::{NotificationPayload, NotificationType, ServerWsMessage},
    },
    errors::AppError,
    metrics::Metrics,
    models::{
        Attachment, ForwardPlaceholder, ForwardedBundle, GroupKind, GroupRole, Media, MentionKind,
        Message, MessageMention, MessageType, NewMessage, SpeakingMode, Sticker, TranscodeStatus,
    },
    schema::{
        attachments, forwarded_bundles, group_membership, groups, media, message_mentions,
        message_reactions, messages as messages_schema, stickers, user_favorite_stickers,
    },
    services::{
        avatars::AvatarService,
        media::MediaStore,
        push::{PushJob, PushMessagePreview, PushMessagePreviewSticker, PushService},
        social::{self, DmSendAuthorizationError},
        speaking::{self, SpeakingAction},
        user::{lookup_user_profiles, lookup_usernames, UserProfile},
        ws_registry::ConnectionRegistry,
    },
    utils::ids::{self, IdGen},
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
pub struct PreparedMessageSend {
    pub system_kind: Option<crate::models::SystemMessageKind>,
    pub forwarded_from_message_id: Option<i64>,
    pub chat_id: i64,
    pub chat_kind: GroupKind,
    pub sender_uid: i32,
    pub message: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub message_type: MessageType,
    pub sticker_id: Option<i64>,
    pub reply_to_id: Option<i64>,
    pub reply_root_id: Option<i64>,
    pub client_generated_id: String,
    pub attachment_ids: Vec<i64>,
    pub publish_immediately: bool,
    pub forwarded_bundle_id: Option<i64>,
    pub forwarded_preview_total: Option<usize>,
    pub forwarded_preview_contains_forwarded_messages: Option<bool>,
    pub forwarded_preview_items: Option<Vec<ForwardedMessagePreviewSnapshot>>,
}

/// Authorization failures for a user-originated message send.
#[derive(Debug)]
pub enum MessageSendAuthorizationError {
    NotChatMember,
    ThreadRootNotFound,
    ThreadRootNotText,
    InvalidDmParticipants,
    GroupChatWriteRestricted,
    SpeakingRestricted(SpeakingMode),
    DirectMessage(DmSendAuthorizationError),
    Database(diesel::result::Error),
}

impl From<diesel::result::Error> for MessageSendAuthorizationError {
    fn from(error: diesel::result::Error) -> Self {
        Self::Database(error)
    }
}

impl From<DmSendAuthorizationError> for MessageSendAuthorizationError {
    fn from(error: DmSendAuthorizationError) -> Self {
        Self::DirectMessage(error)
    }
}

impl From<MessageSendAuthorizationError> for AppError {
    fn from(error: MessageSendAuthorizationError) -> Self {
        match error {
            MessageSendAuthorizationError::NotChatMember => {
                AppError::Forbidden("Not a member of this chat")
            }
            MessageSendAuthorizationError::ThreadRootNotFound => {
                AppError::NotFound("Thread root message not found")
            }
            MessageSendAuthorizationError::ThreadRootNotText => {
                AppError::BadRequest("Threads can only be created on text messages")
            }
            MessageSendAuthorizationError::InvalidDmParticipants => {
                // The caller is a member of a DM row but matches neither
                // dm_uid (e.g. a zombie membership); that is a forbidden
                // participant, not a server fault.
                AppError::Forbidden("Not a participant of this chat")
            }
            MessageSendAuthorizationError::GroupChatWriteRestricted => {
                AppError::GroupChatWriteRestricted
            }
            MessageSendAuthorizationError::SpeakingRestricted(mode) => {
                AppError::SpeakingRestricted(mode)
            }
            MessageSendAuthorizationError::DirectMessage(error) => AppError::from(error),
            MessageSendAuthorizationError::Database(error) => AppError::from(error),
        }
    }
}

/// Target context established by [`authorize_message_send`].
pub struct AuthorizedMessageTarget {
    pub kind: GroupKind,
    pub thread_root: Option<Message>,
}

pub struct SendMessageResult {
    pub inserted_message: Message,
    pub response: MessageResponse,
    pub member_uids: Vec<i32>,
    pub side_effects: PendingSideEffects,
}

pub enum SendMessageOutcome {
    Created(Box<SendMessageResult>),
    Duplicate(Box<MessageResponse>),
}

#[must_use = "side effects must be fired via .fire()"]
pub struct PendingSideEffects {
    pub ws_msg: std::sync::Arc<ServerWsMessage>,
    pub broadcast_uids: Vec<i32>,
    pub push_job: Option<PushJob>,
    pub notifications: Vec<(i32, std::sync::Arc<ServerWsMessage>)>,
}

impl PendingSideEffects {
    /// Fire WS broadcast and push notification. Call after transaction commit.
    pub fn fire(self, ws_registry: &Arc<ConnectionRegistry>, push_service: &Arc<PushService>) {
        ws_registry.broadcast_to_uids(&self.broadcast_uids, self.ws_msg);
        if let Some(job) = self.push_job {
            push_service.enqueue(job);
        }
        // The send path clones one payload Arc for every mentioned member; group
        // adjacent equal payloads so each broadcast goes out in a single registry
        // pass instead of one call per user.
        let mut batched: Vec<(std::sync::Arc<ServerWsMessage>, Vec<i32>)> = Vec::new();
        for (uid, msg) in self.notifications {
            match batched.last_mut() {
                Some((last_msg, last_uids)) if std::sync::Arc::ptr_eq(last_msg, &msg) => {
                    last_uids.push(uid);
                }
                _ => batched.push((msg, vec![uid])),
            }
        }
        for (msg, uids) in batched {
            ws_registry.broadcast_to_uids(&uids, msg);
        }
    }
}

pub struct MessageWriter {
    pub id_gen: Arc<IdGen>,
    pub media: MediaStore,
    pub avatars: Arc<AvatarService>,
    pub metrics: Arc<Metrics>,
}

// ---------------------------------------------------------------------------
// Shared helper functions
// ---------------------------------------------------------------------------

pub fn load_username_by_uid(conn: &mut PgConnection, uid: i32) -> QueryResult<Option<String>> {
    lookup_usernames(conn, &[uid]).map(|mut names| names.remove(&uid))
}

pub fn load_usernames_by_uids(
    conn: &mut PgConnection,
    uids: &[i32],
) -> std::collections::HashMap<i32, Option<String>> {
    lookup_usernames(conn, uids)
        .unwrap_or_default()
        .into_iter()
        .map(|(uid, name)| (uid, Some(name)))
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
        .filter(messages_schema::is_published.eq(true))
        .select((messages_schema::reply_root_id, messages_schema::system_kind))
        .first::<(Option<i64>, Option<crate::models::SystemMessageKind>)>(conn)
        .optional()?;

    let Some((reply_root_id, system_kind)) = reply_msg else {
        return Err(AppError::NotFound("Reply target message not found"));
    };

    if system_kind.is_some_and(|kind| kind.is_membership()) {
        return Err(AppError::BadRequest("Cannot reply to membership messages"));
    }
    let matches_thread_context = match thread_id {
        Some(thread_id) => reply_to_id == thread_id || reply_root_id == Some(thread_id),
        None => reply_root_id.is_none(),
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

pub fn build_sender(
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

pub(crate) fn attachment_previews(
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

pub struct MessagePreviewInput {
    pub metadata: Option<crate::dto::link_previews::MessageMetadataResponse>,
    pub system_kind: Option<crate::models::SystemMessageKind>,
    pub forwarded_from_name: Option<String>,
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

pub fn build_message_preview(
    input: MessagePreviewInput,
    sticker_emoji_map: &std::collections::HashMap<i64, String>,
    user_avatars: &std::collections::HashMap<i32, Option<String>>,
    user_profiles: &std::collections::HashMap<i32, UserProfile>,
) -> MessagePreview {
    let MessagePreviewInput {
        metadata,
        system_kind,
        forwarded_from_name,
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
    let (message, system_links) = super::system_messages::decode(&message_type, message);
    MessagePreview {
        metadata: metadata.filter(|_| !is_deleted),
        system_kind,
        system_links: system_links.filter(|_| !is_deleted),
        forwarded_from_name: forwarded_from_name.filter(|_| !is_deleted),
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
pub fn message_is_visible_in_thread_scope(message: &Message, thread_root_id: i64) -> bool {
    if !message.is_published {
        return false;
    }

    if message.id == thread_root_id {
        return message.reply_root_id.is_none() && message.has_thread;
    }

    message.reply_root_id == Some(thread_root_id) && message.deleted_at.is_none()
}

pub fn redact_deleted_message_response(response: &mut MessageResponse) {
    if !response.is_deleted {
        return;
    }

    response.message = None;
    response.metadata = None;
    response.system_links = None;
    response.sticker = None;
    response.has_attachments = false;
    response.attachments.clear();
    response.reactions.clear();
    response.mentions.clear();
    response.forwarded_preview = None;
    response.forwarded_from = None;
}

pub const FORWARDED_PREVIEW_LIMIT: usize = 3;

fn build_forwarded_reply_snapshot(
    reply_to_id: Option<i64>,
    selected_message_ids: &std::collections::HashSet<i64>,
) -> Option<ForwardedReplySnapshot> {
    reply_to_id.map(|original_message_id| {
        if selected_message_ids.contains(&original_message_id) {
            ForwardedReplySnapshot::Internal {
                original_message_id,
            }
        } else {
            ForwardedReplySnapshot::Redacted
        }
    })
}

fn forwarded_bundle_item_original_message_id(item: &ForwardedBundlePayloadItem) -> i64 {
    match item {
        ForwardedBundlePayloadItem::MessageSnapshot { snapshot } => snapshot.original_message_id,
        ForwardedBundlePayloadItem::ForwardedBundleRef { bundle_ref } => {
            bundle_ref.original_message_id
        }
    }
}

fn load_forwarded_sticker_snapshots(
    conn: &mut PgConnection,
    source_messages: &[Message],
) -> Result<std::collections::HashMap<i64, ForwardedStickerSnapshot>, AppError> {
    let sticker_ids: Vec<i64> = source_messages
        .iter()
        .filter_map(|message| message.sticker_id)
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    let sticker_rows = load_sticker_rows(conn, &sticker_ids)?;

    Ok(sticker_rows
        .into_iter()
        .map(|(sticker_id, (sticker, media_row))| {
            (
                sticker_id,
                ForwardedStickerSnapshot {
                    id: sticker.id,
                    media_id: media_row.id,
                    media_storage_key: media_row.storage_key,
                    emoji: sticker.emoji,
                    name: sticker.name,
                    description: sticker.description,
                    created_at: sticker.created_at,
                    content_type: media_row.content_type,
                    size: media_row.size,
                    width: media_row.width,
                    height: media_row.height,
                },
            )
        })
        .collect())
}

fn load_forwarded_attachment_snapshots(
    conn: &mut PgConnection,
    source_messages: &[Message],
) -> Result<std::collections::HashMap<i64, Vec<AttachmentSnapshot>>, AppError> {
    let message_ids: Vec<i64> = source_messages.iter().map(|message| message.id).collect();
    if message_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    use crate::schema::attachments::dsl as a_dsl;
    let attachments: Vec<Attachment> = attachments::table
        .filter(a_dsl::message_id.eq_any(message_ids))
        .filter(a_dsl::deleted_at.is_null())
        .order((a_dsl::message_id.asc(), a_dsl::order.asc(), a_dsl::id.asc()))
        .select(Attachment::as_select())
        .load(conn)?;

    let mut by_message_id = std::collections::HashMap::new();
    for attachment in attachments {
        let Some(message_id) = attachment.message_id else {
            continue;
        };
        by_message_id
            .entry(message_id)
            .or_insert_with(Vec::new)
            .push(AttachmentSnapshot {
                id: attachment.id,
                external_reference: attachment.external_reference,
                kind: attachment.kind,
                size: attachment.size,
                file_name: attachment.file_name,
                width: attachment.width,
                height: attachment.height,
            });
    }
    Ok(by_message_id)
}

pub(crate) fn snapshot_link_metadata(
    message: &Message,
) -> Option<crate::dto::link_previews::StoredMessageMetadata> {
    let metadata = message.metadata.as_ref()?;
    match crate::services::link_previews::snapshot_metadata(metadata)
        .and_then(|snapshot| snapshot.map(serde_json::from_value).transpose())
    {
        Ok(snapshot) => snapshot,
        Err(_) => {
            tracing::warn!(
                message_id = message.id,
                "invalid link preview metadata in snapshot source"
            );
            None
        }
    }
}

fn build_forwarded_message_snapshot(
    source_message: &Message,
    attachments: Vec<AttachmentSnapshot>,
    sticker_snapshots: &std::collections::HashMap<i64, ForwardedStickerSnapshot>,
    selected_message_ids: &std::collections::HashSet<i64>,
) -> Result<ForwardedMessageSnapshot, AppError> {
    let sticker = source_message
        .sticker_id
        .map(|sticker_id| {
            sticker_snapshots
                .get(&sticker_id)
                .cloned()
                .ok_or(AppError::Internal("Forwarded sticker snapshot missing"))
        })
        .transpose()?;

    Ok(ForwardedMessageSnapshot {
        original_message_id: source_message.id,
        original_chat_id: source_message.chat_id,
        message: source_message.message.clone(),
        message_type: source_message.message_type.clone(),
        sender_uid: source_message.sender_uid,
        original_created_at: source_message.created_at,
        sticker,
        reply: build_forwarded_reply_snapshot(source_message.reply_to_id, selected_message_ids),
        attachments,
        metadata: snapshot_link_metadata(source_message),
        mention_uids: source_message
            .message
            .as_deref()
            .map(extract_mention_uids)
            .unwrap_or_default(),
    })
}

fn build_forwarded_bundle_ref_snapshot(
    source_message: &Message,
    referenced_bundle_previews: &std::collections::HashMap<i64, ForwardedMessagesPreviewSnapshot>,
    selected_message_ids: &std::collections::HashSet<i64>,
) -> Result<ForwardedBundleRefSnapshot, AppError> {
    let forwarded_bundle_id = source_message
        .forwarded_bundle_id
        .ok_or(AppError::BadRequest(
            "Forwarded source message has no bundle",
        ))?;
    let preview = referenced_bundle_previews
        .get(&forwarded_bundle_id)
        .cloned()
        .ok_or(AppError::BadRequest("Forwarded source bundle not found"))?;

    Ok(ForwardedBundleRefSnapshot {
        original_message_id: source_message.id,
        original_chat_id: source_message.chat_id,
        forwarded_bundle_id,
        message: source_message.message.clone(),
        message_type: source_message.message_type.clone(),
        sender_uid: source_message.sender_uid,
        original_created_at: source_message.created_at,
        reply: build_forwarded_reply_snapshot(source_message.reply_to_id, selected_message_ids),
        preview,
    })
}

/// Capture the immutable, durable forwarding payload directly from message rows.
///
/// This intentionally avoids response hydration: reactions, timeline metadata,
/// user profiles, URLs, and favorite state are reader-specific and must not be
/// baked into a forwarding bundle.
pub(crate) fn capture_forwarded_bundle_items(
    conn: &mut PgConnection,
    source_messages: &[Message],
    allow_placeholders: bool,
) -> Result<Vec<ForwardedBundlePayloadItem>, AppError> {
    let selected_message_ids: std::collections::HashSet<i64> =
        source_messages.iter().map(|message| message.id).collect();
    let mut placeholders = std::collections::HashMap::new();
    for message in source_messages {
        if let Some(reason) = super::forwarding::source_placeholder(message, allow_placeholders)? {
            placeholders.insert(message.id, reason);
        }
    }
    // Do not even capture temporary media keys for pending audio.
    let stable_sources: Vec<Message> = source_messages
        .iter()
        .filter(|message| !placeholders.contains_key(&message.id))
        .cloned()
        .collect();
    let mut attachment_snapshots = load_forwarded_attachment_snapshots(conn, &stable_sources)?;
    let sticker_snapshots = load_forwarded_sticker_snapshots(conn, &stable_sources)?;
    let referenced_bundle_ids: Vec<i64> = source_messages
        .iter()
        .filter(|message| matches!(&message.message_type, MessageType::Forwarded))
        .filter_map(|message| message.forwarded_bundle_id)
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    let referenced_bundle_previews = load_forwarded_bundle_previews(conn, &referenced_bundle_ids)?;
    for message in source_messages {
        if message
            .forwarded_bundle_id
            .and_then(|id| referenced_bundle_previews.get(&id))
            .is_some_and(|preview| preview.contains_forwarded_messages)
        {
            if !allow_placeholders {
                return Err(AppError::BadRequest(
                    "Forwarded messages cannot include nested forwarded messages",
                ));
            }
            placeholders.insert(message.id, ForwardPlaceholder::NestedForward);
        }
    }

    source_messages
        .iter()
        .map(|source_message| {
            if let Some(&reason) = placeholders.get(&source_message.id) {
                return Ok(ForwardedBundlePayloadItem::MessageSnapshot {
                    snapshot: ForwardedMessageSnapshot {
                        original_message_id: source_message.id,
                        original_chat_id: source_message.chat_id,
                        message: Some(reason.as_str().to_owned()),
                        message_type: MessageType::Placeholder,
                        sender_uid: source_message.sender_uid,
                        original_created_at: source_message.created_at,
                        sticker: None,
                        reply: build_forwarded_reply_snapshot(
                            source_message.reply_to_id,
                            &selected_message_ids,
                        ),
                        attachments: Vec::new(),
                        metadata: None,
                        mention_uids: Vec::new(),
                    },
                });
            }
            if matches!(&source_message.message_type, MessageType::Forwarded) {
                Ok(ForwardedBundlePayloadItem::ForwardedBundleRef {
                    bundle_ref: build_forwarded_bundle_ref_snapshot(
                        source_message,
                        &referenced_bundle_previews,
                        &selected_message_ids,
                    )?,
                })
            } else {
                Ok(ForwardedBundlePayloadItem::MessageSnapshot {
                    snapshot: build_forwarded_message_snapshot(
                        source_message,
                        attachment_snapshots
                            .remove(&source_message.id)
                            .unwrap_or_default(),
                        &sticker_snapshots,
                        &selected_message_ids,
                    )?,
                })
            }
        })
        .collect()
}

fn preview_snapshot_from_item(
    item: &ForwardedBundlePayloadItem,
) -> ForwardedMessagePreviewSnapshot {
    match item {
        ForwardedBundlePayloadItem::MessageSnapshot { snapshot } => {
            ForwardedMessagePreviewSnapshot {
                metadata: snapshot
                    .metadata
                    .clone()
                    .map(super::link_previews::summary_metadata),
                original_message_id: snapshot.original_message_id,
                original_chat_id: snapshot.original_chat_id,
                message: snapshot.message.clone(),
                message_type: snapshot.message_type.clone(),
                sender_uid: snapshot.sender_uid,
                original_created_at: snapshot.original_created_at,
                attachments: snapshot
                    .attachments
                    .iter()
                    .map(|attachment| MessagePreviewAttachment {
                        kind: attachment.kind.clone(),
                    })
                    .collect(),
                sticker: snapshot
                    .sticker
                    .as_ref()
                    .map(|sticker| MessagePreviewSticker {
                        emoji: sticker.emoji.clone(),
                    }),
                mention_uids: snapshot.mention_uids.clone(),
            }
        }
        ForwardedBundlePayloadItem::ForwardedBundleRef { bundle_ref } => {
            ForwardedMessagePreviewSnapshot {
                metadata: None,
                original_message_id: bundle_ref.original_message_id,
                original_chat_id: bundle_ref.original_chat_id,
                message: bundle_ref.message.clone(),
                message_type: bundle_ref.message_type.clone(),
                sender_uid: bundle_ref.sender_uid,
                original_created_at: bundle_ref.original_created_at,
                attachments: Vec::new(),
                sticker: None,
                mention_uids: Vec::new(),
            }
        }
    }
}

pub(crate) fn build_forwarded_preview_items(
    items: &[ForwardedBundlePayloadItem],
) -> Vec<ForwardedMessagePreviewSnapshot> {
    items
        .iter()
        .take(FORWARDED_PREVIEW_LIMIT)
        .map(preview_snapshot_from_item)
        .collect()
}

pub(crate) fn build_forwarded_preview_payload(
    items: &[ForwardedMessagePreviewSnapshot],
) -> Result<serde_json::Value, AppError> {
    serde_json::to_value(&items[..items.len().min(FORWARDED_PREVIEW_LIMIT)])
        .map_err(|_| AppError::Internal("Failed to serialize forwarded message preview"))
}

fn load_forwarded_bundle_previews(
    conn: &mut PgConnection,
    bundle_ids: &[i64],
) -> Result<std::collections::HashMap<i64, ForwardedMessagesPreviewSnapshot>, AppError> {
    if bundle_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    let bundles: Vec<(i64, i32, Vec<i64>, serde_json::Value)> = forwarded_bundles::table
        .filter(forwarded_bundles::id.eq_any(bundle_ids))
        .select((
            forwarded_bundles::id,
            forwarded_bundles::item_count,
            forwarded_bundles::child_bundle_ids,
            forwarded_bundles::preview,
        ))
        .load(conn)?;

    if bundles.len() != bundle_ids.len() {
        return Err(AppError::BadRequest("Forwarded source bundle not found"));
    }

    bundles
        .into_iter()
        .map(|(id, item_count, child_bundle_ids, preview)| {
            let messages: Vec<ForwardedMessagePreviewSnapshot> = serde_json::from_value(preview)
                .map_err(|_| {
                    AppError::Internal("Failed to deserialize forwarded message preview")
                })?;
            Ok((
                id,
                ForwardedMessagesPreviewSnapshot {
                    total: item_count as usize,
                    contains_forwarded_messages: !child_bundle_ids.is_empty(),
                    messages,
                },
            ))
        })
        .collect()
}

pub fn load_forwarded_bundle(
    conn: &mut PgConnection,
    bundle_id: i64,
) -> Result<ForwardedBundle, AppError> {
    forwarded_bundles::table
        .filter(forwarded_bundles::id.eq(bundle_id))
        .select(ForwardedBundle::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Forwarded messages not found"))
}

pub fn deserialize_forwarded_bundle_payload(
    bundle: ForwardedBundle,
) -> Result<(usize, Vec<ForwardedBundlePayloadItem>), AppError> {
    let total = bundle.item_count as usize;
    let items: Vec<ForwardedBundlePayloadItem> = serde_json::from_value(bundle.payload)
        .map_err(|_| AppError::Internal("Failed to deserialize forwarded messages"))?;
    Ok((total, items))
}

pub(crate) fn load_chat_forwarded_bundle_id(
    conn: &mut PgConnection,
    chat_id: i64,
    message_id: i64,
    uid: i32,
) -> Result<i64, AppError> {
    let is_member = diesel::select(diesel::dsl::exists(
        group_membership::table.filter(
            group_membership::chat_id
                .eq(chat_id)
                .and(group_membership::uid.eq(uid)),
        ),
    ))
    .get_result::<bool>(conn)?;
    if !is_member {
        return Err(AppError::Forbidden("Not a member of this chat"));
    }

    let (message_type, bundle_id) = messages_schema::table
        .filter(
            messages_schema::id
                .eq(message_id)
                .and(messages_schema::chat_id.eq(chat_id))
                .and(messages_schema::deleted_at.is_null())
                .and(messages_schema::is_published.eq(true)),
        )
        .select((
            messages_schema::message_type,
            messages_schema::forwarded_bundle_id,
        ))
        .first::<(MessageType, Option<i64>)>(conn)
        .optional()?
        .ok_or(AppError::NotFound("Message not found"))?;
    if message_type != MessageType::Forwarded {
        return Err(AppError::BadRequest("Message is not a forwarded message"));
    }
    bundle_id.ok_or(AppError::NotFound("Forwarded messages not found"))
}

pub fn load_target_forwarded_bundle_from_root(
    conn: &mut PgConnection,
    root_bundle_id: i64,
    target_bundle_id: i64,
) -> Result<ForwardedBundle, AppError> {
    if root_bundle_id != target_bundle_id {
        let child_bundle_ids = forwarded_bundles::table
            .filter(forwarded_bundles::id.eq(root_bundle_id))
            .select(forwarded_bundles::child_bundle_ids)
            .first::<Vec<i64>>(conn)
            .optional()?
            .ok_or(AppError::NotFound("Forwarded messages not found"))?;
        if !child_bundle_ids.contains(&target_bundle_id) {
            return Err(AppError::NotFound("Forwarded messages not found"));
        }
    }

    load_forwarded_bundle(conn, target_bundle_id)
}

pub fn forwarded_messages_response_from_items(
    conn: &mut PgConnection,
    media: &crate::services::media::MediaStore,
    avatars: &crate::services::avatars::AvatarService,
    current_user_uid: i32,
    total: usize,
    items: Vec<ForwardedBundlePayloadItem>,
) -> ForwardedMessagesResponse {
    let mut forwarded_uids = std::collections::HashSet::new();
    collect_forwarded_bundle_item_uids(&items, &mut forwarded_uids);
    let forwarded_uids: Vec<i32> = forwarded_uids.into_iter().collect();
    let user_avatars = avatars.lookup(&forwarded_uids);
    let user_profiles = lookup_user_profiles(conn, &forwarded_uids).unwrap_or_default();

    let mut sticker_ids = std::collections::HashSet::new();
    collect_forwarded_bundle_item_sticker_ids(&items, &mut sticker_ids);
    let sticker_ids: Vec<i64> = sticker_ids.into_iter().collect();
    let favorited_sticker_ids =
        load_favorited_sticker_ids(conn, current_user_uid, &sticker_ids).unwrap_or_default();
    let items_by_original_message_id: std::collections::HashMap<i64, &ForwardedBundlePayloadItem> =
        items
            .iter()
            .map(|item| (forwarded_bundle_item_original_message_id(item), item))
            .collect();
    let messages = items
        .iter()
        .map(|item| {
            forwarded_bundle_item_response(
                media,
                item,
                &items_by_original_message_id,
                &favorited_sticker_ids,
                &user_avatars,
                &user_profiles,
            )
        })
        .collect();

    ForwardedMessagesResponse { total, messages }
}

fn collect_forwarded_bundle_item_uids(
    items: &[ForwardedBundlePayloadItem],
    uids: &mut std::collections::HashSet<i32>,
) {
    for item in items {
        match item {
            ForwardedBundlePayloadItem::MessageSnapshot { snapshot } => {
                uids.insert(snapshot.sender_uid);
                uids.extend(snapshot.mention_uids.iter().copied());
            }
            ForwardedBundlePayloadItem::ForwardedBundleRef { bundle_ref } => {
                uids.insert(bundle_ref.sender_uid);
                collect_forwarded_preview_item_uids(&bundle_ref.preview.messages, uids);
            }
        }
    }
}

fn collect_forwarded_preview_item_uids(
    items: &[ForwardedMessagePreviewSnapshot],
    uids: &mut std::collections::HashSet<i32>,
) {
    for item in items {
        uids.insert(item.sender_uid);
        uids.extend(item.mention_uids.iter().copied());
    }
}

fn collect_forwarded_bundle_item_sticker_ids(
    items: &[ForwardedBundlePayloadItem],
    sticker_ids: &mut std::collections::HashSet<i64>,
) {
    for item in items {
        if let ForwardedBundlePayloadItem::MessageSnapshot { snapshot } = item {
            if let Some(sticker) = &snapshot.sticker {
                sticker_ids.insert(sticker.id);
            }
        }
    }
}

fn forwarded_preview_item_response(
    item: &ForwardedMessagePreviewSnapshot,
    user_avatars: &std::collections::HashMap<i32, Option<String>>,
    user_profiles: &std::collections::HashMap<i32, UserProfile>,
) -> ForwardedMessagePreviewResponse {
    ForwardedMessagePreviewResponse {
        metadata: item.metadata.clone(),
        original_message_id: item.original_message_id,
        original_chat_id: item.original_chat_id,
        message: item.message.clone(),
        message_type: item.message_type.clone(),
        sender: build_sender(item.sender_uid, user_avatars, user_profiles),
        original_created_at: item.original_created_at,
        attachments: item.attachments.clone(),
        sticker: item.sticker.clone(),
        mentions: item
            .mention_uids
            .iter()
            .copied()
            .map(|uid| build_mention_info(uid, user_avatars, user_profiles))
            .collect(),
    }
}

fn forwarded_reply_response(
    reply: Option<&ForwardedReplySnapshot>,
    items_by_original_message_id: &std::collections::HashMap<i64, &ForwardedBundlePayloadItem>,
    user_avatars: &std::collections::HashMap<i32, Option<String>>,
    user_profiles: &std::collections::HashMap<i32, UserProfile>,
) -> Option<ForwardedReplyResponse> {
    reply.map(|reply| match reply {
        ForwardedReplySnapshot::Redacted => ForwardedReplyResponse::Redacted,
        ForwardedReplySnapshot::Internal {
            original_message_id,
        } => items_by_original_message_id
            .get(original_message_id)
            .map(|target| ForwardedReplyResponse::Internal {
                original_message_id: *original_message_id,
                preview: Box::new(forwarded_preview_item_response(
                    &preview_snapshot_from_item(target),
                    user_avatars,
                    user_profiles,
                )),
            })
            .unwrap_or(ForwardedReplyResponse::Redacted),
    })
}

fn forwarded_sticker_response(
    media: &crate::services::media::MediaStore,
    sticker: &ForwardedStickerSnapshot,
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
            id: sticker.media_id,
            url: media.public_url(&sticker.media_storage_key),
            content_type: sticker.content_type.clone(),
            size: sticker.size,
            width: sticker.width,
            height: sticker.height,
        },
    }
}

fn forwarded_messages_preview_response(
    total: usize,
    contains_forwarded_messages: bool,
    items: &[ForwardedMessagePreviewSnapshot],
    user_avatars: &std::collections::HashMap<i32, Option<String>>,
    user_profiles: &std::collections::HashMap<i32, UserProfile>,
) -> ForwardedMessagesPreviewResponse {
    ForwardedMessagesPreviewResponse {
        total,
        contains_forwarded_messages,
        messages: items
            .iter()
            .map(|item| forwarded_preview_item_response(item, user_avatars, user_profiles))
            .collect(),
    }
}

fn forwarded_bundle_item_response(
    media: &crate::services::media::MediaStore,
    item: &ForwardedBundlePayloadItem,
    items_by_original_message_id: &std::collections::HashMap<i64, &ForwardedBundlePayloadItem>,
    favorited_sticker_ids: &std::collections::HashSet<i64>,
    user_avatars: &std::collections::HashMap<i32, Option<String>>,
    user_profiles: &std::collections::HashMap<i32, UserProfile>,
) -> ForwardedMessageResponse {
    match item {
        ForwardedBundlePayloadItem::MessageSnapshot { snapshot } => ForwardedMessageResponse {
            original_message_id: snapshot.original_message_id,
            original_chat_id: snapshot.original_chat_id,
            message: snapshot.message.clone(),
            message_type: snapshot.message_type.clone(),
            sender: build_sender(snapshot.sender_uid, user_avatars, user_profiles),
            original_created_at: snapshot.original_created_at,
            sticker: snapshot.sticker.as_ref().map(|sticker| {
                forwarded_sticker_response(
                    media,
                    sticker,
                    favorited_sticker_ids.contains(&sticker.id),
                )
            }),
            reply: forwarded_reply_response(
                snapshot.reply.as_ref(),
                items_by_original_message_id,
                user_avatars,
                user_profiles,
            ),
            attachments: snapshot
                .attachments
                .iter()
                .map(|attachment| AttachmentResponse {
                    id: attachment.id,
                    url: media.public_url(&attachment.external_reference),
                    kind: attachment.kind.clone(),
                    size: attachment.size,
                    file_name: attachment.file_name.clone(),
                    width: attachment.width,
                    height: attachment.height,
                })
                .collect(),
            metadata: snapshot.metadata.clone().map(|metadata| {
                crate::services::link_previews::project_stored_metadata(metadata, media, Utc::now())
            }),
            mentions: snapshot
                .mention_uids
                .iter()
                .copied()
                .map(|uid| build_mention_info(uid, user_avatars, user_profiles))
                .collect(),
            forwarded_bundle_id: None,
            forwarded_preview: None,
        },
        ForwardedBundlePayloadItem::ForwardedBundleRef { bundle_ref } => ForwardedMessageResponse {
            original_message_id: bundle_ref.original_message_id,
            original_chat_id: bundle_ref.original_chat_id,
            message: bundle_ref.message.clone(),
            message_type: bundle_ref.message_type.clone(),
            sender: build_sender(bundle_ref.sender_uid, user_avatars, user_profiles),
            original_created_at: bundle_ref.original_created_at,
            sticker: None,
            reply: forwarded_reply_response(
                bundle_ref.reply.as_ref(),
                items_by_original_message_id,
                user_avatars,
                user_profiles,
            ),
            attachments: Vec::new(),
            metadata: None,
            mentions: Vec::new(),
            forwarded_bundle_id: Some(bundle_ref.forwarded_bundle_id),
            forwarded_preview: Some(forwarded_messages_preview_response(
                bundle_ref.preview.total,
                bundle_ref.preview.contains_forwarded_messages,
                &bundle_ref.preview.messages,
                user_avatars,
                user_profiles,
            )),
        },
    }
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
        Some(_) | None => "[Attachment]",
    }
}

struct PushPreviewBundle {
    message_preview: PushMessagePreview,
    body_preview: Option<String>,
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
            MessageType::File => Some(
                attachment_preview_text(
                    response
                        .attachments
                        .first()
                        .map(|attachment| attachment.kind.as_str()),
                )
                .to_string(),
            ),
            MessageType::Forwarded => Some("forwarded messages".to_string()),
            MessageType::Placeholder => Some(
                response
                    .message
                    .as_deref()
                    .and_then(ForwardPlaceholder::from_code)
                    .map(ForwardPlaceholder::notification_text)
                    .unwrap_or("[Unavailable message]")
                    .to_owned(),
            ),
            _ => rendered_message.clone(),
        }
    };

    let preview_message = if is_deleted {
        None
    } else {
        match response.message_type {
            MessageType::Invite | MessageType::Forwarded => None,
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
    }
}

pub fn build_message_side_effects(
    conn: &mut PgConnection,
    response: &MessageResponse,
    sender_uid: i32,
    chat_id: i64,
    enqueue_push: bool,
    notify_mentions: bool,
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
    let member_set: std::collections::HashSet<i32> = member_uids.iter().copied().collect();
    // Persisted mention rows and the push job's mention list must agree: both are
    // member-filtered and exclude the sender. Derive the list once.
    let mentioned_member_uids: Vec<i32> = if is_system_message || !notify_mentions {
        Vec::new()
    } else {
        response
            .message
            .as_deref()
            .map(extract_mention_uids)
            .unwrap_or_default()
            .into_iter()
            .filter(|uid| *uid != sender_uid && member_set.contains(uid))
            .collect()
    };
    // A reply to someone's message rides the mention pipeline as a kind='reply'
    // row. Apply the same filters as mentions (member, not the sender); replying
    // to a system message notifies no one.
    let reply_target_uid: Option<i32> = if is_system_message {
        None
    } else {
        response
            .reply_to_message
            .as_ref()
            .filter(|target| !matches!(target.message_type, MessageType::System))
            .map(|target| target.sender.uid)
            .filter(|uid| *uid != sender_uid && member_set.contains(uid))
    };
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
            mentioned_uids: mentioned_member_uids.clone(),
            reply_target_uid,
        })
    } else {
        None
    };

    // Persist @mentions and direct a `Notification` realtime event to each
    // mentioned member. A reply to someone's message is persisted as a
    // kind='reply' row and notified the same way; when a message both mentions
    // and replies to the same person, only the mention row/event is produced.
    let reply_notification_uid =
        reply_target_uid.filter(|uid| !mentioned_member_uids.contains(uid));
    let mut mention_rows: Vec<MessageMention> = mentioned_member_uids
        .iter()
        .map(|uid| MessageMention {
            message_id: response.id,
            mentioned_uid: *uid,
            chat_id,
            thread_root_id: response.reply_root_id,
            created_at: response.created_at,
            kind: MentionKind::Mention,
        })
        .collect();
    if let Some(uid) = reply_notification_uid {
        mention_rows.push(MessageMention {
            message_id: response.id,
            mentioned_uid: uid,
            chat_id,
            thread_root_id: response.reply_root_id,
            created_at: response.created_at,
            kind: MentionKind::Reply,
        });
    }
    if !mention_rows.is_empty() {
        diesel::insert_into(message_mentions::table)
            .values(&mention_rows)
            .on_conflict_do_nothing()
            .execute(conn)?;
    }

    let mut notifications: Vec<(i32, std::sync::Arc<ServerWsMessage>)> = Vec::new();
    if !mentioned_member_uids.is_empty() || reply_notification_uid.is_some() {
        // Reuse the push job's username when available so the same send only
        // looks the sender's name up once.
        let actor_name = if let Some(job) = &push_job {
            job.sender_username.clone()
        } else {
            load_username_by_uid(conn, sender_uid)?.unwrap_or_else(|| "Someone".to_string())
        };
        if !mentioned_member_uids.is_empty() {
            let payload = NotificationPayload {
                notification_type: NotificationType::Mention,
                chat_id,
                message_id: response.id,
                thread_root_id: response.reply_root_id,
                actor_uid: sender_uid,
                actor_name: Some(actor_name.clone()),
            };
            let notification = std::sync::Arc::new(ServerWsMessage::Notification(payload));
            for uid in &mentioned_member_uids {
                notifications.push((*uid, notification.clone()));
            }
        }
        if let Some(uid) = reply_notification_uid {
            let payload = NotificationPayload {
                notification_type: NotificationType::Reply,
                chat_id,
                message_id: response.id,
                thread_root_id: response.reply_root_id,
                actor_uid: sender_uid,
                actor_name: Some(actor_name),
            };
            notifications.push((
                uid,
                std::sync::Arc::new(ServerWsMessage::Notification(payload)),
            ));
        }
    }

    Ok(PendingSideEffects {
        ws_msg,
        broadcast_uids: if response
            .system_kind
            .is_some_and(|kind| kind.is_membership())
        {
            group_membership::table
                .inner_join(groups::table)
                .filter(groups::id.eq(chat_id))
                .filter(super::system_messages::membership_allowed())
                .select(group_membership::uid)
                .load(conn)?
        } else {
            member_uids
        },
        push_job,
        notifications,
    })
}

/// Sync `message_mentions` rows with an edited message body.
///
/// Removes rows for mention targets dropped by the edit and inserts rows for
/// newly mentioned members (member-filtered, excluding the editor), mirroring
/// `build_message_side_effects`. Newly mentioned members of a thread reply are
/// auto-subscribed. Returns the uids of newly mentioned members so the caller
/// can notify them post-commit. `message` must be the pre-edit row (the old
/// body is diffed against `new_text`).
///
/// Reply rows (kind='reply') are never deleted by this diff: dropping an
/// @mention on the message's reply target downgrades their row back to
/// 'reply', and adding an @mention over an existing reply row upgrades it to
/// 'mention'.
pub fn sync_edited_message_mentions(
    conn: &mut PgConnection,
    message: &Message,
    new_text: &str,
    editor_uid: i32,
    edited_at: DateTime<Utc>,
) -> Result<Vec<i32>, AppError> {
    let old_uids: std::collections::HashSet<i32> = message
        .message
        .as_deref()
        .map(extract_mention_uids)
        .unwrap_or_default()
        .into_iter()
        .collect();
    let new_uids: std::collections::HashSet<i32> =
        extract_mention_uids(new_text).into_iter().collect();

    let removed: Vec<i32> = old_uids.difference(&new_uids).copied().collect();
    if !removed.is_empty() {
        use crate::schema::message_mentions::dsl as mm_dsl;
        let reply_target_uid: Option<i32> = match message.reply_to_id {
            Some(reply_to_id) => messages_schema::table
                .filter(messages_schema::id.eq(reply_to_id))
                .select(messages_schema::sender_uid)
                .first::<i32>(conn)
                .optional()?,
            None => None,
        };
        let (keep_reply, drop_mentions): (Vec<i32>, Vec<i32>) = removed
            .into_iter()
            .partition(|uid| Some(*uid) == reply_target_uid);
        if !keep_reply.is_empty() {
            diesel::update(
                mm_dsl::message_mentions
                    .filter(mm_dsl::message_id.eq(message.id))
                    .filter(mm_dsl::mentioned_uid.eq_any(&keep_reply)),
            )
            .set(mm_dsl::kind.eq(MentionKind::Reply))
            .execute(conn)?;
        }
        if !drop_mentions.is_empty() {
            diesel::delete(
                mm_dsl::message_mentions
                    .filter(mm_dsl::message_id.eq(message.id))
                    .filter(mm_dsl::mentioned_uid.eq_any(&drop_mentions)),
            )
            .execute(conn)?;
        }
    }

    let added: Vec<i32> = new_uids.difference(&old_uids).copied().collect();
    if added.is_empty() {
        return Ok(Vec::new());
    }

    let member_uids: Vec<i32> = group_membership::table
        .filter(group_membership::chat_id.eq(message.chat_id))
        .select(group_membership::uid)
        .load(conn)?;
    let member_set: std::collections::HashSet<i32> = member_uids.into_iter().collect();
    let added_members: Vec<i32> = added
        .into_iter()
        .filter(|uid| *uid != editor_uid && member_set.contains(uid))
        .collect();
    if added_members.is_empty() {
        return Ok(Vec::new());
    }

    let mention_rows: Vec<MessageMention> = added_members
        .iter()
        .map(|uid| MessageMention {
            message_id: message.id,
            mentioned_uid: *uid,
            chat_id: message.chat_id,
            thread_root_id: message.reply_root_id,
            created_at: edited_at,
            kind: MentionKind::Mention,
        })
        .collect();
    diesel::insert_into(message_mentions::table)
        .values(&mention_rows)
        // A row can already exist when the message replies to the newly
        // mentioned member (kind='reply'); the explicit @mention wins.
        .on_conflict((
            message_mentions::message_id,
            message_mentions::mentioned_uid,
        ))
        .do_update()
        .set(message_mentions::kind.eq(MentionKind::Mention))
        .execute(conn)?;

    if let Some(thread_root_id) = message.reply_root_id {
        for uid in &added_members {
            crate::services::threads::ensure_thread_subscription(
                conn,
                message.chat_id,
                thread_root_id,
                *uid,
            )?;
        }
    }

    Ok(added_members)
}

/// Maximum attachments a single message may carry.
pub const MAX_ATTACHMENTS_PER_MESSAGE: usize = 20;

diesel::define_sql_function! {
    /// Assign request ordinals in the association UPDATE, without per-attachment queries.
    #[sql_name = "array_position"]
    fn attachment_position(
        ids: diesel::sql_types::Array<diesel::sql_types::BigInt>,
        id: diesel::sql_types::BigInt,
    ) -> diesel::sql_types::SmallInt;
}

/// Parses attachment IDs while preserving the request order.
///
/// The sequence is part of the message-composition contract. Callers that
/// need a deterministic database lock order must order their query separately.
pub fn parse_attachment_ids(raw_ids: &[String]) -> Result<Vec<i64>, AppError> {
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
    if matches!(message_type, MessageType::Placeholder)
        && message.and_then(ForwardPlaceholder::from_code).is_none()
    {
        return Err(AppError::BadRequest("Invalid placeholder reason"));
    }
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
pub fn validate_message(
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
        MessageType::Placeholder => {
            if attachments.is_empty() {
                Ok(())
            } else {
                Err(AppError::BadRequest(
                    "Placeholder messages cannot include attachments",
                ))
            }
        }
        _ => Ok(()),
    }
}

/// Authorize a user-originated message send and return its validated target
/// context. Call inside the write transaction, before any other write locks.
/// System messages intentionally bypass this boundary because some
/// lifecycle events are recorded after the actor's membership is removed.
pub fn authorize_message_send(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_id: Option<i64>,
    uid: i32,
    restricted_user_group_ids: &[i32],
) -> Result<AuthorizedMessageTarget, MessageSendAuthorizationError> {
    speaking::lock_chat(conn, chat_id, false)?;
    let (kind, dm_uid1, dm_uid2, group_mode, role, member_mode) = groups::table
        .inner_join(group_membership::table)
        .filter(groups::id.eq(chat_id).and(group_membership::uid.eq(uid)))
        .select((
            groups::kind,
            groups::dm_uid1,
            groups::dm_uid2,
            groups::speaking_mode,
            group_membership::role,
            group_membership::speaking_mode,
        ))
        .first::<(
            GroupKind,
            Option<i32>,
            Option<i32>,
            SpeakingMode,
            GroupRole,
            SpeakingMode,
        )>(conn)
        .optional()?
        .ok_or(MessageSendAuthorizationError::NotChatMember)?;

    if kind == GroupKind::Dm {
        let peer = match (dm_uid1, dm_uid2) {
            (Some(uid1), Some(uid2)) if uid1 == uid => uid2,
            (Some(uid1), Some(uid2)) if uid2 == uid => uid1,
            _ => return Err(MessageSendAuthorizationError::InvalidDmParticipants),
        };
        social::check_can_dm(conn, uid, peer)?;
    } else if social::group_chat_write_is_restricted(conn, uid, restricted_user_group_ids)? {
        return Err(MessageSendAuthorizationError::GroupChatWriteRestricted);
    }

    let thread_root = thread_id
        .map(|thread_id| {
            let root = messages_schema::table
                .filter(
                    messages_schema::id
                        .eq(thread_id)
                        .and(messages_schema::chat_id.eq(chat_id))
                        .and(messages_schema::reply_root_id.is_null())
                        .and(messages_schema::is_published.eq(true))
                        .and(
                            messages_schema::deleted_at
                                .is_null()
                                .or(messages_schema::has_thread.eq(true)),
                        ),
                )
                .select(Message::as_select())
                .first::<Message>(conn)
                .optional()?
                .ok_or(MessageSendAuthorizationError::ThreadRootNotFound)?;

            if root.message_type != MessageType::Text {
                return Err(MessageSendAuthorizationError::ThreadRootNotText);
            }
            Ok(root)
        })
        .transpose()?;

    let action = match &thread_root {
        None => SpeakingAction::ChatMessage,
        Some(root) if root.has_thread => SpeakingAction::ThreadReply,
        Some(_) => SpeakingAction::CreateThread,
    };
    let mode = speaking::effective_mode(&role, group_mode, member_mode);
    if kind == GroupKind::Group && !speaking::allows(mode, action) {
        return Err(MessageSendAuthorizationError::SpeakingRestricted(mode));
    }
    Ok(AuthorizedMessageTarget { kind, thread_root })
}

// ---------------------------------------------------------------------------
// send_prepared_message (shared by messages, invites, pins)
// ---------------------------------------------------------------------------

impl MessageWriter {
    pub async fn send_prepared_message(
        &self,
        conn: &mut PgConnection,
        prepared: PreparedMessageSend,
    ) -> Result<SendMessageOutcome, AppError> {
        self.send_prepared_message_inner(conn, prepared, false)
            .await
    }

    /// Only call after the user has been authorized to send to this destination.
    pub async fn send_client_message(
        &self,
        conn: &mut PgConnection,
        prepared: PreparedMessageSend,
    ) -> Result<SendMessageOutcome, AppError> {
        self.send_prepared_message_inner(conn, prepared, true).await
    }

    async fn send_prepared_message_inner(
        &self,
        conn: &mut PgConnection,
        prepared: PreparedMessageSend,
        return_conflict_copy: bool,
    ) -> Result<SendMessageOutcome, AppError> {
        if prepared.message_type == MessageType::Placeholder
            && (!prepared.attachment_ids.is_empty() || prepared.forwarded_bundle_id.is_some())
        {
            return Err(AppError::BadRequest(
                "Placeholder messages cannot reference media or bundles",
            ));
        }
        if let Some(reply_to_id) = prepared.reply_to_id {
            validate_reply_target(conn, prepared.chat_id, prepared.reply_root_id, reply_to_id)?;
        }
        validate_message_shape(
            &prepared.message_type,
            prepared.message.as_deref(),
            prepared.sticker_id,
        )?;

        let id = ids::next_message_id(self.id_gen.as_ref())
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
            system_kind: prepared.system_kind,
            forwarded_from_message_id: prepared.forwarded_from_message_id,
            id,
            message: stored_message.clone(),
            metadata: prepared.metadata.clone(),
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
            forwarded_bundle_id: prepared.forwarded_bundle_id,
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
            if let Err(conflict) = validate_idempotent_message_payload(
                &existing,
                &prepared,
                stored_message.as_deref(),
                &existing_attachment_ids,
            ) {
                return Err(if return_conflict_copy {
                    project_message_id_conflict(
                        conn,
                        (&self.media, &self.avatars),
                        existing,
                        prepared.sender_uid,
                        prepared.chat_id,
                        prepared.reply_root_id,
                    )
                    .await
                } else {
                    conflict
                });
            }
            let mut response = attach_metadata(
                conn,
                vec![existing],
                &self.media,
                &self.avatars,
                prepared.sender_uid,
            )
            .await
            .into_iter()
            .next()
            .ok_or(AppError::Internal("Failed to build message response"))?;
            apply_forwarded_preview_override(
                conn,
                &self.avatars,
                &mut response,
                prepared.forwarded_preview_total,
                prepared.forwarded_preview_contains_forwarded_messages,
                prepared.forwarded_preview_items.as_deref(),
            );
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
            .set((
                a_dsl::message_id.eq(id),
                a_dsl::order.eq(attachment_position(&prepared.attachment_ids, a_dsl::id) - 1i16),
            ))
            .execute(conn)?;
            if associated != prepared.attachment_ids.len() {
                return Err(AppError::BadRequest("Invalid attachment selection"));
            }
        }

        let mut response = attach_metadata(
            conn,
            vec![inserted_msg.clone()],
            &self.media,
            &self.avatars,
            prepared.sender_uid,
        )
        .await
        .into_iter()
        .next()
        .ok_or(AppError::Internal("Failed to build message response"))?;
        apply_forwarded_preview_override(
            conn,
            &self.avatars,
            &mut response,
            prepared.forwarded_preview_total,
            prepared.forwarded_preview_contains_forwarded_messages,
            prepared.forwarded_preview_items.as_deref(),
        );

        let (member_uids, side_effects) = if prepared.publish_immediately {
            let side_effects = build_message_side_effects(
                conn,
                &response,
                prepared.sender_uid,
                prepared.chat_id,
                !is_system_message,
                prepared.forwarded_from_message_id.is_none(),
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
                    notifications: Vec::new(),
                },
            )
        };

        // Counted once here so every sender - chat messages, invites, pins, member
        // system messages - increments the same counter. Duplicate retries return
        // early above and are not counted.
        self.metrics
            .chat
            .record_message(prepared.chat_id, prepared.chat_kind);

        Ok(SendMessageOutcome::Created(Box::new(SendMessageResult {
            inserted_message: inserted_msg,
            response,
            member_uids,
            side_effects,
        })))
    }
}

fn apply_forwarded_preview_override(
    conn: &mut PgConnection,
    avatars: &crate::services::avatars::AvatarService,
    response: &mut MessageResponse,
    total: Option<usize>,
    contains_forwarded_messages: Option<bool>,
    items: Option<&[ForwardedMessagePreviewSnapshot]>,
) {
    let (Some(total), Some(contains_forwarded_messages), Some(items)) = (
        total,
        contains_forwarded_messages,
        items.filter(|_| !response.is_deleted),
    ) else {
        return;
    };
    let mut forwarded_uids = std::collections::HashSet::new();
    collect_forwarded_preview_item_uids(items, &mut forwarded_uids);
    let forwarded_uids: Vec<i32> = forwarded_uids.into_iter().collect();
    let user_avatars = avatars.lookup(&forwarded_uids);
    let user_profiles = lookup_user_profiles(conn, &forwarded_uids).unwrap_or_default();
    response.forwarded_preview = Some(forwarded_messages_preview_response(
        total,
        contains_forwarded_messages,
        items,
        &user_avatars,
        &user_profiles,
    ));
}

pub(crate) const MESSAGE_ID_CONFLICT: &str =
    "clientGeneratedId already exists with different payload";

/// The caller selected `existing` by the requested client ID and authorized
/// the destination. Never extend that authorization to another conversation
/// or to an unpublished message. Forwarded bundles are immutable destination
/// snapshots; single-forward attribution also hydrates a live source reply.
pub(crate) async fn project_message_id_conflict(
    conn: &mut PgConnection,
    (media, avatars): (&MediaStore, &AvatarService),
    existing: Message,
    uid: i32,
    chat_id: i64,
    thread_id: Option<i64>,
) -> AppError {
    let conflict = AppError::Conflict(MESSAGE_ID_CONFLICT);
    if !has_conflict_scope(&existing, uid, chat_id, thread_id) {
        return conflict;
    }
    if let Some(origin_id) = existing
        .forwarded_from_message_id
        .filter(|_| existing.deleted_at.is_none())
    {
        let origin_chat = messages_schema::table
            .find(origin_id)
            .filter(messages_schema::is_published.eq(true))
            .select(messages_schema::chat_id)
            .first::<i64>(conn);
        if !origin_chat.is_ok_and(|origin_chat| {
            crate::services::forwarding::check_source_membership(conn, origin_chat, uid).is_ok()
        }) {
            return conflict;
        }
    }
    attach_metadata(conn, vec![existing], media, avatars, uid)
        .await
        .pop()
        .filter(|response| {
            response.is_deleted
                || response.message_type != MessageType::Forwarded
                || response.forwarded_preview.is_some()
        })
        .map_or(conflict, |response| {
            AppError::MessageIdConflict(Box::new(response))
        })
}

fn has_conflict_scope(existing: &Message, uid: i32, chat_id: i64, thread_id: Option<i64>) -> bool {
    existing.is_published
        && existing.system_kind.is_none()
        && !matches!(existing.message_type, MessageType::System)
        && existing.sender_uid == uid
        && existing.chat_id == chat_id
        && existing.reply_root_id == thread_id
}

fn load_message_attachment_ids(conn: &mut PgConnection, message_id: i64) -> QueryResult<Vec<i64>> {
    use crate::schema::attachments::dsl as a_dsl;
    attachments::table
        .filter(a_dsl::message_id.eq(message_id))
        .filter(a_dsl::deleted_at.is_null())
        .select(a_dsl::id)
        .order((a_dsl::order.asc(), a_dsl::id.asc()))
        .load::<i64>(conn)
}

fn validate_idempotent_message_payload(
    existing: &Message,
    prepared: &PreparedMessageSend,
    stored_message: Option<&str>,
    existing_attachment_ids: &[i64],
) -> Result<(), AppError> {
    // Enrichment is mutable; the first accepted metadata wins and is not compared on replay.
    let attachment_ids_match = existing_attachment_ids == prepared.attachment_ids;

    if existing.chat_id == prepared.chat_id
        && existing.sender_uid == prepared.sender_uid
        && existing.message.as_deref() == stored_message
        && existing.message_type == prepared.message_type
        && existing.system_kind == prepared.system_kind
        && existing.sticker_id == prepared.sticker_id
        && existing.reply_to_id == prepared.reply_to_id
        && existing.reply_root_id == prepared.reply_root_id
        && existing.forwarded_from_message_id == prepared.forwarded_from_message_id
        && existing.forwarded_bundle_id == prepared.forwarded_bundle_id
        && attachment_ids_match
    {
        return Ok(());
    }

    Err(AppError::Conflict(MESSAGE_ID_CONFLICT))
}

struct ReactionDetails {
    message_id: i64,
    emoji: String,
    count: i64,
    reacted_by_me: bool,
    reactor_uids: Vec<i32>,
}

#[derive(diesel::QueryableByName)]
struct SampledReactor {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    pair_ordinal: i64,
    #[diesel(sql_type = diesel::sql_types::Integer)]
    user_uid: i32,
}

fn load_reaction_details(
    conn: &mut PgConnection,
    message_ids: &[i64],
    current_user_uid: i32,
) -> Vec<ReactionDetails> {
    if message_ids.is_empty() {
        return Vec::new();
    }

    let counts: Vec<(i64, String, i64)> = message_reactions::table
        .filter(message_reactions::message_id.eq_any(message_ids))
        .group_by((message_reactions::message_id, message_reactions::emoji))
        .select((
            message_reactions::message_id,
            message_reactions::emoji,
            diesel::dsl::count_star(),
        ))
        .order((
            message_reactions::message_id.asc(),
            diesel::dsl::count_star().desc(),
            diesel::dsl::min(message_reactions::created_at).asc(),
            message_reactions::emoji.asc(),
        ))
        .load(conn)
        .unwrap_or_default();

    if counts.is_empty() {
        return Vec::new();
    }

    let mut my_reactions: std::collections::HashSet<(i64, String)> = message_reactions::table
        .filter(message_reactions::message_id.eq_any(message_ids))
        .filter(message_reactions::user_uid.eq(current_user_uid))
        .select((message_reactions::message_id, message_reactions::emoji))
        .load::<(i64, String)>(conn)
        .unwrap_or_default()
        .into_iter()
        .collect();

    // LATERAL lets each pair use the ordered (message_id, emoji, created_at,
    // user_uid) index and stop after five rows rather than ranking all reactors.
    let pair_message_ids: Vec<i64> = counts.iter().map(|(id, _, _)| *id).collect();
    let pair_emojis: Vec<&str> = counts.iter().map(|(_, emoji, _)| emoji.as_str()).collect();
    let samples: Vec<SampledReactor> = diesel::sql_query(
        "SELECT pairs.ordinality AS pair_ordinal, sample.user_uid
         FROM unnest($1::bigint[], $2::text[]) WITH ORDINALITY AS pairs(message_id, emoji, ordinality)
         CROSS JOIN LATERAL (
             SELECT r.user_uid, r.created_at
             FROM message_reactions r
             WHERE r.message_id = pairs.message_id AND r.emoji = pairs.emoji
             ORDER BY r.created_at ASC, r.user_uid ASC
             LIMIT 5
         ) sample
         ORDER BY pairs.ordinality, sample.created_at ASC, sample.user_uid ASC",
    )
    .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(&pair_message_ids)
    .bind::<diesel::sql_types::Array<diesel::sql_types::Text>, _>(&pair_emojis)
    .load(conn)
    .unwrap_or_default();

    let mut details: Vec<ReactionDetails> = counts
        .into_iter()
        .map(|(message_id, emoji, count)| {
            let reacted_by_me = my_reactions.remove(&(message_id, emoji.clone()));
            ReactionDetails {
                message_id,
                emoji,
                count,
                reacted_by_me,
                reactor_uids: Vec::new(),
            }
        })
        .collect();
    for sample in samples {
        details[(sample.pair_ordinal - 1) as usize]
            .reactor_uids
            .push(sample.user_uid);
    }
    details
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
        if reply_msg
            .system_kind
            .is_some_and(|kind| kind.is_membership())
        {
            return false;
        }
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
    let forward_origins = crate::services::single_forwarding::ForwardOrigins::load(
        conn,
        messages_to_process
            .iter()
            .chain(reply_messages_map.values()),
    )
    .unwrap_or_else(|error| {
        tracing::error!(?error, "failed to load single-forward origins");
        Default::default()
    });
    let forwarded_bundle_ids: Vec<i64> = messages_to_process
        .iter()
        .filter(|message| {
            message.deleted_at.is_none() && matches!(&message.message_type, MessageType::Forwarded)
        })
        .filter_map(|message| message.forwarded_bundle_id)
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    // Forwarded-list metadata needs only immutable preview JSON, not bundle payloads.
    let forwarded_bundle_previews =
        match load_forwarded_bundle_previews(conn, &forwarded_bundle_ids) {
            Ok(previews) => previews,
            Err(error) => {
                tracing::error!(
                    error = ?error,
                    bundle_ids = ?forwarded_bundle_ids,
                    "attach_metadata: failed to load forwarded bundle previews"
                );
                std::collections::HashMap::new()
            }
        };

    // Collect reaction details and mentions before resolving profiles/avatars so
    // all referenced UIDs (senders, replies, forwards, reactors, mentions) are
    // fetched in a single batch.
    let reacted_message_ids: Vec<i64> = messages_to_process
        .iter()
        .filter(|m| m.has_reactions)
        .map(|m| m.id)
        .collect();
    let reaction_details = load_reaction_details(conn, &reacted_message_ids, current_user_uid);

    let mut per_message_mentions: Vec<Vec<i32>> = Vec::with_capacity(messages_to_process.len());
    let mut all_uids = std::collections::HashSet::new();
    for m in &messages_to_process {
        all_uids.insert(m.sender_uid);
        if m.deleted_at.is_none() {
            if let Some(ref text) = m.message {
                let uids = extract_mention_uids(text);
                all_uids.extend(uids.iter().copied());
                per_message_mentions.push(uids);
                continue;
            }
        }
        per_message_mentions.push(Vec::new());
    }
    for reply_msg in reply_messages_map.values() {
        all_uids.insert(reply_msg.sender_uid);
        if reply_msg.deleted_at.is_none() {
            if let Some(ref text) = reply_msg.message {
                all_uids.extend(extract_mention_uids(text));
            }
        }
    }
    for preview in forwarded_bundle_previews.values() {
        collect_forwarded_preview_item_uids(&preview.messages, &mut all_uids);
    }
    forward_origins.collect_uids(&mut all_uids);
    for detail in &reaction_details {
        all_uids.extend(detail.reactor_uids.iter().copied());
    }
    let target_uids: Vec<i32> = all_uids.into_iter().collect();
    let user_avatars = avatars.lookup(&target_uids);
    let user_profiles = lookup_user_profiles(conn, &target_uids).unwrap_or_default();

    let mut message_attachments_map: std::collections::HashMap<i64, Vec<Attachment>> =
        std::collections::HashMap::new();
    let attachment_message_ids: Vec<i64> = messages_to_process
        .iter()
        .filter(|message| message.deleted_at.is_none())
        .map(|message| message.id)
        .chain(reply_messages_map.keys().copied())
        .chain(
            forward_origins
                .replies()
                .filter(|reply| reply.deleted_at.is_none())
                .map(|reply| reply.id),
        )
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
        .chain(
            forward_origins
                .replies()
                .filter(|reply| reply.deleted_at.is_none())
                .filter_map(|reply| reply.sticker_id),
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
            .filter(m_dsl::message_type.ne(MessageType::System))
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
    for detail in reaction_details {
        let reactors = if detail.reactor_uids.is_empty() {
            None
        } else {
            Some(
                detail
                    .reactor_uids
                    .into_iter()
                    .map(|uid| ReactionReactor {
                        uid,
                        name: user_profiles
                            .get(&uid)
                            .and_then(|profile| profile.username.clone()),
                        avatar_url: user_avatars.get(&uid).cloned().flatten(),
                        sort_index: None,
                    })
                    .collect(),
            )
        };
        reaction_summaries_map
            .entry(detail.message_id)
            .or_default()
            .push(ReactionSummary {
                emoji: detail.emoji,
                count: detail.count,
                reacted_by_me: Some(detail.reacted_by_me),
                reactors,
            });
    }

    let sticker_emojis = sticker_rows
        .iter()
        .map(|(&id, (sticker, _))| (id, sticker.emoji.clone()))
        .collect();
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

                let preview = build_message_preview(
                    MessagePreviewInput {
                        metadata: reply_msg.metadata.as_ref().and_then(super::link_previews::preview_metadata),
                        system_kind: reply_msg.system_kind,
                        forwarded_from_name: forward_origins.name_for(reply_msg, &user_profiles),
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
                    &sticker_emojis,
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
        let forwarded_bundle_id =
            if !is_deleted && matches!(&m.message_type, MessageType::Forwarded) {
                m.forwarded_bundle_id
            } else {
                None
            };
        let forwarded_preview = forwarded_bundle_id
            .and_then(|bundle_id| forwarded_bundle_previews.get(&bundle_id))
            .map(|preview| {
                forwarded_messages_preview_response(
                    preview.total,
                    preview.contains_forwarded_messages,
                    &preview.messages,
                    &user_avatars,
                    &user_profiles,
                )
            });
        let forwarded_from = forward_origins.info_for(
            &m,
            &user_avatars,
            &user_profiles,
            &sticker_emojis,
            &message_attachments_map,
        );
        let metadata = m.metadata.as_ref().and_then(|value| {
            match super::link_previews::project_metadata(value, media, Utc::now()) {
                Ok(metadata) => Some(metadata),
                Err(_) => {
                    tracing::warn!(message_id = m.id, "Invalid stored message metadata");
                    None
                }
            }
        });
        let (message, system_links) = super::system_messages::decode(&m.message_type, m.message);
        let mut response = MessageResponse {
            system_kind: m.system_kind,
            system_links,
            forwarded_from,
            id: m.id,
            message: if is_deleted { None } else { message },
            metadata,
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
            thread_info: thread_counts_map
                .get(&m.id)
                .filter(|&&count| count > 0)
                .map(|&reply_count| ThreadInfo { reply_count }),
            reply_to_message,
            attachments,
            reactions: reaction_summaries_map.remove(&m.id).unwrap_or_default(),
            mentions: {
                per_message_mentions[idx]
                    .iter()
                    .map(|&uid| build_mention_info(uid, &user_avatars, &user_profiles))
                    .collect()
            },
            forwarded_bundle_id,
            forwarded_preview,
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
mod tests;
