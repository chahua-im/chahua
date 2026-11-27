//! Single-message forwarding keeps message content, shared bundles and a flattened origin.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use diesel::prelude::*;

use crate::{
    dto::messages::{ForwardMessageBody, ForwardedFromInfo},
    errors::AppError,
    models::{Attachment, GroupKind, Message, MessageType, NewAttachment, TranscodeStatus},
    schema::{attachments, messages},
    services::{
        forwarding::{acquire_forward_retry_lock, check_source_membership, source_placeholder},
        messages::{
            attachment_previews, build_message_preview, build_sender, extract_mention_uids,
            MessagePreviewInput, PreparedMessageSend, MESSAGE_ID_CONFLICT,
        },
        user::UserProfile,
    },
    utils::ids::{self, IdGen},
};

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
    id_gen: &IdGen,
    uid: i32,
    destination_chat_id: i64,
    destination_kind: GroupKind,
    source_message_id: i64,
    body: &ForwardMessageBody,
) -> Result<PreparedSingleForward, AppError> {
    acquire_forward_retry_lock(conn, &body.client_generated_id)?;
    check_source_membership(conn, body.source_chat_id, uid)?;
    // Edits lock the message before replacing its attachments. Hold the same
    // lock through copying so both reads see one version of the source.
    let source = messages::table
        .filter(messages::id.eq(source_message_id))
        .filter(messages::chat_id.eq(body.source_chat_id))
        .filter(messages::deleted_at.is_null())
        .filter(
            messages::is_published.eq(true).or(messages::sender_uid
                .eq(uid)
                .and(messages::message_type.eq(MessageType::Audio))
                .and(
                    messages::transcode_status
                        .eq_any([TranscodeStatus::None, TranscodeStatus::Pending]),
                )),
        )
        .for_update()
        .select(Message::as_select())
        .first::<Message>(conn)
        .optional()?
        .ok_or(AppError::NotFound("Message not found"))?;
    let origin_id = source.forwarded_from_message_id.unwrap_or(source.id);
    if let Some(existing) = messages::table
        .filter(messages::client_generated_id.eq(&body.client_generated_id))
        .for_update()
        .select(Message::as_select())
        .first::<Message>(conn)
        .optional()?
    {
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

    if let Some(reason) = source_placeholder(&source, body.allow_placeholders)? {
        return Ok(PreparedSingleForward::New(Box::new(PreparedMessageSend {
            system_kind: None,
            chat_id: destination_chat_id,
            chat_kind: destination_kind,
            sender_uid: uid,
            message: Some(reason.as_str().to_owned()),
            metadata: None,
            message_type: MessageType::Placeholder,
            sticker_id: None,
            reply_to_id: None,
            reply_root_id: body.thread_id,
            client_generated_id: body.client_generated_id.clone(),
            attachment_ids: Vec::new(),
            publish_immediately: true,
            forwarded_from_message_id: Some(origin_id),
            forwarded_bundle_id: None,
            forwarded_preview_total: None,
            forwarded_preview_contains_forwarded_messages: None,
            forwarded_preview_items: None,
        })));
    }

    let source_attachments = attachments::table
        .filter(attachments::message_id.eq(source.id))
        .filter(attachments::deleted_at.is_null())
        .order((attachments::order.asc(), attachments::id.asc()))
        .select(Attachment::as_select())
        .load::<Attachment>(conn)?;
    let mut cloned = Vec::with_capacity(source_attachments.len());
    for attachment in source_attachments {
        let id = ids::next_id(id_gen).await.map_err(|error| {
            tracing::error!(?error, "failed to allocate forwarded attachment ID");
            AppError::Internal("ID generation failed")
        })?;
        cloned.push(NewAttachment {
            id,
            message_id: None,
            uploader_uid: Some(uid),
            file_name: attachment.file_name,
            kind: attachment.kind,
            external_reference: attachment.external_reference,
            size: attachment.size,
            created_at: Utc::now(),
            deleted_at: None,
            width: attachment.width,
            height: attachment.height,
            order: attachment.order,
        });
    }
    let attachment_ids = cloned.iter().map(|attachment| attachment.id).collect();
    if !cloned.is_empty() {
        diesel::insert_into(attachments::table)
            .values(&cloned)
            .execute(conn)?;
    }
    let metadata = super::messages::snapshot_link_metadata(&source)
        .map(|metadata| serde_json::to_value(metadata).expect("snapshot metadata is serializable"));
    Ok(PreparedSingleForward::New(Box::new(PreparedMessageSend {
        system_kind: None,
        chat_id: destination_chat_id,
        chat_kind: destination_kind,
        sender_uid: uid,
        message: source.message,
        metadata,
        message_type: source.message_type,
        sticker_id: source.sticker_id,
        reply_to_id: None,
        reply_root_id: body.thread_id,
        client_generated_id: body.client_generated_id.clone(),
        attachment_ids,
        publish_immediately: true,
        forwarded_from_message_id: Some(origin_id),
        // Bundles are immutable. Reuse the selected bundle without adding a nesting level;
        // the normal message hydrator loads its compact preview for the send response.
        forwarded_bundle_id: source.forwarded_bundle_id,
        forwarded_preview_total: None,
        forwarded_preview_contains_forwarded_messages: None,
        forwarded_preview_items: None,
    })))
}

/// Loaded once for a page, including origins used by ordinary reply previews and
/// by the original reply context inside a forwarded message.
#[derive(Default)]
pub(crate) struct ForwardOrigins {
    originals: HashMap<i64, Message>,
    replies: HashMap<i64, Message>,
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
        conn: &mut PgConnection,
        sources: impl Iterator<Item = &'a Message>,
    ) -> QueryResult<Self> {
        let ids = sources
            .filter(|message| message.deleted_at.is_none())
            .filter_map(|message| message.forwarded_from_message_id)
            .collect();
        Ok(Self {
            originals: load_messages(conn, &ids)?,
            replies: HashMap::new(),
        })
    }

    pub(crate) fn load<'a>(
        conn: &mut PgConnection,
        sources: impl Iterator<Item = &'a Message>,
    ) -> QueryResult<Self> {
        let mut origins = Self::load_attribution(conn, sources)?;
        let reply_ids = origins
            .originals
            .values()
            .filter_map(|message| message.reply_to_id)
            .collect();
        let mut replies = load_messages(conn, &reply_ids)?;
        replies.retain(|_, message| {
            message.is_published && !message.system_kind.is_some_and(|kind| kind.is_membership())
        });
        let nested_origin_ids = replies
            .values()
            .filter_map(|message| message.forwarded_from_message_id)
            .filter(|id| !origins.originals.contains_key(id))
            .collect();
        origins
            .originals
            .extend(load_messages(conn, &nested_origin_ids)?);
        origins.replies = replies;
        Ok(origins)
    }

    pub(crate) fn replies(&self) -> impl Iterator<Item = &Message> {
        self.replies.values()
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
        let original = self.originals.get(&message.forwarded_from_message_id?)?;
        let original_reply_to = original
            .reply_to_id
            .and_then(|id| self.replies.get(&id))
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
        Some(ForwardedFromInfo {
            sender: build_sender(original.sender_uid, avatars, profiles),
            original_chat_id: original.chat_id,
            original_message_id: original.id,
            original_reply_to,
        })
    }
}

#[cfg(test)]
mod tests;
