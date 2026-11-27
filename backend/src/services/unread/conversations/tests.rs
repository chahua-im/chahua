use super::*;
use crate::dto::conversations::ConversationSelector;

fn view(
    key: &str,
    categories: Vec<ConversationCategory>,
    include: Vec<ConversationRef>,
    exclude: Vec<ConversationRef>,
) -> ConversationView {
    ConversationView {
        key: key.into(),
        selector: ConversationSelector {
            categories,
            include,
            exclude,
            archived: false,
        },
    }
}

#[test]
fn validates_bounded_unique_views_and_snowflake_references() {
    let scope = ConversationRef {
        chat_id: 9007199254740993,
        thread_id: Some(9007199254740995),
    };
    let json = serde_json::to_value(scope).unwrap();
    assert_eq!(json["chatId"], "9007199254740993");
    assert_eq!(
        serde_json::from_value::<ConversationRef>(json).unwrap(),
        scope
    );
    let valid = view("custom", vec![], vec![scope], vec![]);
    assert!(validate_conversation_views(std::slice::from_ref(&valid)).is_ok());
    assert!(validate_conversation_views(&[valid.clone(), valid.clone()]).is_err());
    assert!(validate_conversation_views(&vec![valid; 33]).is_err());
    assert!(validate_conversation_views(&[view("", vec![], vec![], vec![])]).is_err());
    assert!(validate_conversation_views(&[view(
        "bad",
        vec![],
        vec![ConversationRef {
            chat_id: -1,
            thread_id: None
        }],
        vec![]
    )])
    .is_err());
}

#[test]
fn overlaps_are_sets_exclusions_win_and_archives_do_not_leak() {
    let main = ConversationRef {
        chat_id: 1,
        thread_id: None,
    };
    let thread = ConversationRef {
        chat_id: 1,
        thread_id: Some(10),
    };
    let views = [
        view(
            "mixed",
            vec![ConversationCategory::Group],
            vec![main, main, thread],
            vec![],
        ),
        view(
            "excluded",
            vec![ConversationCategory::Group],
            vec![main, thread],
            vec![main],
        ),
        view("main-only", vec![], vec![main], vec![]),
    ];
    let selections = views.iter().map(Selection::new).collect::<Vec<_>>();
    let scopes = vec![
        Scope {
            membership_allowed: true,
            chat_id: 1,
            thread_id: None,
            is_dm: false,
            archived: false,
            muted: false,
            last_read_message_id: None,
        },
        Scope {
            membership_allowed: true,
            chat_id: 1,
            thread_id: Some(10),
            is_dm: false,
            archived: false,
            muted: false,
            last_read_message_id: None,
        },
        Scope {
            membership_allowed: true,
            chat_id: 2,
            thread_id: None,
            is_dm: false,
            archived: true,
            muted: false,
            last_read_message_id: None,
        },
    ];
    let counts = aggregate(
        &selections,
        &scopes,
        &HashMap::from([(1, 900), (2, 1)]),
        &HashMap::from([(10, 900)]),
        &HashMap::from([((false, 1), 1), ((true, 10), 2)]),
    );
    assert_eq!(
        (
            counts[0].unread_message_count,
            counts[0].unread_conversation_count,
            counts[0].unread_attention_count
        ),
        (1000, 2, 3)
    );
    assert_eq!(
        (
            counts[1].unread_message_count,
            counts[1].unread_conversation_count
        ),
        (900, 1)
    );
    assert_eq!(
        (
            counts[2].unread_message_count,
            counts[2].unread_attention_count
        ),
        (900, 1)
    );
}

#[test]
fn muted_scopes_preserve_totals_and_cap_unmuted_counts_independently() {
    let views = [view(
        "groups",
        vec![ConversationCategory::Group],
        vec![],
        vec![],
    )];
    let selections = views.iter().map(Selection::new).collect::<Vec<_>>();
    let mut scopes = (1..=4)
        .map(|chat_id| Scope {
            membership_allowed: true,
            chat_id,
            thread_id: None,
            is_dm: false,
            archived: false,
            muted: true,
            last_read_message_id: None,
        })
        .collect::<Vec<_>>();
    let main = HashMap::from([(1, 1000), (2, 700), (3, 700)]);
    let attention = HashMap::from([((false, 1), 1000), ((false, 2), 700), ((false, 3), 700)]);
    for (unmuted_scopes, expected) in [(0, 0), (1, 700), (2, 1000)] {
        for (index, scope) in scopes.iter_mut().enumerate().skip(1) {
            scope.muted = index > unmuted_scopes;
        }
        // An unmuted conversation without unread messages contributes no count.
        scopes[3].muted = false;
        let results = aggregate(&selections, &scopes, &main, &HashMap::new(), &attention);
        let summary = &results[0];
        assert_eq!(summary.unread_message_count, 1000);
        assert_eq!(summary.unread_conversation_count, 3);
        assert_eq!(summary.unread_attention_count, 1000);
        assert_eq!(summary.unread_unmuted_attention_count, expected);
        assert_eq!(summary.unread_unmuted_message_count, expected);
        assert_eq!(
            summary.unread_unmuted_conversation_count,
            unmuted_scopes as i64
        );
        let json = serde_json::to_value(summary).unwrap();
        assert_eq!(json["unreadUnmutedAttentionCount"], expected);
        assert_eq!(json["unreadUnmutedMessageCount"], expected);
        assert_eq!(json["unreadUnmutedConversationCount"], unmuted_scopes);
    }
}

/// Uses isolated temporary tables in a dedicated test database, never application data.
#[test]
fn database_collections_preserve_permissions_cursors_and_scope_boundaries() {
    use diesel::connection::SimpleConnection;
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        return;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    conn.batch_execute("
            CREATE TEMP TABLE user_extra (uid INTEGER PRIMARY KEY, mute_group_chats_by_default BOOLEAN, mute_direct_chats_by_default BOOLEAN, show_membership_messages BOOLEAN NOT NULL DEFAULT true, show_unread_message_count BOOLEAN NOT NULL DEFAULT false);
            INSERT INTO user_extra (uid, mute_group_chats_by_default, mute_direct_chats_by_default) VALUES (1, FALSE, FALSE);
            CREATE TEMP TABLE groups (id BIGINT PRIMARY KEY, kind TEXT NOT NULL);
            CREATE TEMP TABLE group_membership (chat_id BIGINT, uid INTEGER, archived BOOLEAN, last_read_message_id BIGINT, muted_until TIMESTAMPTZ, PRIMARY KEY(chat_id, uid));
            CREATE TEMP TABLE messages (id BIGINT PRIMARY KEY, chat_id BIGINT, reply_root_id BIGINT, has_thread BOOLEAN DEFAULT FALSE, is_published BOOLEAN DEFAULT TRUE, deleted_at TIMESTAMPTZ);
            CREATE TEMP TABLE thread_user_states (chat_id BIGINT, thread_root_id BIGINT, uid INTEGER, subscribed BOOLEAN, archived BOOLEAN, last_read_message_id BIGINT, PRIMARY KEY(chat_id, thread_root_id, uid));
            CREATE TEMP TABLE message_mentions (chat_id BIGINT, thread_root_id BIGINT, message_id BIGINT, mentioned_uid INTEGER, PRIMARY KEY(message_id, mentioned_uid));
            INSERT INTO groups VALUES (1,'group'),(2,'dm'),(3,'group'),(4,'group');
            INSERT INTO group_membership VALUES (1,1,FALSE,12,'9999-01-01'),(2,1,FALSE,20,NULL),(4,1,TRUE,0,NULL);
            ALTER TABLE group_membership ADD COLUMN mute_override BOOLEAN;
            ALTER TABLE group_membership ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
            ALTER TABLE groups ADD COLUMN membership_message_visibility TEXT NOT NULL DEFAULT 'members';
            INSERT INTO messages(id,chat_id,has_thread) VALUES (10,1,TRUE),(12,1,TRUE),(13,1,FALSE),(20,2,TRUE),(21,2,FALSE),(30,3,TRUE),(31,3,FALSE),(40,4,FALSE);
            INSERT INTO messages(id,chat_id,reply_root_id) VALUES (1001,1,10),(1002,1,10),(2001,2,20),(1201,1,12),(3001,3,30);
            INSERT INTO messages(id,chat_id,reply_root_id,is_published) VALUES (1003,1,10,FALSE);
            INSERT INTO messages(id,chat_id,reply_root_id,deleted_at) VALUES (1004,1,10,NOW());
            INSERT INTO thread_user_states VALUES (1,10,1,TRUE,FALSE,1000),(2,20,1,TRUE,FALSE,2000),(1,12,1,FALSE,FALSE,0),(3,30,1,TRUE,FALSE,0);
            INSERT INTO message_mentions VALUES (1,NULL,13,1),(1,10,1001,1),(1,10,1002,2),(2,NULL,21,1),(2,20,2001,1);
        ").unwrap();
    let all = vec![
        ConversationCategory::Group,
        ConversationCategory::Dm,
        ConversationCategory::GroupThread,
        ConversationCategory::DmThread,
    ];
    let views = vec![
        view("all", all.clone(), vec![], vec![]),
        view("friends", vec![ConversationCategory::Dm], vec![], vec![]),
        view(
            "threads",
            vec![
                ConversationCategory::GroupThread,
                ConversationCategory::DmThread,
            ],
            vec![],
            vec![],
        ),
        view(
            "unauthorized",
            vec![],
            vec![
                ConversationRef {
                    chat_id: 3,
                    thread_id: None,
                },
                ConversationRef {
                    chat_id: 3,
                    thread_id: Some(30),
                },
                ConversationRef {
                    chat_id: 1,
                    thread_id: Some(12),
                },
                ConversationRef {
                    chat_id: 2,
                    thread_id: Some(10),
                },
            ],
            vec![],
        ),
        ConversationView {
            key: "archived".into(),
            selector: ConversationSelector {
                categories: all,
                archived: true,
                ..Default::default()
            },
        },
    ];
    let service = UnreadService::new();
    let result = service
        .conversation_summaries(&mut conn, 1, &views)
        .unwrap();
    let (combined, badge, main_unread) = service
        .conversation_summaries_and_badge(&mut conn, 1, &views, true)
        .unwrap();
    // The all-view also includes threads and muted conversations; neither
    // may be summed into the main-only, unmuted application badge.
    assert_eq!(badge, Some(1));
    let expected_main = Some(MainUnread {
        show_unread_message_count: false,
        chats: vec![MainUnreadChat {
            chat_id: 2,
            unread_count: 1,
        }],
    });
    assert_eq!(main_unread, expected_main);
    // Even an empty view list must return the complete eligible main-chat set.
    let (empty_views, badge, main_unread) = service
        .conversation_summaries_and_badge(&mut conn, 1, &[], true)
        .unwrap();
    assert!(empty_views.is_empty());
    assert_eq!(badge, Some(1));
    assert_eq!(main_unread, expected_main);
    let (_, badge, main_unread) = service
        .conversation_summaries_and_badge(&mut conn, 1, &views, false)
        .unwrap();
    assert_eq!(badge, None);
    assert_eq!(main_unread, None);
    conn.batch_execute("UPDATE user_extra SET mute_direct_chats_by_default=TRUE WHERE uid=1")
        .unwrap();
    let (_, badge, main_unread) = service
        .conversation_summaries_and_badge(&mut conn, 1, &[], true)
        .unwrap();
    assert_eq!(badge, Some(0));
    assert_eq!(
        main_unread,
        Some(MainUnread {
            show_unread_message_count: false,
            chats: vec![]
        })
    );
    conn.batch_execute("UPDATE group_membership SET mute_override=FALSE WHERE chat_id=2")
        .unwrap();
    let (_, _, main_unread) = service
        .conversation_summaries_and_badge(&mut conn, 1, &[], true)
        .unwrap();
    assert_eq!(main_unread, expected_main);
    conn.batch_execute("UPDATE user_extra SET mute_direct_chats_by_default=FALSE WHERE uid=1; UPDATE group_membership SET mute_override=NULL WHERE chat_id=2")
            .unwrap();
    assert_eq!(
        combined
            .iter()
            .map(|s| s.unread_message_count)
            .collect::<Vec<_>>(),
        result
            .iter()
            .map(|s| s.unread_message_count)
            .collect::<Vec<_>>()
    );
    let totals = result
        .iter()
        .map(|s| {
            (
                s.unread_message_count,
                s.unread_conversation_count,
                s.unread_attention_count,
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        totals,
        vec![(5, 4, 2), (1, 1, 0), (3, 2, 1), (0, 0, 0), (1, 1, 0)]
    );
    assert_eq!(
        result
            .iter()
            .map(|s| (
                s.unread_unmuted_message_count,
                s.unread_unmuted_conversation_count
            ))
            .collect::<Vec<_>>(),
        vec![(4, 3), (1, 1), (3, 2), (0, 0), (1, 1)]
    );
    // A muted parent suppresses its own attention, but not its active thread.
    assert_eq!(
        result
            .iter()
            .map(|s| s.unread_unmuted_attention_count)
            .collect::<Vec<_>>(),
        vec![1, 0, 1, 0, 0]
    );
    // Expired and absent mute times both restore attention without changing read state.
    for mute_time in ["'2000-01-01'", "NULL"] {
        conn.batch_execute(&format!(
            "UPDATE group_membership SET muted_until={mute_time} WHERE chat_id=1"
        ))
        .unwrap();
        let refreshed = service
            .conversation_summaries(&mut conn, 1, &views)
            .unwrap();
        assert_eq!(refreshed[0].unread_unmuted_attention_count, 2);
        assert_eq!(refreshed[0].unread_attention_count, 2);
        assert_eq!(refreshed[0].unread_message_count, 5);
        assert_eq!(refreshed[0].unread_unmuted_message_count, 5);
        assert_eq!(refreshed[0].unread_unmuted_conversation_count, 4);
        let (_, badge, main_unread) = service
            .conversation_summaries_and_badge(&mut conn, 1, &[], true)
            .unwrap();
        assert_eq!(badge, Some(2));
        assert_eq!(
            main_unread,
            Some(MainUnread {
                show_unread_message_count: false,
                chats: vec![
                    MainUnreadChat {
                        chat_id: 1,
                        unread_count: 1
                    },
                    MainUnreadChat {
                        chat_id: 2,
                        unread_count: 1
                    },
                ],
            })
        );
    }
    // Archived threads keep raw attention, but never add unmuted attention.
    conn.batch_execute("UPDATE group_membership SET muted_until='9999-01-01' WHERE chat_id=1; UPDATE thread_user_states SET archived=TRUE WHERE thread_root_id=10").unwrap();
    let refreshed = service
        .conversation_summaries(&mut conn, 1, &views)
        .unwrap();
    assert_eq!(refreshed[0].unread_attention_count, 1);
    assert_eq!(refreshed[0].unread_unmuted_attention_count, 0);
    assert_eq!(refreshed[4].unread_attention_count, 1);
    assert_eq!(refreshed[4].unread_unmuted_attention_count, 0);
    assert_eq!(refreshed[0].unread_unmuted_message_count, 2);
    assert_eq!(refreshed[0].unread_unmuted_conversation_count, 2);
    assert_eq!(refreshed[4].unread_unmuted_message_count, 1);
    assert_eq!(refreshed[4].unread_unmuted_conversation_count, 1);
    // Parent archive and mute state do not silence an active subscribed thread.
    conn.batch_execute("UPDATE group_membership SET archived=TRUE WHERE chat_id=1; UPDATE thread_user_states SET archived=FALSE WHERE thread_root_id=10").unwrap();
    let refreshed = service
        .conversation_summaries(&mut conn, 1, &views)
        .unwrap();
    assert_eq!(refreshed[0].unread_unmuted_attention_count, 1);
    assert_eq!(refreshed[4].unread_attention_count, 1);
    assert_eq!(refreshed[4].unread_unmuted_attention_count, 0);
    conn.batch_execute("UPDATE group_membership SET archived=FALSE WHERE chat_id=1")
        .unwrap();
    conn.batch_execute("UPDATE group_membership SET last_read_message_id=13 WHERE chat_id=1; UPDATE thread_user_states SET last_read_message_id=1002 WHERE thread_root_id=10;").unwrap();
    let result = service
        .conversation_summaries(&mut conn, 1, &views)
        .unwrap();
    assert_eq!(
        (
            result[0].unread_message_count,
            result[0].unread_attention_count
        ),
        (2, 0)
    );
    assert_eq!(result[0].unread_unmuted_attention_count, 0);
    assert_eq!(result[0].unread_unmuted_message_count, 2);
    assert_eq!(result[0].unread_unmuted_conversation_count, 2);
    // Preference changes affect only the group main scope, not its threads or DMs.
    conn.batch_execute("ALTER TABLE messages ADD COLUMN system_kind TEXT;
            INSERT INTO messages(id,chat_id,reply_root_id,system_kind) VALUES
                (14,1,NULL,'member_joined'), (1005,1,10,'member_joined'), (22,2,NULL,'member_joined');").unwrap();
    assert_eq!(
        service
            .conversation_summaries(&mut conn, 1, &views)
            .unwrap()[0]
            .unread_message_count,
        5
    );
    conn.batch_execute("UPDATE user_extra SET show_membership_messages=FALSE WHERE uid=1")
        .unwrap();
    assert_eq!(
        service
            .conversation_summaries(&mut conn, 1, &views)
            .unwrap()[0]
            .unread_message_count,
        4
    );
    conn.batch_execute("DELETE FROM messages WHERE id IN (14,1005,22)")
        .unwrap();
    conn.batch_execute("DELETE FROM group_membership WHERE chat_id=2")
        .unwrap();
    let result = service
        .conversation_summaries(&mut conn, 1, &views)
        .unwrap();
    assert_eq!(
        (
            result[0].unread_message_count,
            result[1].unread_message_count,
            result[2].unread_message_count
        ),
        (0, 0, 0)
    );
    assert_eq!(result[0].unread_unmuted_message_count, 0);
    assert_eq!(result[0].unread_unmuted_conversation_count, 0);
    let (_, badge, main_unread) = service
        .conversation_summaries_and_badge(&mut conn, 1, &[], true)
        .unwrap();
    assert_eq!(badge, Some(0));
    assert_eq!(
        main_unread,
        Some(MainUnread {
            show_unread_message_count: false,
            chats: vec![]
        })
    );
    // Preserve per-chat counts before capping the app badge: a back badge can
    // exclude a saturated parent without losing the other chat's unread state.
    conn.batch_execute("
            UPDATE user_extra SET show_unread_message_count=TRUE WHERE uid=1;
            UPDATE group_membership SET muted_until=NULL, last_read_message_id=13 WHERE chat_id=1;
            INSERT INTO group_membership(chat_id,uid,archived,last_read_message_id,muted_until) VALUES (2,1,FALSE,20,NULL);
            INSERT INTO messages(id,chat_id) SELECT 10000+n,1 FROM generate_series(1,1200) n;
            INSERT INTO messages(id,chat_id) VALUES (20000,2);
        ").unwrap();
    let (_, badge, main_unread) = service
        .conversation_summaries_and_badge(&mut conn, 1, &[], true)
        .unwrap();
    assert_eq!(badge, Some(1000));
    assert_eq!(
        main_unread,
        Some(MainUnread {
            show_unread_message_count: true,
            chats: vec![
                MainUnreadChat {
                    chat_id: 1,
                    unread_count: 1000
                },
                MainUnreadChat {
                    chat_id: 2,
                    unread_count: 2
                },
            ],
        })
    );
    conn.batch_execute("UPDATE user_extra SET show_unread_message_count=FALSE WHERE uid=1")
        .unwrap();
    let (_, badge, main_unread) = service
        .conversation_summaries_and_badge(&mut conn, 1, &[], true)
        .unwrap();
    assert_eq!(badge, Some(2));
    assert!(!main_unread.unwrap().show_unread_message_count);
}
