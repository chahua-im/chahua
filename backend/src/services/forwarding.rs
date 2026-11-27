use chrono::Utc;
use diesel::prelude::*;

use crate::{
    dto::messages::{
        ForwardMessagesBody, ForwardedBundlePayloadItem, ForwardedMessagesPreviewSnapshot,
    },
    errors::AppError,
    models::{
        ForwardPlaceholder, GroupKind, Message, MessageType, NewForwardedBundle, TranscodeStatus,
    },
    schema::{forwarded_bundles, group_membership, messages, messages::dsl},
    services::messages::{
        build_forwarded_preview_items, build_forwarded_preview_payload,
        capture_forwarded_bundle_items, deserialize_forwarded_bundle_payload,
        load_forwarded_bundle, PreparedMessageSend, MESSAGE_ID_CONFLICT,
    },
    utils::ids::{self, IdGen},
};

const MAX_FORWARD_MESSAGES: usize = 100;
const SYSTEM_MESSAGE_FORWARD_FORBIDDEN: &str = "System messages cannot be forwarded";
const INVITE_MESSAGE_FORWARD_FORBIDDEN: &str = "Invite messages cannot be forwarded";

fn canonical_forward_message_ids(message_ids: &[i64]) -> Result<Vec<i64>, AppError> {
    if message_ids.len() < 2 {
        return Err(AppError::BadRequest(
            "Select at least two messages to forward",
        ));
    }
    if message_ids.len() > MAX_FORWARD_MESSAGES {
        return Err(AppError::BadRequest("Too many messages to forward"));
    }

    let mut canonical_ids = message_ids.to_vec();
    canonical_ids.sort_unstable();
    if canonical_ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(AppError::BadRequest(
            "Message IDs cannot contain duplicates",
        ));
    }

    Ok(canonical_ids)
}

pub(crate) fn validate_forwardable_source(
    message_type: &MessageType,
    transcode_status: TranscodeStatus,
) -> Result<(), AppError> {
    if matches!(message_type, MessageType::System) {
        return Err(AppError::BadRequest(SYSTEM_MESSAGE_FORWARD_FORBIDDEN));
    }
    if matches!(message_type, MessageType::Invite) {
        return Err(AppError::BadRequest(INVITE_MESSAGE_FORWARD_FORBIDDEN));
    }
    // Published legacy audio can still be transcoded, which deletes the old
    // object. Only snapshot audio once its attachment has reached a final state.
    if matches!(message_type, MessageType::Audio)
        && !matches!(
            transcode_status,
            TranscodeStatus::Done | TranscodeStatus::Failed
        )
    {
        return Err(AppError::BadRequest(
            "Audio messages cannot be forwarded until transcoding finishes",
        ));
    }
    Ok(())
}

pub(crate) fn source_placeholder(
    message: &Message,
    allow_placeholders: bool,
) -> Result<Option<ForwardPlaceholder>, AppError> {
    if message.message_type == MessageType::Audio
        && !matches!(
            message.transcode_status,
            TranscodeStatus::Done | TranscodeStatus::Failed
        )
        && allow_placeholders
    {
        return Ok(Some(ForwardPlaceholder::PendingAudio));
    }
    validate_forwardable_source(&message.message_type, message.transcode_status)?;
    // Already captured placeholders never recover their original content.
    if message.message_type == MessageType::Placeholder {
        return message
            .message
            .as_deref()
            .and_then(ForwardPlaceholder::from_code)
            .map(Some)
            .ok_or(AppError::Internal("Invalid stored placeholder reason"));
    }
    Ok(None)
}

fn forwarded_payload_matches_selection(
    items: &[ForwardedBundlePayloadItem],
    source_chat_id: i64,
    canonical_message_ids: &[i64],
) -> bool {
    items.len() == canonical_message_ids.len()
        && items
            .iter()
            .zip(canonical_message_ids)
            .all(|(item, original_message_id)| match item {
                ForwardedBundlePayloadItem::MessageSnapshot { snapshot } => {
                    snapshot.original_chat_id == source_chat_id
                        && snapshot.original_message_id == *original_message_id
                }
                ForwardedBundlePayloadItem::ForwardedBundleRef { bundle_ref } => {
                    bundle_ref.original_chat_id == source_chat_id
                        && bundle_ref.original_message_id == *original_message_id
                }
            })
}

#[derive(diesel::QueryableByName)]
struct AdvisoryLockAcquired {
    #[diesel(sql_type = diesel::sql_types::Integer)]
    _lock_acquired: i32,
}

pub(crate) fn acquire_forward_retry_lock(
    conn: &mut PgConnection,
    client_generated_id: &str,
) -> Result<(), AppError> {
    let _ = diesel::sql_query(
        "SELECT 1 AS _lock_acquired \
         FROM pg_advisory_xact_lock(hashtextextended($1, 0))",
    )
    .bind::<diesel::sql_types::Text, _>(client_generated_id)
    .get_result::<AdvisoryLockAcquired>(conn)?;
    Ok(())
}

pub(crate) fn check_source_membership(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
) -> Result<(), AppError> {
    let exists = group_membership::table
        .filter(
            group_membership::chat_id
                .eq(chat_id)
                .and(group_membership::uid.eq(uid)),
        )
        .count()
        .get_result::<i64>(conn)?;

    if exists == 0 {
        return Err(AppError::Forbidden("Not a member of this chat"));
    }
    Ok(())
}

fn direct_child_bundle_ids(items: &[ForwardedBundlePayloadItem]) -> Vec<i64> {
    let mut child_bundle_ids: Vec<i64> = items
        .iter()
        .filter_map(|item| match item {
            ForwardedBundlePayloadItem::ForwardedBundleRef { bundle_ref } => {
                Some(bundle_ref.forwarded_bundle_id)
            }
            ForwardedBundlePayloadItem::MessageSnapshot { .. } => None,
        })
        .collect();
    child_bundle_ids.sort_unstable();
    child_bundle_ids.dedup();
    child_bundle_ids
}

fn forwarded_wrapper_text(message_count: usize) -> String {
    format!("Forwarded {message_count} messages")
}

fn prepared_forward_message(
    chat_id: i64,
    chat_kind: GroupKind,
    sender_uid: i32,
    body: &ForwardMessagesBody,
    bundle_id: i64,
    preview: ForwardedMessagesPreviewSnapshot,
) -> PreparedMessageSend {
    PreparedMessageSend {
        system_kind: None,
        forwarded_from_message_id: None,
        chat_id,
        chat_kind,
        sender_uid,
        message: Some(forwarded_wrapper_text(preview.total)),
        metadata: None,
        message_type: MessageType::Forwarded,
        sticker_id: None,
        reply_to_id: None,
        reply_root_id: body.thread_id,
        client_generated_id: body.client_generated_id.clone(),
        attachment_ids: Vec::new(),
        publish_immediately: true,
        forwarded_bundle_id: Some(bundle_id),
        forwarded_preview_total: Some(preview.total),
        forwarded_preview_contains_forwarded_messages: Some(preview.contains_forwarded_messages),
        forwarded_preview_items: Some(preview.messages),
    }
}

pub async fn prepare_forward_message(
    conn: &mut PgConnection,
    id_gen: &IdGen,
    uid: i32,
    destination_chat_id: i64,
    destination_kind: GroupKind,
    body: &ForwardMessagesBody,
) -> Result<PreparedMessageSend, AppError> {
    let canonical_message_ids = canonical_forward_message_ids(&body.message_ids)?;
    acquire_forward_retry_lock(conn, &body.client_generated_id)?;

    let existing = messages::table
        .filter(dsl::client_generated_id.eq(&body.client_generated_id))
        .for_update()
        .select(Message::as_select())
        .first::<Message>(conn)
        .optional()?;

    if let Some(existing) = existing {
        if existing.sender_uid != uid
            || existing.chat_id != destination_chat_id
            || existing.reply_root_id != body.thread_id
            || !matches!(existing.message_type, MessageType::Forwarded)
        {
            return Err(AppError::Conflict(MESSAGE_ID_CONFLICT));
        }

        let bundle_id = existing
            .forwarded_bundle_id
            .ok_or(AppError::Conflict(MESSAGE_ID_CONFLICT))?;
        let bundle = load_forwarded_bundle(conn, bundle_id)
            .map_err(|_| AppError::Conflict(MESSAGE_ID_CONFLICT))?;
        let contains_forwarded_messages = !bundle.child_bundle_ids.is_empty();
        let (message_count, items) = deserialize_forwarded_bundle_payload(bundle)?;
        if !forwarded_payload_matches_selection(&items, body.source_chat_id, &canonical_message_ids)
        {
            return Err(AppError::Conflict(MESSAGE_ID_CONFLICT));
        }

        return Ok(prepared_forward_message(
            destination_chat_id,
            destination_kind,
            uid,
            body,
            bundle_id,
            ForwardedMessagesPreviewSnapshot {
                total: message_count,
                contains_forwarded_messages,
                messages: build_forwarded_preview_items(&items),
            },
        ));
    }

    check_source_membership(conn, body.source_chat_id, uid)?;
    let source_messages: Vec<Message> = messages::table
        .filter(
            dsl::chat_id
                .eq(body.source_chat_id)
                .and(dsl::id.eq_any(&canonical_message_ids))
                .and(dsl::deleted_at.is_null())
                .and(
                    dsl::is_published.eq(true).or(dsl::sender_uid
                        .eq(uid)
                        .and(dsl::message_type.eq(MessageType::Audio))
                        .and(
                            dsl::transcode_status
                                .eq_any([TranscodeStatus::None, TranscodeStatus::Pending]),
                        )),
                ),
        )
        .order(dsl::id.asc())
        .select(Message::as_select())
        .load(conn)?;
    if source_messages.len() != canonical_message_ids.len() {
        return Err(AppError::BadRequest("Invalid message IDs"));
    }
    let items = capture_forwarded_bundle_items(conn, &source_messages, body.allow_placeholders)?;
    let message_count = items.len();
    let child_bundle_ids = direct_child_bundle_ids(&items);
    let contains_forwarded_messages = !child_bundle_ids.is_empty();
    let preview_items = build_forwarded_preview_items(&items);
    let payload = serde_json::to_value(&items)
        .map_err(|_| AppError::Internal("Failed to serialize forwarded messages"))?;
    let preview = build_forwarded_preview_payload(&preview_items)?;
    let bundle_id = ids::next_id(id_gen).await.map_err(|error| {
        tracing::error!("next_id for forwarded bundle: {error:?}");
        AppError::Internal("ID generation failed")
    })?;

    diesel::insert_into(forwarded_bundles::table)
        .values(NewForwardedBundle {
            id: bundle_id,
            created_by_uid: uid,
            created_at: Utc::now(),
            item_count: message_count as i32,
            payload,
            child_bundle_ids,
            preview,
        })
        .execute(conn)?;

    Ok(prepared_forward_message(
        destination_chat_id,
        destination_kind,
        uid,
        body,
        bundle_id,
        ForwardedMessagesPreviewSnapshot {
            total: message_count,
            contains_forwarded_messages,
            messages: preview_items,
        },
    ))
}

#[cfg(test)]
mod tests;
