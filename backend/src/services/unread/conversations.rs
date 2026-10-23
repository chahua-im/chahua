use std::collections::{HashMap, HashSet};

use diesel::{
    prelude::*,
    sql_query,
    sql_types::{Array, BigInt, Bool, Integer, Nullable},
};

use super::{ChatUnreadMembership, UnreadService};
use crate::{
    constants::MAX_UNREAD_COUNT,
    dto::conversations::{
        ConversationCategory, ConversationRef, ConversationUnreadSummary, ConversationView,
    },
    errors::AppError,
};

pub fn validate_conversation_views(views: &[ConversationView]) -> Result<(), AppError> {
    if views.len() > 32 {
        return Err(AppError::BadRequest(
            "At most 32 conversation views are allowed",
        ));
    }
    let mut keys = HashSet::new();
    let mut refs = 0;
    for view in views {
        if view.key.is_empty() || view.key.len() > 128 || !keys.insert(&view.key) {
            return Err(AppError::BadRequest(
                "View keys must be unique and contain 1 to 128 bytes",
            ));
        }
        refs += view.selector.include.len() + view.selector.exclude.len();
        if refs > 2048 || view.selector.categories.len() > 4 {
            return Err(AppError::BadRequest("Too many conversation selectors"));
        }
        if view
            .selector
            .include
            .iter()
            .chain(&view.selector.exclude)
            .any(|scope| scope.chat_id <= 0 || scope.thread_id.is_some_and(|id| id <= 0))
        {
            return Err(AppError::BadRequest("Conversation IDs must be positive"));
        }
    }
    Ok(())
}

#[derive(QueryableByName)]
struct Scope {
    #[diesel(sql_type = BigInt)]
    chat_id: i64,
    #[diesel(sql_type = Nullable<BigInt>)]
    thread_id: Option<i64>,
    #[diesel(sql_type = Bool)]
    is_dm: bool,
    #[diesel(sql_type = Bool)]
    archived: bool,
    #[diesel(sql_type = Bool)]
    muted: bool,
    #[diesel(sql_type = Nullable<BigInt>)]
    last_read_message_id: Option<i64>,
}

impl Scope {
    fn reference(&self) -> ConversationRef {
        ConversationRef {
            chat_id: self.chat_id,
            thread_id: self.thread_id,
        }
    }

    fn category(&self) -> ConversationCategory {
        match (self.is_dm, self.thread_id.is_some()) {
            (false, false) => ConversationCategory::Group,
            (true, false) => ConversationCategory::Dm,
            (false, true) => ConversationCategory::GroupThread,
            (true, true) => ConversationCategory::DmThread,
        }
    }
}

struct Selection<'a> {
    view: &'a ConversationView,
    include: HashSet<ConversationRef>,
    exclude: HashSet<ConversationRef>,
}

impl<'a> Selection<'a> {
    fn new(view: &'a ConversationView) -> Self {
        Self {
            view,
            include: view.selector.include.iter().copied().collect(),
            exclude: view.selector.exclude.iter().copied().collect(),
        }
    }

    fn contains(&self, scope: &Scope) -> bool {
        scope.archived == self.view.selector.archived
            && !self.exclude.contains(&scope.reference())
            && (self.view.selector.categories.contains(&scope.category())
                || self.include.contains(&scope.reference()))
    }
}

#[derive(QueryableByName)]
struct Count {
    #[diesel(sql_type = BigInt)]
    id: i64,
    #[diesel(sql_type = BigInt)]
    count: i64,
}

impl UnreadService {
    pub fn conversation_summaries(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        views: &[ConversationView],
    ) -> Result<Vec<ConversationUnreadSummary>, diesel::result::Error> {
        if views.is_empty() {
            return Ok(Vec::new());
        }
        let defaults =
            crate::services::notification_preferences::load_notification_defaults(conn, uid)?;
        let selections = views.iter().map(Selection::new).collect::<Vec<_>>();
        // This UNION reads the user's indexed memberships/subscriptions and joins roots by PK.
        // It never scans message history to discover the collection or trusts caller-supplied IDs.
        // Match list-row mute semantics: main chats use notification preferences, threads use their own archive state.
        let scopes = sql_query(
            "SELECT gm.chat_id, NULL::BIGINT AS thread_id, g.kind = 'dm' AS is_dm,
                    gm.archived, (COALESCE(gm.muted_until > statement_timestamp(), FALSE)
                        OR COALESCE(gm.mute_override, CASE WHEN g.kind = 'dm' THEN $3 ELSE $2 END)) AS muted,
                    gm.last_read_message_id
             FROM group_membership gm JOIN groups g ON g.id = gm.chat_id
             WHERE gm.uid = $1
             UNION ALL
             SELECT ts.chat_id, ts.thread_root_id AS thread_id, g.kind = 'dm' AS is_dm,
                    ts.archived, ts.archived AS muted, ts.last_read_message_id
             FROM thread_user_states ts
             JOIN group_membership gm ON gm.chat_id = ts.chat_id AND gm.uid = ts.uid
             JOIN groups g ON g.id = ts.chat_id
             JOIN messages root ON root.id = ts.thread_root_id AND root.chat_id = ts.chat_id
             WHERE ts.uid = $1 AND ts.subscribed = TRUE
               AND root.reply_root_id IS NULL AND root.has_thread = TRUE AND root.is_published = TRUE"
        ).bind::<Integer, _>(uid).bind::<Bool, _>(defaults.group_chats_muted).bind::<Bool, _>(defaults.direct_chats_muted).load::<Scope>(conn)?
            .into_iter().filter(|scope| selections.iter().any(|selection| selection.contains(scope))).collect::<Vec<_>>();

        let memberships = scopes
            .iter()
            .filter(|scope| scope.thread_id.is_none())
            .map(|scope| ChatUnreadMembership {
                chat_id: scope.chat_id,
                last_read_message_id: scope.last_read_message_id,
                archived: scope.archived,
                is_muted: false, // Collection counts describe unread state, including muted conversations.
            })
            .collect::<Vec<_>>();
        let main_counts = self.count_membership_unreads(conn, &memberships)?;
        let thread_scopes = scopes
            .iter()
            .filter(|scope| scope.thread_id.is_some())
            .collect::<Vec<_>>();
        let thread_counts = if thread_scopes.is_empty() {
            HashMap::new()
        } else {
            // Parameterized LATERAL range seeks use idx_messages_thread_reply_stats
            // (reply_root_id, id DESC); LIMIT bounds work for each selected thread.
            sql_query(
                "SELECT s.thread_id AS id, counts.count
                 FROM unnest($1::BIGINT[], $2::BIGINT[]) s(thread_id, read_id)
                 CROSS JOIN LATERAL (
                     SELECT COUNT(*)::BIGINT AS count FROM (
                         SELECT 1 FROM messages m
                         WHERE m.reply_root_id = s.thread_id AND m.id > s.read_id
                           AND m.deleted_at IS NULL AND m.is_published = TRUE
                         ORDER BY m.id DESC LIMIT $3
                     ) unread
                 ) counts",
            )
            .bind::<Array<BigInt>, _>(
                thread_scopes
                    .iter()
                    .map(|s| s.thread_id.unwrap())
                    .collect::<Vec<_>>(),
            )
            .bind::<Array<BigInt>, _>(
                thread_scopes
                    .iter()
                    .map(|s| s.last_read_message_id.unwrap_or(0))
                    .collect::<Vec<_>>(),
            )
            .bind::<BigInt, _>(MAX_UNREAD_COUNT)
            .load::<Count>(conn)?
            .into_iter()
            .map(|r| (r.id, r.count))
            .collect()
        };
        let mut attention = HashMap::new();
        for is_thread in [false, true] {
            let addressed = scopes
                .iter()
                .filter(|s| !s.is_dm && s.thread_id.is_some() == is_thread)
                .collect::<Vec<_>>();
            if addressed.is_empty() {
                continue;
            }
            // Separate predicates preserve range seeks on message_mentions_unread_idx.
            // The existing PK (message_id, mentioned_uid) deduplicates mention + reply.
            let predicate = if is_thread {
                "mm.thread_root_id = s.thread_id"
            } else {
                "mm.thread_root_id IS NULL"
            };
            let query = format!(
                "SELECT s.scope_id AS id, counts.count
                 FROM unnest($1::BIGINT[], $2::BIGINT[], $3::BIGINT[], $4::BIGINT[])
                      s(scope_id, chat_id, thread_id, read_id)
                 CROSS JOIN LATERAL (
                     SELECT COUNT(*)::BIGINT AS count FROM (
                         SELECT 1 FROM message_mentions mm
                         WHERE mm.mentioned_uid = $5 AND mm.chat_id = s.chat_id
                           AND {predicate} AND mm.message_id > s.read_id
                         ORDER BY mm.thread_root_id, mm.message_id LIMIT $6
                     ) unread
                 ) counts"
            );
            let rows = sql_query(query)
                .bind::<Array<BigInt>, _>(
                    addressed
                        .iter()
                        .map(|s| s.thread_id.unwrap_or(s.chat_id))
                        .collect::<Vec<_>>(),
                )
                .bind::<Array<BigInt>, _>(addressed.iter().map(|s| s.chat_id).collect::<Vec<_>>())
                .bind::<Array<BigInt>, _>(
                    addressed
                        .iter()
                        .map(|s| s.thread_id.unwrap_or(0))
                        .collect::<Vec<_>>(),
                )
                .bind::<Array<BigInt>, _>(
                    addressed
                        .iter()
                        .map(|s| s.last_read_message_id.unwrap_or(0))
                        .collect::<Vec<_>>(),
                )
                .bind::<Integer, _>(uid)
                .bind::<BigInt, _>(MAX_UNREAD_COUNT)
                .load::<Count>(conn)?;
            attention.extend(rows.into_iter().map(|r| ((is_thread, r.id), r.count)));
        }
        Ok(aggregate(
            &selections,
            &scopes,
            &main_counts,
            &thread_counts,
            &attention,
        ))
    }
}

fn aggregate(
    selections: &[Selection<'_>],
    scopes: &[Scope],
    main: &HashMap<i64, i64>,
    threads: &HashMap<i64, i64>,
    attention: &HashMap<(bool, i64), i64>,
) -> Vec<ConversationUnreadSummary> {
    selections
        .iter()
        .map(|selection| {
            let mut summary = ConversationUnreadSummary {
                key: selection.view.key.clone(),
                ..Default::default()
            };
            for scope in scopes.iter().filter(|scope| selection.contains(scope)) {
                let count = scope
                    .thread_id
                    .map_or_else(|| main.get(&scope.chat_id), |id| threads.get(&id))
                    .copied()
                    .unwrap_or(0);
                summary.unread_message_count =
                    (summary.unread_message_count + count).min(MAX_UNREAD_COUNT);
                summary.unread_conversation_count += i64::from(count > 0);
                let attention_count = attention
                    .get(&(
                        scope.thread_id.is_some(),
                        scope.thread_id.unwrap_or(scope.chat_id),
                    ))
                    .copied()
                    .unwrap_or(0);
                summary.unread_attention_count =
                    (summary.unread_attention_count + attention_count).min(MAX_UNREAD_COUNT);
                if !scope.muted {
                    summary.unread_unmuted_message_count =
                        (summary.unread_unmuted_message_count + count).min(MAX_UNREAD_COUNT);
                    summary.unread_unmuted_conversation_count += i64::from(count > 0);
                    summary.unread_unmuted_attention_count =
                        (summary.unread_unmuted_attention_count + attention_count)
                            .min(MAX_UNREAD_COUNT);
                }
            }
            summary
        })
        .collect()
}

#[cfg(test)]
mod tests {
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
                chat_id: 1,
                thread_id: None,
                is_dm: false,
                archived: false,
                muted: false,
                last_read_message_id: None,
            },
            Scope {
                chat_id: 1,
                thread_id: Some(10),
                is_dm: false,
                archived: false,
                muted: false,
                last_read_message_id: None,
            },
            Scope {
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
            CREATE TEMP TABLE user_extra (uid INTEGER PRIMARY KEY, mute_group_chats_by_default BOOLEAN, mute_direct_chats_by_default BOOLEAN);
            INSERT INTO user_extra VALUES (1, FALSE, FALSE);
            CREATE TEMP TABLE groups (id BIGINT PRIMARY KEY, kind TEXT NOT NULL);
            CREATE TEMP TABLE group_membership (chat_id BIGINT, uid INTEGER, archived BOOLEAN, last_read_message_id BIGINT, muted_until TIMESTAMPTZ, PRIMARY KEY(chat_id, uid));
            CREATE TEMP TABLE messages (id BIGINT PRIMARY KEY, chat_id BIGINT, reply_root_id BIGINT, has_thread BOOLEAN DEFAULT FALSE, is_published BOOLEAN DEFAULT TRUE, deleted_at TIMESTAMPTZ);
            CREATE TEMP TABLE thread_user_states (chat_id BIGINT, thread_root_id BIGINT, uid INTEGER, subscribed BOOLEAN, archived BOOLEAN, last_read_message_id BIGINT, PRIMARY KEY(chat_id, thread_root_id, uid));
            CREATE TEMP TABLE message_mentions (chat_id BIGINT, thread_root_id BIGINT, message_id BIGINT, mentioned_uid INTEGER, PRIMARY KEY(message_id, mentioned_uid));
            INSERT INTO groups VALUES (1,'group'),(2,'dm'),(3,'group'),(4,'group');
            INSERT INTO group_membership VALUES (1,1,FALSE,12,'9999-01-01'),(2,1,FALSE,20,NULL),(4,1,TRUE,0,NULL);
            ALTER TABLE group_membership ADD COLUMN mute_override BOOLEAN;
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
    }
}
