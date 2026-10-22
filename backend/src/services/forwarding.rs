use chrono::Utc;
use diesel::prelude::*;

use crate::{
    dto::messages::{ForwardMessagesBody, ForwardedBundlePayloadItem},
    errors::AppError,
    models::{Message, MessageType, NewForwardedBundle},
    schema::{forwarded_bundles, group_membership, messages, messages::dsl},
    services::messages::{
        build_forwarded_preview_items, build_forwarded_preview_payload,
        capture_forwarded_bundle_items, deserialize_forwarded_bundle_payload,
        load_forwarded_bundle, PreparedMessageSend,
    },
    utils::ids::{self, IdGen},
};

const MAX_FORWARD_MESSAGES: usize = 100;
const FORWARD_REQUEST_CONFLICT: &str = "clientGeneratedId already exists with different payload";
const SYSTEM_MESSAGE_FORWARD_FORBIDDEN: &str = "System messages cannot be forwarded";
const INVITE_MESSAGE_FORWARD_FORBIDDEN: &str = "Invite messages cannot be forwarded";

fn canonical_forward_message_ids(message_ids: &[i64]) -> Result<Vec<i64>, AppError> {
    if message_ids.is_empty() {
        return Err(AppError::BadRequest("Message IDs cannot be empty"));
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

fn validate_forwardable_source_message_type(message_type: &MessageType) -> Result<(), AppError> {
    if matches!(message_type, MessageType::System) {
        return Err(AppError::BadRequest(SYSTEM_MESSAGE_FORWARD_FORBIDDEN));
    }
    if matches!(message_type, MessageType::Invite) {
        return Err(AppError::BadRequest(INVITE_MESSAGE_FORWARD_FORBIDDEN));
    }
    Ok(())
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

fn acquire_forward_retry_lock(
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

fn check_source_membership(
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
    sender_uid: i32,
    client_generated_id: String,
    bundle_id: i64,
    message_count: usize,
    contains_forwarded_messages: bool,
    preview_items: Vec<crate::dto::messages::ForwardedMessagePreviewSnapshot>,
) -> PreparedMessageSend {
    PreparedMessageSend {
        chat_id,
        sender_uid,
        message: Some(forwarded_wrapper_text(message_count)),
        message_type: MessageType::Forwarded,
        sticker_id: None,
        reply_to_id: None,
        reply_root_id: None,
        client_generated_id,
        attachment_ids: Vec::new(),
        publish_immediately: true,
        forwarded_bundle_id: Some(bundle_id),
        forwarded_preview_total: Some(message_count),
        forwarded_preview_contains_forwarded_messages: Some(contains_forwarded_messages),
        forwarded_preview_items: Some(preview_items),
    }
}

pub async fn prepare_forward_message(
    conn: &mut PgConnection,
    id_gen: &IdGen,
    uid: i32,
    destination_chat_id: i64,
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
            || !matches!(existing.message_type, MessageType::Forwarded)
        {
            return Err(AppError::Conflict(FORWARD_REQUEST_CONFLICT));
        }

        let bundle_id = existing
            .forwarded_bundle_id
            .ok_or(AppError::Conflict(FORWARD_REQUEST_CONFLICT))?;
        let bundle = load_forwarded_bundle(conn, bundle_id)
            .map_err(|_| AppError::Conflict(FORWARD_REQUEST_CONFLICT))?;
        let contains_forwarded_messages = !bundle.child_bundle_ids.is_empty();
        let (message_count, items) = deserialize_forwarded_bundle_payload(bundle)?;
        if !forwarded_payload_matches_selection(&items, body.source_chat_id, &canonical_message_ids)
        {
            return Err(AppError::Conflict(FORWARD_REQUEST_CONFLICT));
        }

        return Ok(prepared_forward_message(
            destination_chat_id,
            uid,
            body.client_generated_id.clone(),
            bundle_id,
            message_count,
            contains_forwarded_messages,
            build_forwarded_preview_items(&items),
        ));
    }

    check_source_membership(conn, body.source_chat_id, uid)?;
    let source_messages: Vec<Message> = messages::table
        .filter(
            dsl::chat_id
                .eq(body.source_chat_id)
                .and(dsl::id.eq_any(&canonical_message_ids))
                .and(dsl::deleted_at.is_null())
                .and(dsl::is_published.eq(true)),
        )
        .order(dsl::id.asc())
        .select(Message::as_select())
        .load(conn)?;
    if source_messages.len() != canonical_message_ids.len() {
        return Err(AppError::BadRequest("Invalid message IDs"));
    }
    for source_message in &source_messages {
        validate_forwardable_source_message_type(&source_message.message_type)?;
    }

    let items = capture_forwarded_bundle_items(conn, &source_messages)?;
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
        uid,
        body.client_generated_id.clone(),
        bundle_id,
        message_count,
        contains_forwarded_messages,
        preview_items,
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_forward_message_ids, direct_child_bundle_ids,
        forwarded_payload_matches_selection, validate_forwardable_source_message_type,
    };
    use crate::{
        dto::messages::{
            ForwardedBundlePayloadItem, ForwardedBundleRefSnapshot, ForwardedMessageSnapshot,
            ForwardedMessagesPreviewSnapshot,
        },
        models::MessageType,
    };
    use chrono::Utc;

    fn snapshot_item(
        original_message_id: i64,
        original_chat_id: i64,
    ) -> ForwardedBundlePayloadItem {
        ForwardedBundlePayloadItem::MessageSnapshot {
            snapshot: ForwardedMessageSnapshot {
                original_message_id,
                original_chat_id,
                message: Some(format!("message {original_message_id}")),
                message_type: MessageType::Text,
                sender_uid: 7,
                original_created_at: Utc::now(),
                sticker: None,
                reply: None,
                attachments: Vec::new(),
                mention_uids: Vec::new(),
            },
        }
    }

    #[test]
    fn forward_selection_is_canonical_across_lost_response_retries() {
        let first_attempt = canonical_forward_message_ids(&[30, 10, 20]).unwrap();
        let retry = canonical_forward_message_ids(&[20, 30, 10]).unwrap();

        assert_eq!(first_attempt, vec![10, 20, 30]);
        assert_eq!(retry, first_attempt);
    }

    #[test]
    fn forward_selection_rejects_duplicate_original_messages() {
        assert!(canonical_forward_message_ids(&[10, 20, 10]).is_err());
    }

    #[test]
    fn forward_retry_requires_exact_stored_source_and_selection() {
        let items = vec![snapshot_item(10, 42), snapshot_item(20, 42)];

        assert!(forwarded_payload_matches_selection(&items, 42, &[10, 20]));
        assert!(!forwarded_payload_matches_selection(&items, 42, &[10, 21]));
        assert!(!forwarded_payload_matches_selection(&items, 43, &[10, 20]));
    }

    #[test]
    fn rejects_non_forwardable_source_message_types() {
        assert!(validate_forwardable_source_message_type(&MessageType::System).is_err());
        assert!(validate_forwardable_source_message_type(&MessageType::Invite).is_err());
        assert!(validate_forwardable_source_message_type(&MessageType::Text).is_ok());
        assert!(validate_forwardable_source_message_type(&MessageType::Forwarded).is_ok());
    }

    #[test]
    fn child_bundle_ids_are_derived_from_payload_references() {
        let bundle_ref = ForwardedBundleRefSnapshot {
            original_message_id: 12,
            original_chat_id: 42,
            forwarded_bundle_id: 99,
            message: Some("Forwarded message".to_string()),
            message_type: MessageType::Forwarded,
            sender_uid: 7,
            original_created_at: Utc::now(),
            reply: None,
            preview: ForwardedMessagesPreviewSnapshot {
                total: 1,
                contains_forwarded_messages: false,
                messages: Vec::new(),
            },
        };
        let items = vec![
            ForwardedBundlePayloadItem::ForwardedBundleRef {
                bundle_ref: bundle_ref.clone(),
            },
            ForwardedBundlePayloadItem::ForwardedBundleRef { bundle_ref },
        ];
        assert_eq!(direct_child_bundle_ids(&items), vec![99]);
    }
}
