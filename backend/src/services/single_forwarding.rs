//! Single-message forwarding keeps message content, shared bundles and a flattened origin.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};

use crate::{
    dto::{
        messages::{ForwardMessageBody, ForwardedFromInfo},
        rpc::messages::ForwardTarget,
    },
    errors::AppError,
    models::{Attachment, GroupKind, Message, MessageType},
    schema::{attachments, messages},
    services::{
        avatars::AvatarService,
        forwarding::{acquire_forward_retry_lock, load_forward_sources, source_placeholder},
        media::MediaStore,
        messages::{
            attachment_previews, build_message_preview, build_sender,
            capture_forwarded_thread_reply_counts, extract_mention_uids,
            redact_forwarded_invite_preview, MessagePreviewInput, PreparedForwardOrigin,
            PreparedMessageSend, MESSAGE_ID_CONFLICT,
        },
        user::UserProfile,
    },
    utils::ids::{self, IdGen},
};

#[derive(Clone, Copy)]
pub(crate) struct SingleForwardDeps<'a> {
    pub id_gen: &'a IdGen,
    pub media: &'a MediaStore,
    pub avatars: &'a AvatarService,
}

pub(crate) enum PreparedSingleForward {
    Existing(Box<Message>),
    New(Box<PreparedMessageSend>),
}

fn validate_retry(
    existing: &Message,
    uid: i32,
    destination_chat_id: i64,
    thread_id: Option<i64>,
    origin_id: i64,
    bundle_id: Option<i64>,
) -> Result<(), AppError> {
    if existing.sender_uid == uid
        && existing.chat_id == destination_chat_id
        && existing.reply_root_id == thread_id
        && existing.forwarded_from_message_id == Some(origin_id)
        && existing.forwarded_bundle_id == bundle_id
    {
        return Ok(());
    }
    Err(AppError::Conflict(MESSAGE_ID_CONFLICT))
}

/// Must run inside the caller's send transaction, after destination authorization.
/// Retries intentionally still require access to the selected source. Different
/// copies of the same flattened origin are equivalent for this API.
pub(crate) async fn prepare_single_forward(
    conn: &mut PgConnection,
    deps: SingleForwardDeps<'_>,
    uid: i32,
    destination_chat_id: i64,
    destination_kind: GroupKind,
    source_message_id: i64,
    body: &ForwardMessageBody,
) -> Result<PreparedSingleForward, AppError> {
    acquire_forward_retry_lock(conn, &body.client_generated_id)?;
    // The shared source lock prevents an edit from replacing attachments during the copy.
    let source = load_forward_sources(conn, uid, body.source_chat_id, &[source_message_id])?
        .selected
        .pop()
        .ok_or(AppError::NotFound("Message not found"))?;
    let origin_id = source.forwarded_from_message_id.unwrap_or(source.id);
    if let Some(existing) = messages::table
        .filter(messages::client_generated_id.eq(&body.client_generated_id))
        .for_update()
        .select(Message::as_select())
        .first::<Message>(conn)
        .optional()?
    {
        if source.message_type == MessageType::Sticker
            && existing.message_type == MessageType::Sticker
            && existing.forwarded_from_message_id.is_none()
            && existing.sticker_id == source.sticker_id
            && existing.sender_uid == uid
            && existing.chat_id == destination_chat_id
            && existing.reply_root_id == body.thread_id
        {
            return Ok(PreparedSingleForward::Existing(Box::new(existing)));
        }
        validate_retry(
            &existing,
            uid,
            destination_chat_id,
            body.thread_id,
            origin_id,
            source.forwarded_bundle_id,
        )?;
        return Ok(PreparedSingleForward::Existing(Box::new(existing)));
    }

    let prepared = capture_single_forward(
        conn,
        deps,
        uid,
        &ForwardTarget {
            chat_id: destination_chat_id,
            thread_id: body.thread_id,
            client_generated_id: body.client_generated_id.clone(),
        },
        destination_kind,
        &source,
        body.allow_placeholders,
    )
    .await?;
    Ok(PreparedSingleForward::New(Box::new(prepared)))
}

/// Capture content while the source row is locked against edits and recalls.
pub(super) async fn capture_single_forward(
    conn: &mut PgConnection,
    deps: SingleForwardDeps<'_>,
    uid: i32,
    target: &ForwardTarget,
    destination_kind: GroupKind,
    source: &Message,
    allow_pending_audio: bool,
) -> Result<PreparedMessageSend, AppError> {
    let origin_id = source.forwarded_from_message_id.unwrap_or(source.id);
    let placeholder = source_placeholder(source, allow_pending_audio)?;
    let thread_reply_counts =
        capture_forwarded_thread_reply_counts(conn, std::slice::from_ref(source))?;
    let mut metadata = placeholder
        .is_none()
        .then(|| super::messages::snapshot_link_metadata(source))
        .flatten()
        .map(|metadata| serde_json::to_value(metadata).expect("snapshot metadata is serializable"));
    let thread_reply_count = thread_reply_counts.get(&source.id).copied();
    let origin = capture_forward_origin(conn, deps, uid, source).await?;
    let (quoted_origin, forward_origin) = match origin {
        Some(PreparedForwardOrigin::Resolved(info)) if info.original_reply_to.is_some() => {
            (Some(info), None)
        }
        other => (None, other),
    };
    if quoted_origin.is_some() || thread_reply_count.is_some() {
        let forward = ForwardMetadata {
            origin: quoted_origin,
            thread_reply_count,
        };
        metadata.get_or_insert_with(|| serde_json::json!({}))["forward"] =
            serde_json::to_value(forward).expect("forward metadata is serializable");
    }
    if let Some(reason) = placeholder {
        let prepared = PreparedMessageSend {
            system_kind: None,
            chat_id: target.chat_id,
            chat_kind: destination_kind,
            sender_uid: uid,
            message: Some(reason.as_str().to_owned()),
            metadata,
            message_type: MessageType::Placeholder,
            sticker_id: None,
            reply_to_id: None,
            reply_root_id: target.thread_id,
            client_generated_id: target.client_generated_id.clone(),
            attachments: super::messages::PreparedAttachments::ForwardCopies(vec![]),
            publish_immediately: true,
            forwarded_from_message_id: Some(origin_id),
            forwarded_bundle_id: None,
            forwarded_preview: None,
            forward_origin,
        };
        return Ok(prepared);
    }

    let source_attachments = if source.has_attachments {
        attachments::table
            .filter(attachments::message_id.eq(source.id))
            .filter(attachments::deleted_at.is_null())
            .order((attachments::order.asc(), attachments::id.asc()))
            .select(Attachment::as_select())
            .load::<Attachment>(conn)?
    } else {
        Vec::new()
    };
    let mut copies = source_attachments;
    for row in &mut copies {
        row.id = ids::next_id(deps.id_gen).await.map_err(|error| {
            tracing::error!(?error, "failed to allocate forwarded attachment ID");
            AppError::Internal("ID generation failed")
        })?;
        row.message_id = None;
        row.uploader_uid = Some(uid);
        row.created_at = Utc::now();
    }
    let prepared = PreparedMessageSend {
        system_kind: None,
        chat_id: target.chat_id,
        chat_kind: destination_kind,
        sender_uid: uid,
        message: source.message.clone(),
        metadata,
        message_type: source.message_type.clone(),
        sticker_id: source.sticker_id,
        reply_to_id: None,
        reply_root_id: target.thread_id,
        client_generated_id: target.client_generated_id.clone(),
        attachments: super::messages::PreparedAttachments::ForwardCopies(copies),
        publish_immediately: true,
        forwarded_from_message_id: (source.message_type != MessageType::Sticker)
            .then_some(origin_id),
        // Bundles are immutable. Reuse the selected bundle without adding a nesting level;
        // the normal message hydrator loads its compact preview for the send response.
        forwarded_bundle_id: source.forwarded_bundle_id,
        forwarded_preview: None,
        forward_origin,
    };
    Ok(prepared)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ForwardMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<ForwardedFromInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_reply_count: Option<i64>,
}

async fn capture_forward_origin(
    conn: &mut PgConnection,
    deps: SingleForwardDeps<'_>,
    uid: i32,
    source: &Message,
) -> Result<Option<PreparedForwardOrigin>, AppError> {
    if source.message_type == MessageType::Sticker {
        return Ok(None);
    }
    if let Some(origin) = frozen_origin(source) {
        return Ok(Some(PreparedForwardOrigin::Resolved(origin)));
    }
    if source.reply_to_id.is_none() && source.forwarded_from_message_id.is_none() {
        return Ok(Some(PreparedForwardOrigin::Source {
            chat_id: source.chat_id,
            message_id: source.id,
            sender_uid: source.sender_uid,
        }));
    }
    if source.message_type == MessageType::Forwarded {
        // A reforwarded card points at the first card, not the selected copy.
        return Ok(None);
    }
    // A pre-snapshot forward may still refer to an original that quoted another message.
    let attribution = Message {
        has_thread: false,
        has_reactions: false,
        message: None,
        ..source.clone()
    };
    let original = super::messages::hydrate_messages(
        conn,
        vec![attribution],
        deps.media,
        deps.avatars,
        uid,
        None,
        super::messages::HydrationMode::ForwardOrigin,
    )
    .await
    .into_iter()
    .next()
    .ok_or(AppError::Internal("Failed to capture forward origin"))?;
    Ok(original
        .forwarded_from
        .or_else(|| {
            original.reply_to_message.map(|reply| ForwardedFromInfo {
                sender: original.sender,
                original_chat_id: original.chat_id,
                original_message_id: original.id,
                original_reply_to: Some(reply),
            })
        })
        .map(redact_invite_origin)
        .map(PreparedForwardOrigin::Resolved))
}

/// Loaded once for a page, including origins used by ordinary reply previews and
/// by the original reply context inside a forwarded message.
#[derive(Default)]
pub(crate) struct ForwardOrigins {
    frozen: HashMap<i64, ForwardedFromInfo>,
    originals: HashMap<i64, Message>,
    replies: HashMap<i64, Message>,
    reply_scopes: HashMap<i64, (i64, Option<i64>)>,
}

fn load_messages(
    conn: &mut PgConnection,
    ids: &HashSet<i64>,
) -> QueryResult<HashMap<i64, Message>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    messages::table
        .filter(messages::id.eq_any(ids))
        .select(Message::as_select())
        .load::<Message>(conn)
        .map(|rows| rows.into_iter().map(|row| (row.id, row)).collect())
}

impl ForwardOrigins {
    /// Lightweight previews only need attribution, without original replies.
    pub(crate) fn load_attribution<'a>(
        &mut self,
        conn: &mut PgConnection,
        sources: impl Iterator<Item = &'a Message>,
    ) -> QueryResult<()> {
        let mut ids = HashSet::new();
        for message in sources {
            if message.deleted_at.is_some()
                || message.message_type == MessageType::Sticker
                || self.frozen.contains_key(&message.id)
            {
                continue;
            }
            if let Some(origin) = frozen_origin(message) {
                self.frozen.insert(message.id, origin);
            } else if let Some(id) = message.forwarded_from_message_id {
                if !self.originals.contains_key(&id) {
                    ids.insert(id);
                }
            }
        }
        self.originals.extend(load_messages(conn, &ids)?);
        Ok(())
    }

    pub(crate) fn load<'a>(
        &mut self,
        conn: &mut PgConnection,
        displayed: &'a [Message],
        quoted: impl Iterator<Item = &'a Message>,
        include_reply_scopes: bool,
    ) -> QueryResult<()> {
        self.load_attribution(conn, displayed.iter().chain(quoted))?;
        let mut frozen_replies = HashSet::new();
        let mut reply_ids = HashSet::new();
        for message in displayed {
            if message.deleted_at.is_some() || message.message_type == MessageType::Sticker {
                continue;
            }
            if let Some(origin) = self.frozen.get(&message.id) {
                if include_reply_scopes && origin.original_chat_id == message.chat_id {
                    if let Some(reply) = origin
                        .original_reply_to
                        .as_deref()
                        .filter(|r| !r.is_deleted)
                    {
                        frozen_replies.insert(reply.id);
                    }
                }
            } else if let Some(reply_id) = message
                .forwarded_from_message_id
                .and_then(|id| self.originals.get(&id))
                .and_then(|original| original.reply_to_id)
            {
                reply_ids.insert(reply_id);
            }
        }
        let scope_ids: Vec<_> = frozen_replies.difference(&reply_ids).copied().collect();
        if !scope_ids.is_empty() {
            self.reply_scopes = messages::table
                .filter(messages::id.eq_any(scope_ids))
                .filter(messages::is_published.eq(true))
                .filter(messages::deleted_at.is_null())
                .select((messages::id, (messages::chat_id, messages::reply_root_id)))
                .load::<(i64, (i64, Option<i64>))>(conn)?
                .into_iter()
                .collect();
        }
        let mut replies = load_messages(conn, &reply_ids)?;
        replies.retain(|_, message| {
            message.is_published && !message.system_kind.is_some_and(|kind| kind.is_membership())
        });
        self.load_attribution(conn, replies.values())?;
        self.replies = replies;
        Ok(())
    }

    pub(crate) fn replies(&self) -> impl Iterator<Item = &Message> {
        self.replies.values()
    }

    pub(crate) fn can_jump_to_original_reply(
        &self,
        message: &Message,
        origin: &ForwardedFromInfo,
    ) -> bool {
        let Some(reply) = origin
            .original_reply_to
            .as_deref()
            .filter(|r| !r.is_deleted)
        else {
            return false;
        };
        let scope = self.reply_scopes.get(&reply.id).copied().or_else(|| {
            self.replies
                .get(&reply.id)
                .filter(|m| m.deleted_at.is_none())
                .map(|m| (m.chat_id, m.reply_root_id))
        });
        scope.is_some_and(|(chat_id, root)| {
            chat_id == message.chat_id
                && (root == message.reply_root_id || message.reply_root_id == Some(reply.id))
        })
    }

    pub(crate) fn collect_uids(&self, uids: &mut HashSet<i32>) {
        for message in self.originals.values().chain(self.replies.values()) {
            uids.insert(message.sender_uid);
        }
        for reply in self
            .replies
            .values()
            .filter(|reply| reply.deleted_at.is_none())
        {
            if let Some(text) = &reply.message {
                uids.extend(extract_mention_uids(text));
            }
        }
    }

    pub(crate) fn name_for(
        &self,
        message: &Message,
        profiles: &HashMap<i32, UserProfile>,
    ) -> Option<String> {
        if message.deleted_at.is_some() || message.message_type == MessageType::Sticker {
            return None;
        }
        if let Some(origin) = self.frozen.get(&message.id) {
            return origin.sender.name.clone();
        }
        let original = self.originals.get(&message.forwarded_from_message_id?)?;
        profiles.get(&original.sender_uid)?.username.clone()
    }

    pub(crate) fn info_for(
        &self,
        message: &Message,
        avatars: &HashMap<i32, Option<String>>,
        profiles: &HashMap<i32, UserProfile>,
        sticker_emojis: &HashMap<i64, String>,
        attachments: &HashMap<i64, Vec<Attachment>>,
    ) -> Option<ForwardedFromInfo> {
        if message.deleted_at.is_some() || message.message_type == MessageType::Sticker {
            return None;
        }
        if let Some(origin) = self.frozen.get(&message.id) {
            return Some(origin.clone());
        }
        let original = self.originals.get(&message.forwarded_from_message_id?)?;
        let original_reply_to = original
            .reply_to_id
            .and_then(|id| self.replies.get(&id))
            .filter(|reply| {
                reply.chat_id == original.chat_id
                    && super::messages::reply_in_scope(
                        reply.id,
                        reply.reply_root_id,
                        original.reply_root_id,
                    )
            })
            .map(|reply| {
                Box::new(build_message_preview(
                    MessagePreviewInput {
                        metadata: reply
                            .metadata
                            .as_ref()
                            .and_then(super::link_previews::preview_metadata),
                        system_kind: reply.system_kind,
                        forwarded_from_name: self.name_for(reply, profiles),
                        id: reply.id,
                        client_generated_id: reply.client_generated_id.clone(),
                        created_at: reply.created_at,
                        sender: build_sender(reply.sender_uid, avatars, profiles),
                        message: reply.message.clone(),
                        message_type: reply.message_type.clone(),
                        sticker_id: reply.sticker_id,
                        attachments: attachment_previews(attachments, reply.id),
                        deleted_at: reply.deleted_at,
                        mention_source: reply.message.clone(),
                        mention_uids: None,
                    },
                    sticker_emojis,
                    avatars,
                    profiles,
                ))
            });
        Some(redact_invite_origin(ForwardedFromInfo {
            sender: build_sender(original.sender_uid, avatars, profiles),
            original_chat_id: original.chat_id,
            original_message_id: original.id,
            original_reply_to,
        }))
    }
}

fn redact_invite_origin(mut origin: ForwardedFromInfo) -> ForwardedFromInfo {
    if let Some(reply) = origin.original_reply_to.as_deref_mut() {
        redact_forwarded_invite_preview(reply);
    }
    origin
}

fn frozen_origin(message: &Message) -> Option<ForwardedFromInfo> {
    let origin = message.metadata.as_ref()?.pointer("/forward/origin")?;
    ForwardedFromInfo::deserialize(origin)
        .ok()
        .map(redact_invite_origin)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ForwardPlaceholder, TranscodeStatus};

    fn test_id_gen() -> &'static IdGen {
        static GENERATOR: std::sync::OnceLock<IdGen> = std::sync::OnceLock::new();
        GENERATOR.get_or_init(|| ids::new_generator(0))
    }

    fn message(id: i64) -> Message {
        Message {
            system_kind: None,
            id,
            message: Some("hello @[uid:9]".into()),
            metadata: None,
            message_type: MessageType::Text,
            reply_to_id: None,
            reply_root_id: None,
            client_generated_id: format!("single-forward-{id}"),
            sender_uid: 7,
            chat_id: 42,
            created_at: Utc::now(),
            updated_at: None,
            deleted_at: None,
            has_attachments: false,
            has_thread: false,
            has_reactions: false,
            sticker_id: None,
            is_published: true,
            transcode_status: TranscodeStatus::None,
            forwarded_bundle_id: None,
            forwarded_from_message_id: None,
        }
    }

    #[test]
    fn only_unfinished_audio_requires_placeholder_consent() {
        let mut source = message(42);
        for (kind, status, pending) in [
            (MessageType::Text, TranscodeStatus::None, false),
            (MessageType::Audio, TranscodeStatus::None, true),
            (MessageType::Audio, TranscodeStatus::Pending, true),
            (MessageType::Audio, TranscodeStatus::Done, false),
            (MessageType::Audio, TranscodeStatus::Failed, false),
        ] {
            source.message_type = kind;
            source.transcode_status = status;
            let reason = ForwardPlaceholder::PendingAudio;
            assert_eq!(
                source_placeholder(&source, true).unwrap(),
                pending.then_some(reason)
            );
            assert_eq!(source_placeholder(&source, false).is_err(), pending);
        }
    }

    #[test]
    fn rejects_system_messages_and_single_invites() {
        let mut source = message(42);
        for kind in [MessageType::System, MessageType::Invite] {
            source.message_type = kind;
            assert!(matches!(
                source_placeholder(&source, true),
                Err(AppError::BadRequest(_))
            ));
        }
    }

    #[test]
    fn retry_matches_sender_destination_origin_and_bundle() {
        let mut existing = message(100);
        existing.forwarded_from_message_id = Some(1);
        existing.forwarded_bundle_id = Some(90);
        existing.reply_root_id = Some(80);
        assert!(validate_retry(&existing, 7, 42, Some(80), 1, Some(90)).is_ok());
        for (uid, chat, thread, origin, bundle) in [
            (8, 42, Some(80), 1, Some(90)),
            (7, 43, Some(80), 1, Some(90)),
            (7, 42, None, 1, Some(90)),
            (7, 42, Some(80), 2, Some(90)),
            (7, 42, Some(80), 1, Some(91)),
        ] {
            assert!(matches!(
                validate_retry(&existing, uid, chat, thread, origin, bundle),
                Err(AppError::Conflict(_))
            ));
        }
    }

    #[test]
    fn attribution_preserves_root_author_and_complete_nested_reply_preview() {
        let mut original = message(1);
        original.sender_uid = 8;
        original.reply_to_id = Some(2);
        let mut reply = message(2);
        reply.forwarded_from_message_id = Some(3);
        let mut reply_origin = message(3);
        reply_origin.sender_uid = 9;
        let mut forwarded = message(100);
        forwarded.forwarded_from_message_id = Some(1);
        let mut origins = ForwardOrigins {
            originals: HashMap::from([(1, original), (3, reply_origin)]),
            replies: HashMap::from([(2, reply)]),
            ..Default::default()
        };
        let profiles = [7, 8, 9]
            .into_iter()
            .map(|uid| {
                (
                    uid,
                    UserProfile {
                        username: Some(format!("user-{uid}")),
                        gender: 0,
                        user_group: None,
                    },
                )
            })
            .collect();
        let avatars = HashMap::new();
        let emojis = HashMap::from([(50, "🙂".into())]);
        let attachments = HashMap::from([(
            2,
            vec![Attachment {
                id: 20,
                message_id: Some(2),
                uploader_uid: Some(7),
                file_name: "image.png".into(),
                kind: "image/png".into(),
                external_reference: "image".into(),
                size: 10,
                created_at: Utc::now(),
                deleted_at: None,
                width: Some(10),
                height: Some(10),
                order: 0,
            }],
        )]);
        let info = origins
            .info_for(&forwarded, &avatars, &profiles, &emojis, &attachments)
            .unwrap();
        assert_eq!(info.sender.uid, 8);
        assert_eq!(info.original_message_id, 1);
        let preview = info.original_reply_to.as_ref().unwrap();
        assert_eq!(preview.forwarded_from_name.as_deref(), Some("user-9"));
        assert_eq!(preview.attachments[0].kind, "image/png");
        assert_eq!(preview.mentions[0].username.as_deref(), Some("user-9"));

        assert!(origins.can_jump_to_original_reply(&forwarded, &info));
        forwarded.chat_id = 43;
        assert!(!origins.can_jump_to_original_reply(&forwarded, &info));
        forwarded.chat_id = 42;
        let reply = origins.replies.get_mut(&2).unwrap();
        reply.message_type = MessageType::Sticker;
        reply.sticker_id = Some(50);
        let info = origins
            .info_for(&forwarded, &avatars, &profiles, &emojis, &attachments)
            .unwrap();
        let preview = info.original_reply_to.as_ref().unwrap();
        assert_eq!(
            preview
                .sticker
                .as_ref()
                .map(|sticker| sticker.emoji.as_str()),
            Some("🙂")
        );
        assert!(preview.forwarded_from_name.is_none());

        origins.replies.get_mut(&2).unwrap().deleted_at = Some(Utc::now());
        assert!(!preview.is_deleted);
        assert!(!origins.can_jump_to_original_reply(&forwarded, &info));
        let info = origins
            .info_for(&forwarded, &avatars, &profiles, &emojis, &attachments)
            .unwrap();
        let preview = info.original_reply_to.unwrap();
        assert!(preview.is_deleted);
        assert!(preview.message.is_none());
        assert!(preview.attachments.is_empty());
        assert!(preview.mentions.is_empty());
        assert!(preview.sticker.is_none());

        origins.replies.get_mut(&2).unwrap().reply_root_id = Some(50);
        assert!(origins
            .info_for(&forwarded, &avatars, &profiles, &emojis, &attachments)
            .unwrap()
            .original_reply_to
            .is_none());

        // Removing the original content does not remove attribution on copies.
        origins.originals.get_mut(&1).unwrap().deleted_at = Some(Utc::now());
        assert!(origins
            .info_for(&forwarded, &avatars, &profiles, &emojis, &attachments)
            .is_some());
        forwarded.message_type = MessageType::Sticker;
        assert!(origins
            .info_for(&forwarded, &avatars, &profiles, &emojis, &attachments)
            .is_none());
        forwarded.message_type = MessageType::Text;
        forwarded.deleted_at = Some(Utc::now());
        assert!(origins
            .info_for(&forwarded, &avatars, &profiles, &emojis, &attachments)
            .is_none());
    }

    #[test]
    fn request_accepts_string_ids_and_optional_thread() {
        let mut json = serde_json::json!({"sourceChatId": "42", "clientGeneratedId": "retry"});
        let body: ForwardMessageBody = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(body.source_chat_id, 42);
        assert_eq!(body.thread_id, None);
        json["threadId"] = "80".into();
        let body: ForwardMessageBody = serde_json::from_value(json).unwrap();
        assert_eq!(body.thread_id, Some(80));
    }

    /// Run against a migrated disposable database. Dropping the connection
    /// rolls back the fixture, including when an assertion fails.
    #[tokio::test]
    async fn database_attachment_copy_and_retry_require_live_source_access() {
        use diesel::connection::SimpleConnection;
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).expect("connect to test database");
        conn.batch_execute(
            "BEGIN;
             INSERT INTO groups(id, name) VALUES (-76000, 'single-forward-test');
             INSERT INTO group_membership(chat_id, uid) VALUES (-76000, 76000);
             INSERT INTO messages(id, chat_id, sender_uid, message_type, message,
                                  client_generated_id, created_at, has_attachments)
             VALUES (-76001, -76000, 76001, 'file', NULL, 'single-forward-source-test', NOW(), true);
             INSERT INTO attachments(id, message_id, kind, external_reference, size,
                                     created_at, file_name, \"order\", deleted_at)
             VALUES (-76002, -76001, 'application/pdf', 'last', 2, NOW(), 'last.pdf', 2, NULL),
                    (-76003, -76001, 'application/pdf', 'first', 1, NOW(), 'first.pdf', 0, NULL),
                    (-76004, -76001, 'application/pdf', 'deleted', 3, NOW(), 'deleted.pdf', 1, NOW());",
        ).unwrap();
        let id_gen = test_id_gen();
        let media = crate::services::media::test_media_store("https://media.example");
        let avatars = AvatarService::new(None, crate::metrics::Metrics::new().avatars);
        let deps = SingleForwardDeps {
            id_gen,
            media: &media,
            avatars: &avatars,
        };
        let body = ForwardMessageBody {
            allow_placeholders: false,
            source_chat_id: -76000,
            client_generated_id: "single-forward-retry-test".into(),
            thread_id: None,
        };
        let PreparedSingleForward::New(prepared) = prepare_single_forward(
            &mut conn,
            deps,
            76000,
            -76000,
            GroupKind::Group,
            -76001,
            &body,
        )
        .await
        .unwrap() else {
            panic!("first attempt must prepare a new copy")
        };
        let copies = prepared.attachments.forward_copies();
        assert_eq!(copies.len(), 2);
        assert_eq!(
            copies
                .iter()
                .map(|a| a.external_reference.as_str())
                .collect::<Vec<_>>(),
            ["first", "last"]
        );
        assert!(copies
            .iter()
            .all(|a| a.uploader_uid == Some(76000) && a.message_id.is_none()));

        // Simulate the committed send, then retry the same operation.
        conn.batch_execute(
            "INSERT INTO messages(id, chat_id, sender_uid, message_type, client_generated_id,
                                  created_at, forwarded_from_message_id)
             VALUES (-76005, -76000, 76000, 'file', 'single-forward-retry-test', NOW(), -76001);",
        )
        .unwrap();
        let PreparedSingleForward::Existing(existing) = prepare_single_forward(
            &mut conn,
            deps,
            76000,
            -76000,
            GroupKind::Group,
            -76001,
            &body,
        )
        .await
        .unwrap() else {
            panic!("retry must reuse the existing message")
        };
        assert_eq!(existing.id, -76005);
        conn.batch_execute("UPDATE messages SET deleted_at=NOW() WHERE id=-76001;")
            .unwrap();
        assert!(matches!(
            prepare_single_forward(
                &mut conn,
                deps,
                76000,
                -76000,
                GroupKind::Group,
                -76001,
                &body,
            )
            .await,
            Err(AppError::NotFound(_))
        ));
        conn.batch_execute(
            "UPDATE messages SET deleted_at=NULL WHERE id=-76001;
                            DELETE FROM group_membership WHERE chat_id=-76000;",
        )
        .unwrap();
        assert!(matches!(
            prepare_single_forward(
                &mut conn,
                deps,
                76000,
                -76000,
                GroupKind::Group,
                -76001,
                &body,
            )
            .await,
            Err(AppError::Forbidden(_))
        ));
        conn.batch_execute("ROLLBACK").unwrap();
    }

    #[tokio::test]
    async fn database_single_forward_reuses_flat_and_nested_bundles() {
        use crate::{
            dto::messages::ForwardMessagesBody,
            schema::forwarded_bundles,
            services::{
                forwarding::prepare_forward_message,
                messages::{load_chat_forwarded_bundle_id, load_target_forwarded_bundle_from_root},
            },
        };
        use diesel::connection::SimpleConnection;

        fn persist(conn: &mut PgConnection, id: i64, prepared: &PreparedMessageSend) {
            diesel::insert_into(messages::table)
                .values((
                    messages::id.eq(id),
                    messages::chat_id.eq(prepared.chat_id),
                    messages::sender_uid.eq(prepared.sender_uid),
                    messages::message.eq(&prepared.message),
                    messages::message_type.eq(&prepared.message_type),
                    messages::client_generated_id.eq(&prepared.client_generated_id),
                    messages::created_at.eq(Utc::now()),
                    messages::reply_root_id.eq(prepared.reply_root_id),
                    messages::forwarded_bundle_id.eq(prepared.forwarded_bundle_id),
                    messages::forwarded_from_message_id.eq(prepared.forwarded_from_message_id),
                ))
                .execute(conn)
                .unwrap();
        }

        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).expect("connect to test database");
        conn.batch_execute(
            "BEGIN;
             INSERT INTO groups(id, name) VALUES (-76200, 'bundle-source'), (-76210, 'bundle-destination');
             INSERT INTO group_membership(chat_id, uid) VALUES (-76200, 76200), (-76210, 76200);
             INSERT INTO messages(id, chat_id, sender_uid, message_type, message, client_generated_id, created_at)
             VALUES (-76201, -76200, 76201, 'text', 'first', 'bundle-first', NOW()),
                    (-76202, -76200, 76201, 'text', 'second', 'bundle-second', NOW()),
                    (-76211, -76210, 76200, 'text', 'thread root', 'bundle-thread', NOW());",
        ).unwrap();
        let id_gen = test_id_gen();
        let media = crate::services::media::test_media_store("https://media.example");
        let avatars = AvatarService::new(None, crate::metrics::Metrics::new().avatars);
        let deps = SingleForwardDeps {
            id_gen,
            media: &media,
            avatars: &avatars,
        };
        let mut flat_bundle_id = None;
        for (source_id, selection) in [
            (-76203, vec![-76201, -76202]),
            (-76204, vec![-76203, -76201]),
        ] {
            let merged = prepare_forward_message(
                &mut conn,
                id_gen,
                76200,
                -76200,
                GroupKind::Group,
                &ForwardMessagesBody {
                    allow_placeholders: false,
                    source_chat_id: -76200,
                    message_ids: selection,
                    client_generated_id: format!("bundle-merged-{source_id}"),
                    thread_id: None,
                },
            )
            .await
            .unwrap();
            persist(&mut conn, source_id, &merged);
            let bundle_id = merged.forwarded_bundle_id.unwrap();
            let count_before = forwarded_bundles::table
                .count()
                .get_result::<i64>(&mut conn)
                .unwrap();
            let body = ForwardMessageBody {
                allow_placeholders: false,
                source_chat_id: -76200,
                client_generated_id: format!("bundle-single-{source_id}"),
                thread_id: Some(-76211),
            };
            let PreparedSingleForward::New(prepared) = prepare_single_forward(
                &mut conn,
                deps,
                76200,
                -76210,
                GroupKind::Group,
                source_id,
                &body,
            )
            .await
            .unwrap() else {
                panic!("expected a new bundle copy")
            };
            assert_eq!(prepared.message_type, MessageType::Forwarded);
            assert_eq!(prepared.message, merged.message);
            assert_eq!(prepared.forwarded_bundle_id, Some(bundle_id));
            assert_eq!(prepared.forwarded_from_message_id, Some(source_id));
            assert_eq!(prepared.reply_root_id, Some(-76211));
            assert!(prepared.attachments.forward_copies().is_empty());
            let copy_id = source_id - 10;
            persist(&mut conn, copy_id, &prepared);
            // Deleting the source wrapper leaves the destination's bundle and
            // its child details accessible through destination membership.
            diesel::update(messages::table.find(source_id))
                .set(messages::deleted_at.eq(Utc::now()))
                .execute(&mut conn)
                .unwrap();
            let root = load_chat_forwarded_bundle_id(&mut conn, -76210, copy_id, 76200).unwrap();
            assert_eq!(root, bundle_id);
            let bundle = load_target_forwarded_bundle_from_root(&mut conn, root, root).unwrap();
            assert_eq!(bundle.item_count, 2);
            assert_eq!(bundle.preview.as_array().unwrap().len(), 2);
            if let Some(child) = flat_bundle_id {
                assert_eq!(bundle.child_bundle_ids, vec![child]);
                assert_eq!(
                    load_target_forwarded_bundle_from_root(&mut conn, root, child)
                        .unwrap()
                        .id,
                    child
                );
            } else {
                assert!(bundle.child_bundle_ids.is_empty());
                flat_bundle_id = Some(root);
            }
            assert!(load_chat_forwarded_bundle_id(&mut conn, -76210, copy_id, 76201).is_err());
            // Re-forwarding a copy retains the root origin even after deletion,
            // and must not add a bundle or increase the nesting depth.
            let PreparedSingleForward::New(repeated) = prepare_single_forward(
                &mut conn,
                deps,
                76200,
                -76210,
                GroupKind::Group,
                copy_id,
                &ForwardMessageBody {
                    allow_placeholders: false,
                    source_chat_id: -76210,
                    client_generated_id: format!("bundle-repeat-{source_id}"),
                    thread_id: None,
                },
            )
            .await
            .unwrap() else {
                panic!("expected a repeated bundle copy")
            };
            assert_eq!(repeated.forwarded_bundle_id, Some(bundle_id));
            assert_eq!(repeated.forwarded_from_message_id, Some(source_id));
            assert_eq!(
                forwarded_bundles::table
                    .count()
                    .get_result::<i64>(&mut conn)
                    .unwrap(),
                count_before
            );
            // Restore the flat wrapper so the next iteration can select it.
            diesel::update(messages::table.find(source_id))
                .set(messages::deleted_at.eq(None::<chrono::DateTime<Utc>>))
                .execute(&mut conn)
                .unwrap();
        }
        conn.batch_execute("ROLLBACK").unwrap();
    }

    #[tokio::test]
    async fn database_forward_holds_source_lock_until_copy_transaction_ends() {
        use diesel::connection::SimpleConnection;
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        // Two connections need committed fixtures. Drop this after both
        // connections, so failed assertions release locks before cleanup.
        struct Fixture(String);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let mut conn = PgConnection::establish(&self.0).unwrap();
                conn.batch_execute(
                    "BEGIN;
                     DELETE FROM attachments WHERE id IN (-76102, -76103);
                     DELETE FROM messages WHERE chat_id = -76100;
                     DELETE FROM group_membership WHERE chat_id = -76100;
                     DELETE FROM groups WHERE id = -76100;
                     COMMIT;",
                )
                .unwrap();
            }
        }
        let _fixture = Fixture(url.clone());
        let mut conn = PgConnection::establish(&url).unwrap();
        let mut editor = PgConnection::establish(&url).unwrap();
        conn.batch_execute(
            "BEGIN;
             INSERT INTO groups(id, name) VALUES (-76100, 'forward-lock-test');
             INSERT INTO group_membership(chat_id, uid) VALUES (-76100, 76100);
             INSERT INTO messages(id, chat_id, sender_uid, message_type, message,
                                  client_generated_id, created_at, has_attachments)
             VALUES (-76101, -76100, 76100, 'text', 'old caption', 'forward-lock-source', NOW(), true);
             INSERT INTO attachments(id, message_id, uploader_uid, kind, external_reference,
                                     size, created_at, file_name)
             VALUES (-76102, -76101, 76100, 'image/png', 'old.png', 1, NOW(), 'old.png'),
                    (-76103, NULL, 76100, 'image/png', 'new.png', 1, NOW(), 'new.png');
             COMMIT;
             BEGIN;",
        ).unwrap();
        let id_gen = test_id_gen();
        let media = crate::services::media::test_media_store("https://media.example");
        let avatars = AvatarService::new(None, crate::metrics::Metrics::new().avatars);
        let deps = SingleForwardDeps {
            id_gen,
            media: &media,
            avatars: &avatars,
        };
        let body = ForwardMessageBody {
            allow_placeholders: false,
            source_chat_id: -76100,
            client_generated_id: "forward-lock-copy".into(),
            thread_id: None,
        };
        let PreparedSingleForward::New(prepared) = prepare_single_forward(
            &mut conn,
            deps,
            76100,
            -76100,
            GroupKind::Group,
            -76101,
            &body,
        )
        .await
        .unwrap() else {
            panic!("expected a new copy");
        };
        // A second forward can update its destination root while both hold the source.
        editor
            .batch_execute("BEGIN; SET LOCAL lock_timeout = '1s';")
            .unwrap();
        load_forward_sources(&mut editor, 76100, -76100, &[-76101]).unwrap();
        editor
            .batch_execute("UPDATE messages SET has_thread=true WHERE id=-76101; ROLLBACK;")
            .unwrap();
        // Match patch_message's lock-before-replacing-attachments protocol.
        let edit = "BEGIN;
                    SET LOCAL lock_timeout = '100ms';
                    SELECT id FROM messages WHERE id = -76101 FOR UPDATE;
                    UPDATE messages SET message = 'new caption' WHERE id = -76101;
                    UPDATE attachments SET message_id = NULL WHERE id = -76102;
                    UPDATE attachments SET message_id = -76101 WHERE id = -76103;
                    COMMIT;";
        let error = editor
            .batch_execute(edit)
            .expect_err("edit must wait for the source lock");
        assert!(error.to_string().contains("lock timeout"), "{error}");
        editor.batch_execute("ROLLBACK").unwrap();
        let copied_file = &prepared.attachments.forward_copies()[0].file_name;
        assert_eq!(prepared.message.as_deref(), Some("old caption"));
        assert_eq!(copied_file, "old.png");
        conn.batch_execute("ROLLBACK").unwrap();

        // After the forwarding transaction ends, the edit succeeds and the
        // next copy sees the complete new version.
        editor.batch_execute(edit).unwrap();
        conn.batch_execute("BEGIN").unwrap();
        let PreparedSingleForward::New(prepared) = prepare_single_forward(
            &mut conn,
            deps,
            76100,
            -76100,
            GroupKind::Group,
            -76101,
            &body,
        )
        .await
        .unwrap() else {
            panic!("expected a new copy");
        };
        let copied_file = &prepared.attachments.forward_copies()[0].file_name;
        assert_eq!(prepared.message.as_deref(), Some("new caption"));
        assert_eq!(copied_file, "new.png");
        conn.batch_execute("ROLLBACK").unwrap();

        conn.batch_execute(
            "INSERT INTO messages(id, chat_id, sender_uid, message_type, client_generated_id, created_at, reply_to_id)
             VALUES (-76099, -76100, 76100, 'text', 'forward-lock-reply', NOW(), -76101),
                    (-76098, -76100, 76100, 'text', 'forward-lock-other', NOW(), NULL);",
        ).unwrap();
        std::thread::scope(|scope| {
            let forward = editor.transaction::<_, AppError, _>(|editor| {
                editor.batch_execute("SET LOCAL statement_timeout = '5s';
                    SELECT id FROM messages WHERE id = -76101 FOR UPDATE;")?;
                let forward = scope.spawn(|| load_forward_sources(&mut conn, 76100, -76100, &[-76099, -76098]));
                // Resume the bulk recall only once the forward is waiting for its quote.
                editor.batch_execute("DO $$ BEGIN WHILE NOT EXISTS (
                    SELECT 1 FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))
                ) LOOP PERFORM pg_sleep(0.01); END LOOP; END $$;")?;
                crate::services::message_deletion::delete_selection(editor, -76100, 76100, false, &[-76101, -76099])?;
                Ok(forward)
            }).unwrap();
            let sources = forward.join().unwrap().unwrap();
            assert_eq!(
                sources.selected.iter().map(|m| m.id).collect::<Vec<_>>(),
                [-76098]
            );
            assert!(sources.external_replies.is_empty());
        });
    }
}
