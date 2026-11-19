use chrono::Utc;
use diesel::prelude::*;

use crate::{
    dto::messages::{
        ForwardMessagesBody, ForwardedBundlePayloadItem, ForwardedMessagesPreviewSnapshot,
    },
    dto::rpc::messages::ForwardTarget,
    errors::{AppError, ForwardPlaceholderConsent},
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

pub(super) const MAX_FORWARD_MESSAGES: usize = 100;
const SYSTEM_MESSAGE_FORWARD_FORBIDDEN: &str = "System messages cannot be forwarded";
const INVITE_MESSAGE_FORWARD_FORBIDDEN: &str = "Invite messages cannot be forwarded";

pub(super) fn canonical_forward_message_ids(
    mut message_ids: Vec<i64>,
) -> Result<Vec<i64>, AppError> {
    if message_ids.is_empty() {
        return Err(AppError::BadRequest(
            "Select at least one message to forward",
        ));
    }
    if message_ids.len() > MAX_FORWARD_MESSAGES {
        return Err(AppError::BadRequest("Too many messages to forward"));
    }

    message_ids.sort_unstable();
    if message_ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(AppError::BadRequest(
            "Message IDs cannot contain duplicates",
        ));
    }

    Ok(message_ids)
}

pub(crate) fn source_placeholder(
    message: &Message,
    allow_placeholders: bool,
) -> Result<Option<ForwardPlaceholder>, AppError> {
    match message.message_type {
        MessageType::System => Err(AppError::BadRequest(SYSTEM_MESSAGE_FORWARD_FORBIDDEN)),
        MessageType::Invite => Err(AppError::BadRequest(INVITE_MESSAGE_FORWARD_FORBIDDEN)),
        // Transcoding can replace the storage object even for published legacy audio.
        _ if message.audio_pending() => {
            let reason = ForwardPlaceholder::PendingAudio;
            if allow_placeholders {
                Ok(Some(reason))
            } else {
                Err(AppError::ForwardPlaceholderRequired(
                    ForwardPlaceholderConsent {
                        by_message: [(message.id, reason)].into(),
                    },
                ))
            }
        }
        MessageType::Placeholder => message
            .message
            .as_deref()
            .and_then(ForwardPlaceholder::from_code)
            .map(Some)
            .ok_or(AppError::Internal("Invalid stored placeholder reason")),
        _ => Ok(None),
    }
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
    let member = group_membership::table
        .filter(
            group_membership::chat_id
                .eq(chat_id)
                .and(group_membership::uid.eq(uid)),
        )
        .select(group_membership::uid)
        .for_key_share()
        .first::<i32>(conn)
        .optional()?;

    if member.is_none() {
        return Err(AppError::Forbidden("Not a member of this chat"));
    }
    Ok(())
}

pub(super) struct ForwardSources {
    pub selected: Vec<Message>,
    pub external_replies: Vec<Message>,
}

pub(super) fn load_forward_sources(
    conn: &mut PgConnection,
    uid: i32,
    chat_id: i64,
    ids: &[i64],
) -> Result<ForwardSources, AppError> {
    check_source_membership(conn, chat_id, uid)?;
    load_locked_forward_sources(conn, uid, chat_id, ids)
}

/// Caller has established chat access and canonicalized the selected IDs.
pub(super) fn load_locked_forward_sources(
    conn: &mut PgConnection,
    uid: i32,
    chat_id: i64,
    ids: &[i64],
) -> Result<ForwardSources, AppError> {
    let query = messages::table
        .filter(dsl::chat_id.eq(chat_id))
        .filter(dsl::deleted_at.is_null())
        .order(dsl::id.asc())
        .select(Message::as_select());
    let own_pending_audio = dsl::sender_uid
        .eq(uid)
        .and(dsl::message_type.eq(MessageType::Audio))
        .and(dsl::transcode_status.eq_any([TranscodeStatus::None, TranscodeStatus::Pending]));
    let selected = dsl::id
        .eq_any(ids)
        .and(dsl::is_published.eq(true).or(own_pending_audio));
    if ids.len() == 1 {
        return Ok(ForwardSources {
            selected: query.filter(selected).for_key_share().load(conn)?,
            external_replies: Vec::new(),
        });
    }

    // Reply links are fixed at insert. Discover their IDs without locking, then lock
    // sources and quotes together in the same ID order as bulk recall.
    let source = diesel::alias!(crate::schema::messages as source);
    let reply_ids = source
        .filter(source.field(dsl::chat_id).eq(chat_id))
        .filter(source.field(dsl::id).eq_any(ids))
        .filter(source.field(dsl::reply_to_id).is_not_null())
        .select(source.field(dsl::reply_to_id).assume_not_null());
    let quoted = dsl::id
        .eq_any(diesel::dsl::array(reply_ids))
        .and(dsl::is_published.eq(true));
    let rows = query
        .filter(selected.or(quoted))
        .for_key_share()
        .load::<Message>(conn)?;
    let (selected, external_replies) = rows
        .into_iter()
        .partition(|row| ids.binary_search(&row.id).is_ok());
    Ok(ForwardSources {
        selected,
        external_replies,
    })
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
    target: &ForwardTarget,
    chat_kind: GroupKind,
    sender_uid: i32,
    bundle_id: i64,
    preview: ForwardedMessagesPreviewSnapshot,
) -> PreparedMessageSend {
    PreparedMessageSend {
        system_kind: None,
        forwarded_from_message_id: None,
        chat_id: target.chat_id,
        chat_kind,
        sender_uid,
        message: Some(forwarded_wrapper_text(preview.total)),
        metadata: None,
        message_type: MessageType::Forwarded,
        sticker_id: None,
        reply_to_id: None,
        reply_root_id: target.thread_id,
        client_generated_id: target.client_generated_id.clone(),
        attachments: Default::default(),
        publish_immediately: true,
        forwarded_bundle_id: Some(bundle_id),
        forwarded_preview: Some(preview),
        forward_origin: None,
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
    if body.message_ids.len() < 2 {
        return Err(AppError::BadRequest(
            "Select at least two messages to forward",
        ));
    }
    let canonical_message_ids = canonical_forward_message_ids(body.message_ids.clone())?;
    acquire_forward_retry_lock(conn, &body.client_generated_id)?;

    let existing = messages::table
        .filter(dsl::client_generated_id.eq(&body.client_generated_id))
        .for_update()
        .select(Message::as_select())
        .first::<Message>(conn)
        .optional()?;

    let target = ForwardTarget {
        chat_id: destination_chat_id,
        thread_id: body.thread_id,
        client_generated_id: body.client_generated_id.clone(),
    };
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
        let preview = serde_json::from_value(bundle.preview.clone())
            .map_err(|_| AppError::Internal("Invalid forwarded preview"))?;
        let (message_count, items) = deserialize_forwarded_bundle_payload(bundle)?;
        if !forwarded_payload_matches_selection(&items, body.source_chat_id, &canonical_message_ids)
        {
            return Err(AppError::Conflict(MESSAGE_ID_CONFLICT));
        }

        return Ok(prepared_forward_message(
            &target,
            destination_kind,
            uid,
            bundle_id,
            ForwardedMessagesPreviewSnapshot {
                total: message_count,
                contains_forwarded_messages,
                messages: preview,
            },
        ));
    }

    let source_messages =
        load_forward_sources(conn, uid, body.source_chat_id, &canonical_message_ids)?;
    if source_messages.selected.len() != canonical_message_ids.len() {
        return Err(AppError::BadRequest("Invalid message IDs"));
    }
    let (prepared, bundle) = capture_forward_message(
        conn,
        id_gen,
        &target,
        destination_kind,
        uid,
        source_messages,
        |_, _| body.allow_placeholders,
    )
    .await?;
    diesel::insert_into(forwarded_bundles::table)
        .values(&bundle)
        .execute(conn)?;
    Ok(prepared)
}

/// Capture a bundle from authorized sources for the caller to publish.
pub(super) async fn capture_forward_message(
    conn: &mut PgConnection,
    id_gen: &IdGen,
    target: &ForwardTarget,
    destination_kind: GroupKind,
    uid: i32,
    source_messages: ForwardSources,
    permits: impl Fn(i64, ForwardPlaceholder) -> bool,
) -> Result<(PreparedMessageSend, NewForwardedBundle), AppError> {
    let items = capture_forwarded_bundle_items(conn, source_messages, permits)?;
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

    let bundle = NewForwardedBundle {
        id: bundle_id,
        created_by_uid: uid,
        created_at: Utc::now(),
        item_count: message_count as i32,
        payload,
        child_bundle_ids,
        preview,
    };

    Ok((
        prepared_forward_message(
            target,
            destination_kind,
            uid,
            bundle_id,
            ForwardedMessagesPreviewSnapshot {
                total: message_count,
                contains_forwarded_messages,
                messages: preview_items,
            },
        ),
        bundle,
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_forward_message_ids, direct_child_bundle_ids, forwarded_payload_matches_selection,
    };
    use crate::{
        dto::messages::{
            ForwardedBundlePayloadItem, ForwardedBundleRefSnapshot, ForwardedMessageSnapshot,
            ForwardedMessagesPreviewSnapshot,
        },
        models::{GroupKind, MessageType},
    };
    use chrono::Utc;

    fn snapshot_item(
        original_message_id: i64,
        original_chat_id: i64,
    ) -> ForwardedBundlePayloadItem {
        ForwardedBundlePayloadItem::MessageSnapshot {
            snapshot: ForwardedMessageSnapshot {
                forwarded_thread_reply_count: None,
                original_message_id,
                original_chat_id,
                message: Some(format!("message {original_message_id}")),
                message_type: MessageType::Text,
                sender_uid: 7,
                original_created_at: Utc::now(),
                sticker: None,
                reply: None,
                attachments: Vec::new(),
                metadata: None,
                mention_uids: Vec::new(),
            },
        }
    }

    #[test]
    fn forward_selection_accepts_one_to_one_hundred_distinct_messages() {
        for ids in [vec![], vec![10, 20, 10], (1..=101).collect()] {
            assert!(matches!(
                canonical_forward_message_ids(ids),
                Err(crate::errors::AppError::BadRequest(_))
            ));
        }
        assert_eq!(
            canonical_forward_message_ids(vec![20, 10]).unwrap(),
            vec![10, 20]
        );
        let maximum: Vec<i64> = (1..=100).collect();
        assert_eq!(
            canonical_forward_message_ids(maximum.clone()).unwrap(),
            maximum
        );
    }

    #[test]
    fn forward_retry_requires_exact_stored_source_and_selection() {
        let items = vec![snapshot_item(10, 42), snapshot_item(20, 42)];

        assert!(forwarded_payload_matches_selection(&items, 42, &[10, 20]));
        assert!(!forwarded_payload_matches_selection(&items, 42, &[10, 21]));
        assert!(!forwarded_payload_matches_selection(&items, 43, &[10, 20]));
    }

    #[test]
    fn child_bundle_ids_are_derived_from_payload_references() {
        let bundle_ref = ForwardedBundleRefSnapshot {
            forwarded_thread_reply_count: None,
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

    #[tokio::test]
    async fn database_merged_forward_preserves_thread_and_rejects_retry_target_changes() {
        use super::prepare_forward_message;
        use crate::{
            dto::messages::ForwardMessagesBody,
            errors::AppError,
            schema::{forwarded_bundles, messages},
            utils::ids,
        };
        use diesel::{connection::SimpleConnection, prelude::*};

        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).expect("connect to test database");
        conn.batch_execute(
            "BEGIN;
             INSERT INTO groups(id, name) VALUES (-76300, 'merged-source'), (-76310, 'merged-destination');
             INSERT INTO group_membership(chat_id, uid) VALUES (-76300, 76300), (-76310, 76300);
             INSERT INTO messages(id, chat_id, sender_uid, message_type, message, client_generated_id, created_at)
             VALUES (-76301, -76300, 76301, 'text', 'first', 'merged-thread-first', NOW()),
                    (-76302, -76300, 76301, 'text', 'second', 'merged-thread-second', NOW()),
                    (-76311, -76310, 76301, 'text', 'root', 'merged-thread-root', NOW()),
                    (-76312, -76310, 76301, 'text', 'other root', 'merged-thread-other-root', NOW());",
        ).unwrap();
        let id_gen = ids::new_generator(0);
        for (message_id, thread_id) in [(-76313, None), (-76314, Some(-76311))] {
            let mut body = ForwardMessagesBody {
                allow_placeholders: false,
                source_chat_id: -76300,
                message_ids: vec![-76301, -76302],
                client_generated_id: format!("merged-thread-copy-{message_id}"),
                thread_id,
            };
            let prepared =
                prepare_forward_message(&mut conn, &id_gen, 76300, -76310, GroupKind::Group, &body)
                    .await
                    .unwrap();
            assert_eq!(prepared.reply_root_id, thread_id);
            assert_eq!(
                prepared
                    .forwarded_preview
                    .as_ref()
                    .map(|preview| preview.total),
                Some(2)
            );
            diesel::insert_into(messages::table)
                .values((
                    messages::id.eq(message_id),
                    messages::chat_id.eq(prepared.chat_id),
                    messages::sender_uid.eq(prepared.sender_uid),
                    messages::message.eq(&prepared.message),
                    messages::message_type.eq(&prepared.message_type),
                    messages::client_generated_id.eq(&prepared.client_generated_id),
                    messages::created_at.eq(Utc::now()),
                    messages::reply_root_id.eq(prepared.reply_root_id),
                    messages::forwarded_bundle_id.eq(prepared.forwarded_bundle_id),
                ))
                .execute(&mut conn)
                .unwrap();
            let bundle_count = forwarded_bundles::table
                .count()
                .get_result::<i64>(&mut conn)
                .unwrap();
            body.message_ids.reverse();
            if thread_id.is_some() {
                // Lost-response retries keep working after source access is lost.
                conn.batch_execute(
                    "UPDATE messages SET deleted_at=NOW() WHERE chat_id=-76300;
                     DELETE FROM group_membership WHERE chat_id=-76300;",
                )
                .unwrap();
            }
            let retry =
                prepare_forward_message(&mut conn, &id_gen, 76300, -76310, GroupKind::Group, &body)
                    .await
                    .unwrap();
            assert_eq!(retry.reply_root_id, thread_id);
            assert_eq!(retry.forwarded_bundle_id, prepared.forwarded_bundle_id);
            for other_thread in [None, Some(-76311), Some(-76312)] {
                if other_thread == thread_id {
                    continue;
                }
                body.thread_id = other_thread;
                assert!(matches!(
                    prepare_forward_message(
                        &mut conn,
                        &id_gen,
                        76300,
                        -76310,
                        GroupKind::Group,
                        &body
                    )
                    .await,
                    Err(AppError::Conflict(_))
                ));
            }
            assert_eq!(
                forwarded_bundles::table
                    .count()
                    .get_result::<i64>(&mut conn)
                    .unwrap(),
                bundle_count
            );
        }
        conn.batch_execute("ROLLBACK").unwrap();
    }
}
