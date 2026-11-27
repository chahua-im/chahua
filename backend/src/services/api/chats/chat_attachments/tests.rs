use super::{attachment_cursors, load_attachment_messages, AttachmentMessageRow};
use crate::dto::attachments::ChatAttachmentKindFilter;
use chrono::Utc;
use diesel::{connection::SimpleConnection, Connection, PgConnection};

fn row(message_id: i64) -> AttachmentMessageRow {
    AttachmentMessageRow {
        message_id,
        sender_uid: 1,
        message_created_at: Utc::now(),
    }
}

#[test]
fn attachment_pages_preserve_message_groups_and_exclude_cursor_boundaries() {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    conn.begin_test_transaction().unwrap();
    conn.batch_execute(
        "CREATE TEMP TABLE messages (
                id bigint PRIMARY KEY, chat_id bigint NOT NULL, sender_uid int NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
                is_published boolean NOT NULL DEFAULT true,
                has_attachments boolean NOT NULL DEFAULT true
             ) ON COMMIT DROP;
             CREATE TEMP TABLE attachments (
                id bigint PRIMARY KEY, message_id bigint, kind text NOT NULL,
                deleted_at timestamptz
             ) ON COMMIT DROP;
             INSERT INTO messages (id, chat_id, sender_uid)
                VALUES (10, 1, 1), (20, 1, 1), (30, 1, 1), (40, 1, 1), (50, 1, 1),
                       (60, 2, 1);
             INSERT INTO attachments (id, message_id, kind, deleted_at) VALUES
                (1, 10, 'image/jpeg', NULL),
                (2, 20, 'image/jpeg', NULL),
                (3, 20, 'image/png', NULL),
                (4, 30, 'image/jpeg', now()),
                (5, 40, 'video/mp4', NULL),
                (6, 50, 'image/jpeg', NULL),
                (7, 60, 'image/jpeg', NULL);",
    )
    .unwrap();

    for (before, after, expected_ids, expected_more) in [
        (None, None, vec![50], true),
        (Some(50), None, vec![20], true),
        (Some(20), None, vec![10], false),
        (None, Some(10), vec![20], true),
        (None, Some(20), vec![50], false),
        (None, Some(50), vec![], false),
    ] {
        let (rows, has_more) = load_attachment_messages(
            &mut conn,
            1,
            ChatAttachmentKindFilter::Image,
            1,
            before,
            after,
        )
        .unwrap();
        let ids: Vec<_> = rows.iter().map(|row| row.message_id).collect();
        assert_eq!(ids, expected_ids, "before={before:?}, after={after:?}");
        assert_eq!(
            has_more, expected_more,
            "before={before:?}, after={after:?}"
        );
    }
}

#[test]
fn cursors_for_initial_page_only_include_older_when_more_exists() {
    let rows = vec![row(30), row(20), row(10)];
    assert_eq!(
        attachment_cursors(&rows, true, None, None),
        (Some(10), None)
    );
    assert_eq!(attachment_cursors(&rows, false, None, None), (None, None));
}

#[test]
fn cursors_for_before_page_include_newer_cursor() {
    let rows = vec![row(20), row(10)];
    assert_eq!(
        attachment_cursors(&rows, false, Some(30), None),
        (None, Some(20))
    );
}

#[test]
fn cursors_for_after_page_include_older_cursor() {
    let rows = vec![row(30), row(20)];
    assert_eq!(
        attachment_cursors(&rows, false, None, Some(10)),
        (Some(20), None)
    );
    assert_eq!(
        attachment_cursors(&rows, true, None, Some(10)),
        (Some(20), Some(30))
    );
}
