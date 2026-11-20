use std::sync::Arc;

use diesel::{connection::SimpleConnection, prelude::*, r2d2::ConnectionManager};
use uuid::Uuid;

use super::{Advance, ReplayService};
use crate::{
    config::{AppConfig, ConfigFile},
    dto::message_sync::{MessageSyncChange as Change, MessageSyncResetReason as ResetReason},
    dto::messages::ListMessagesQuery,
    metrics::Metrics,
    services::{api::chats::messages::get_messages, avatars::AvatarService},
    state::DbPool,
};

const CHAT: i64 = 9_876_750_000;
const AUTHOR: i32 = 4_000_305;
const VIEWER: i32 = 4_000_306;

async fn service() -> Option<ReplayService> {
    let url = std::env::var("WETTY_TEST_DATABASE_URL").ok()?;
    let config = AppConfig::from_env(ConfigFile::from_env());
    let media = crate::build_media_store(&config).await;
    let avatars = Arc::new(AvatarService::new(None, Metrics::new().avatars.clone()));
    let pool = DbPool::builder()
        .max_size(1)
        .build(ConnectionManager::new(url))
        .unwrap();
    Some(ReplayService::new(
        pool,
        media,
        avatars,
        &config.auth.jwt_signing_key,
    ))
}

fn expect_reset(result: Advance, expected: ResetReason) -> String {
    match result {
        Advance::Reset { cursor, reason } => {
            assert_eq!(reason, expected);
            cursor
        }
        other => panic!("expected {expected:?}, got {other:?}"),
    }
}

fn setup(conn: &mut PgConnection) -> QueryResult<()> {
    conn.batch_execute("INSERT INTO groups (id, name, membership_message_visibility)
        VALUES (9876750000, 'sync replay', 'nobody');
        INSERT INTO group_membership (chat_id, uid) VALUES (9876750000, 4000305), (9876750000, 4000306);")
}

// Replay uses a rollback-only fixture; flush at the boundaries where a
// production writer would commit.
fn flush(conn: &mut PgConnection) -> QueryResult<()> {
    conn.batch_execute(
        "SET CONSTRAINTS message_sync_flush IMMEDIATE;
                        SET CONSTRAINTS message_sync_flush DEFERRED;",
    )
}

#[tokio::test]
async fn replay_coalesces_changes_and_projects_each_viewer_like_history() {
    let Some(service) = service().await else {
        return;
    };
    assert!(matches!(
        service
            .advance(AUTHOR, -9876750000, Some("bad".into()))
            .await
            .unwrap(),
        Advance::Revoked
    ));
    let mut conn = service.pool.get().unwrap();
    conn.test_transaction::<_, crate::errors::AppError, _>(|conn| {
        setup(conn)?;
        conn.batch_execute("INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at, message, has_reactions)
            VALUES (9876750002, 'text', 'sync-replay-edit', 4000305, 9876750000, now(), 'before', true);
            INSERT INTO message_reactions (message_id, user_uid, emoji, message_author_uid)
            VALUES (9876750002, 4000305, '👍', 4000305);")?;
        flush(conn)?;
        let author_at = expect_reset(service.advance_in_snapshot(conn, AUTHOR, CHAT, None)?, ResetReason::NoBaseline);
        let viewer_at = expect_reset(service.advance_in_snapshot(conn, VIEWER, CHAT, None)?, ResetReason::NoBaseline);
        conn.batch_execute("INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at, message)
            VALUES (9876750001, 'text', 'sync-replay-deleted', 4000305, 9876750000, now(), 'gone');
            UPDATE messages SET deleted_at = now() WHERE id = 9876750001;
            UPDATE messages SET message = 'middle' WHERE id = 9876750002;
            UPDATE messages SET message = 'final' WHERE id = 9876750002;")?;
        flush(conn)?;
        for (uid, from, reacted) in [(AUTHOR, author_at, true), (VIEWER, viewer_at, false)] {
            let Advance::Batch { changes, .. } = service.advance_in_snapshot(conn, uid, CHAT, Some(&from))? else {
                panic!("expected replay batch");
            };
            assert_eq!(changes.len(), 2);
            assert!(changes.iter().any(|change| matches!(change, Change::Delete { message_id, thread_root_id: None } if *message_id == CHAT + 1)));
            let Some(Change::Upsert { appeared, message }) = changes.iter().find(|change| matches!(change, Change::Upsert { .. })) else {
                panic!("expected final edit");
            };
            assert!(!appeared);
            assert_eq!(message.message.as_deref(), Some("final"));
            let page = futures::executor::block_on(get_messages(uid, CHAT, ListMessagesQuery {
                before: None, around: None, after: None, max: None, thread_id: None,
            }, conn, &service.media, &service.avatars))?;
            assert_eq!(page.messages.len(), 1);
            assert_eq!(message.reactions[0].reacted_by_me.unwrap_or(false), reacted);
            assert_eq!(serde_json::to_value(message).unwrap(), serde_json::to_value(&page.messages[0]).unwrap());
        }
        let at = expect_reset(service.advance_in_snapshot(conn, VIEWER, CHAT, None)?, ResetReason::NoBaseline);
        conn.batch_execute("INSERT INTO messages (id, message_type, system_kind, client_generated_id, sender_uid, chat_id, created_at)
            VALUES (9876750003, 'system', 'member_joined', 'sync-replay-hidden', 4000305, 9876750000, now());")?;
        flush(conn)?;
        let Advance::Batch { to, changes } = service.advance_in_snapshot(conn, VIEWER, CHAT, Some(&at))? else { panic!("expected checkpoint advance for hidden message"); };
        assert!(changes.is_empty());
        assert!(matches!(service.advance_in_snapshot(conn, VIEWER, CHAT, Some(&to))?, Advance::Unchanged));

        conn.batch_execute("INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at, message)
            VALUES (9876750004, 'text', 'sync-replay-shell', 4000305, 9876750000, now(), 'redact this');
            INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at, reply_root_id)
            VALUES (9876750005, 'text', 'sync-replay-shell-reply', 4000305, 9876750000, now(), 9876750004);
            UPDATE messages SET deleted_at = now(), has_thread = true WHERE id = 9876750004;")?;
        flush(conn)?;
        let Advance::Batch { changes, .. } = service.advance_in_snapshot(conn, VIEWER, CHAT, Some(&to))? else {
            panic!("expected the new thread shell and reply");
        };
        assert!(changes.iter().any(|change| matches!(change,
            Change::Upsert { appeared: true, message } if message.id == CHAT + 4
                && message.is_deleted && message.message.is_none() && message.attachments.is_empty())));
        Ok(())
    });
}

#[tokio::test]
async fn replay_distinguishes_cursor_fences_and_retention_boundaries() {
    let Some(service) = service().await else {
        return;
    };
    let mut conn = service.pool.get().unwrap();
    conn.test_transaction::<_, crate::errors::AppError, _>(|conn| {
        setup(conn)?;
        let cursor = expect_reset(service.advance_in_snapshot(conn, VIEWER, CHAT, None)?, ResetReason::NoBaseline);
        let mut tampered = cursor.clone().into_bytes();
        let last = tampered.last_mut().unwrap();
        *last = if *last == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(tampered).unwrap();
        assert_eq!(expect_reset(service.advance_in_snapshot(conn, VIEWER, CHAT, Some(&tampered))?, ResetReason::InvalidCursor), cursor);
        let mut position = service.key.decode(&cursor).unwrap();
        position.h = 1;
        expect_reset(service.advance_in_snapshot(conn, VIEWER, CHAT, Some(&service.key.encode(&position)))?, ResetReason::InvalidCursor);
        position.e = Uuid::new_v4();
        position.c = CHAT + 1;
        expect_reset(service.advance_in_snapshot(conn, VIEWER, CHAT, Some(&service.key.encode(&position)))?, ResetReason::EpochChanged);
        let other_key = super::cursor::CursorKey::new(b"rotated jwt signing key");
        assert!(other_key.decode(&cursor).is_none());

        conn.batch_execute("DELETE FROM group_membership WHERE chat_id = 9876750000 AND uid = 4000306;")?;
        assert!(matches!(service.advance_in_snapshot(conn, VIEWER, CHAT, Some(&tampered))?, Advance::Revoked));
        conn.batch_execute("INSERT INTO group_membership (chat_id, uid, joined_at) VALUES (9876750000, 4000306, now() + interval '1 second');")?;
        let rejoined = expect_reset(service.advance_in_snapshot(conn, VIEWER, CHAT, Some(&cursor))?, ResetReason::VisibilityChanged);
        conn.batch_execute("INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at)
            SELECT 9876750000 + id, 'text', 'sync-replay-limit-' || id, 4000305, 9876750000, now() FROM generate_series(1, 1025) id;")?;
        flush(conn)?;
        let at_first = expect_reset(service.advance_in_snapshot(conn, VIEWER, CHAT, Some(&rejoined))?, ResetReason::TooLarge);
        conn.batch_execute("UPDATE message_sync_change SET recorded_at = now() - interval '4 days' WHERE chat_id = 9876750000;")?;
        super::prune::prune_chat(conn, CHAT, chrono::Utc::now() - chrono::TimeDelta::days(3))?;
        assert!(matches!(service.advance_in_snapshot(conn, VIEWER, CHAT, Some(&at_first))?, Advance::Unchanged));
        expect_reset(service.advance_in_snapshot(conn, VIEWER, CHAT, Some(&rejoined))?, ResetReason::Expired);
        conn.batch_execute("UPDATE message_sync_head SET head = head + 1025 WHERE chat_id = 9876750000;")?;
        expect_reset(service.advance_in_snapshot(conn, VIEWER, CHAT, Some(&at_first))?, ResetReason::TooLarge);
        Ok(())
    });
}
