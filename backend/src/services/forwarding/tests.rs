use super::{
    canonical_forward_message_ids, direct_child_bundle_ids, forwarded_payload_matches_selection,
    validate_forwardable_source,
};
use crate::{
    dto::messages::{
        ForwardedBundlePayloadItem, ForwardedBundleRefSnapshot, ForwardedMessageSnapshot,
        ForwardedMessagesPreviewSnapshot,
    },
    models::{GroupKind, MessageType, TranscodeStatus},
};
use chrono::Utc;

fn snapshot_item(original_message_id: i64, original_chat_id: i64) -> ForwardedBundlePayloadItem {
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
            metadata: None,
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
fn forward_selection_requires_two_to_one_hundred_distinct_messages() {
    for ids in [vec![], vec![10], vec![10, 10], (1..=101).collect()] {
        assert!(matches!(
            canonical_forward_message_ids(&ids),
            Err(crate::errors::AppError::BadRequest(_))
        ));
    }
    assert_eq!(
        canonical_forward_message_ids(&[20, 10]).unwrap(),
        vec![10, 20]
    );
    let maximum: Vec<i64> = (1..=100).collect();
    assert_eq!(canonical_forward_message_ids(&maximum).unwrap(), maximum);
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
    assert!(validate_forwardable_source(&MessageType::System, TranscodeStatus::None).is_err());
    assert!(validate_forwardable_source(&MessageType::Invite, TranscodeStatus::None).is_err());
}

#[test]
fn rejects_audio_whose_storage_object_may_still_be_replaced() {
    for status in [TranscodeStatus::None, TranscodeStatus::Pending] {
        assert!(matches!(
            validate_forwardable_source(&MessageType::Audio, status),
            Err(crate::errors::AppError::BadRequest(
                "Audio messages cannot be forwarded until transcoding finishes"
            ))
        ));
    }
}

#[test]
fn allows_audio_with_a_final_transcode_outcome() {
    for status in [TranscodeStatus::Done, TranscodeStatus::Failed] {
        assert!(validate_forwardable_source(&MessageType::Audio, status).is_ok());
    }
}

#[test]
fn non_audio_sources_do_not_require_transcoding() {
    for message_type in [
        MessageType::Text,
        MessageType::File,
        MessageType::Sticker,
        MessageType::Forwarded,
    ] {
        assert!(validate_forwardable_source(&message_type, TranscodeStatus::None).is_ok());
    }
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
        assert_eq!(prepared.forwarded_preview_total, Some(2));
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
                prepare_forward_message(&mut conn, &id_gen, 76300, -76310, GroupKind::Group, &body)
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
