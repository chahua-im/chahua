use super::*;
use crate::dto::message_sync::MessageSyncBatch;
use crate::dto::ws::ServerWsMessage;
use crate::rpc::events::encode_event;

fn delete_change(id: i64) -> Change {
    Change::Delete {
        message_id: id,
        thread_root_id: None,
    }
}

#[test]
fn pack_replay_batches_splits_across_sequences_and_chains_cursors() {
    let key = CursorKey::new(b"test-key", b"chahua.message-sync.cursor.v1");
    let base_pos = Position {
        e: Uuid::nil(),
        u: 1,
        c: 42,
        h: 0,
        f: [0; 16],
    };
    let from_cursor = key.encode(&base_pos);
    let head_pos = Position {
        h: 5,
        ..base_pos.clone()
    };

    let items = vec![
        (2, 10, delete_change(10)),
        (2, 11, delete_change(11)),
        (4, 12, delete_change(12)),
        (4, 13, delete_change(13)),
        (5, 14, delete_change(14)),
    ];

    // Compute budget that fits two delete items per batch: seq=2 in batch 1, seq=4 in batch 2, seq=5 in batch 3.
    let one_item_json = serde_json::to_vec(&delete_change(10)).unwrap().len();
    let envelope = encode_event(&ServerWsMessage::MessageSyncBatch(MessageSyncBatch {
        chat_id: 42,
        from: from_cursor.clone(),
        to: key.encode(&head_pos),
        changes: Vec::new(),
    }))
    .unwrap()
    .len();
    let max_frame = envelope + (one_item_json * 2) + 1;

    let batches = pack_replay_batches(42, &from_cursor, &head_pos, &key, items, max_frame).unwrap();
    assert_eq!(batches.len(), 3);
    assert_eq!(batches[0].changes.len(), 2);
    assert_eq!(batches[1].changes.len(), 2);
    assert_eq!(batches[2].changes.len(), 1);
    assert_eq!(batches[2].to, key.encode(&head_pos));

    let mut prev_cursor = from_cursor;
    let mut collected_ids = Vec::new();
    for batch in batches {
        let encoded = encode_event(&ServerWsMessage::MessageSyncBatch(MessageSyncBatch {
            chat_id: 42,
            from: prev_cursor,
            to: batch.to.clone(),
            changes: batch.changes.clone(),
        }))
        .unwrap();
        assert!(encoded.len() <= max_frame);
        for change in batch.changes {
            if let Change::Delete { message_id, .. } = change {
                collected_ids.push(message_id);
            }
        }
        prev_cursor = batch.to;
    }
    assert_eq!(collected_ids, vec![10, 11, 12, 13, 14]);
}

#[test]
fn pack_replay_batches_returns_too_large_for_oversized_single_sequence_group() {
    let key = CursorKey::new(b"test-key", b"chahua.message-sync.cursor.v1");
    let from_pos = Position {
        e: Uuid::nil(),
        u: 1,
        c: 42,
        h: 0,
        f: [0; 16],
    };
    let head_pos = Position {
        h: 2,
        ..from_pos.clone()
    };
    let from_cursor = key.encode(&from_pos);

    // Two items share seq=2 so they are atomic and cannot split across cursors.
    let items = vec![(2, 10, delete_change(10)), (2, 11, delete_change(11))];
    let one_item_json = serde_json::to_vec(&delete_change(10)).unwrap().len();
    let envelope = encode_event(&ServerWsMessage::MessageSyncBatch(MessageSyncBatch {
        chat_id: 42,
        from: from_cursor.clone(),
        to: key.encode(&head_pos),
        changes: Vec::new(),
    }))
    .unwrap()
    .len();
    let max_frame = envelope + one_item_json;

    assert_eq!(
        pack_replay_batches(42, &from_cursor, &head_pos, &key, items, max_frame).unwrap_err(),
        ResetReason::TooLarge
    );
}

#[test]
fn pack_replay_batches_handles_empty_changes_at_head() {
    let key = CursorKey::new(b"test-key", b"chahua.message-sync.cursor.v1");
    let from_pos = Position {
        e: Uuid::nil(),
        u: 1,
        c: 42,
        h: 0,
        f: [0; 16],
    };
    let head_pos = Position {
        h: 3,
        ..from_pos.clone()
    };
    let batches =
        pack_replay_batches(42, &key.encode(&from_pos), &head_pos, &key, vec![], 1024).unwrap();
    assert_eq!(batches.len(), 1);
    assert!(batches[0].changes.is_empty());
    assert_eq!(batches[0].to, key.encode(&head_pos));
}
