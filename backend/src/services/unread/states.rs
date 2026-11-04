//! Explicit conversation watches share the commit invalidation path with tab summaries.
//! Independent sticky notifications prevent one consumer from stealing another's refresh.
use super::{
    service::{unread_cursor, ChatUnreadCursor},
    UnreadService,
};
use crate::{
    constants::MAX_UNREAD_COUNT,
    dto::{
        conversations::{
            ConversationRef, ConversationState, ConversationStatesPayload,
            ConversationUnreadErrorPayload,
        },
        ws::ServerWsMessage,
    },
    models::GroupKind,
    schema::{group_membership, groups},
    state::DbPool,
};
use diesel::prelude::*;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{mpsc, watch, Notify};
use tokio::time::Instant;

pub const MAX_SCOPES: usize = 512;
#[derive(Clone)]
pub struct StateWatch {
    pub request_id: u32,
    /// Assigned by the owning transport; legacy sockets use zero.
    pub generation: u64,
    pub conversations: Vec<ConversationRef>,
}

/// A state-watch result retains its installation generation until final
/// publication, allowing a transport to discard an already queued old scope.
pub struct StateWatchEvent {
    pub generation: u64,
    pub message: ServerWsMessage,
}

enum WatchOutput {
    Legacy(mpsc::Sender<ServerWsMessage>),
    Tagged(mpsc::Sender<StateWatchEvent>),
}

impl WatchOutput {
    async fn send(&self, generation: u64, message: ServerWsMessage) -> bool {
        match self {
            Self::Legacy(output) => output.send(message).await.is_ok(),
            Self::Tagged(output) => output
                .send(StateWatchEvent {
                    generation,
                    message,
                })
                .await
                .is_ok(),
        }
    }
}

pub fn valid_scopes(scopes: &[ConversationRef]) -> bool {
    let unique: HashSet<_> = scopes.iter().collect();
    scopes.len() <= MAX_SCOPES
        && unique.len() == scopes.len()
        && scopes
            .iter()
            .all(|scope| scope.chat_id > 0 && scope.thread_id.is_none_or(|id| id > 0))
}

#[derive(diesel::QueryableByName)]
struct ScopeCounts {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    chat_id: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    thread_id: i64,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::BigInt>)]
    last_read_message_id: Option<i64>,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    unread_count: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    unread_mentions: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    unread_reactions: i64,
}

fn load_states(
    conn: &mut PgConnection,
    service: &UnreadService,
    uid: i32,
    scopes: &[ConversationRef],
) -> QueryResult<Vec<ConversationState>> {
    if scopes.is_empty() {
        return Ok(vec![]);
    }
    let chat_ids: HashSet<_> = scopes.iter().map(|scope| scope.chat_id).collect();
    let memberships: HashMap<_, _> = group_membership::table
        .inner_join(groups::table)
        .filter(group_membership::uid.eq(uid))
        .filter(group_membership::chat_id.eq_any(chat_ids))
        .select((
            group_membership::chat_id,
            group_membership::last_read_message_id,
            groups::kind,
            crate::services::system_messages::membership_allowed(),
        ))
        .load::<(i64, Option<i64>, GroupKind, bool)>(conn)?
        .into_iter()
        .map(|(chat_id, cursor, kind, allowed)| (chat_id, (cursor, kind, allowed)))
        .collect();
    let show_membership_messages = if scopes.iter().any(|scope| scope.thread_id.is_none()) {
        crate::services::user::load_chat_settings(conn, uid)?.show_membership_messages
    } else {
        true
    };
    let cursors = scopes
        .iter()
        .filter(|scope| scope.thread_id.is_none())
        .filter_map(|scope| {
            let &(cursor, kind, allowed) = memberships.get(&scope.chat_id)?;
            Some(ChatUnreadCursor {
                chat_id: scope.chat_id,
                last_read_message_id: unread_cursor(cursor),
                hide_membership_messages:
                    crate::services::system_messages::hides_membership_messages(
                        show_membership_messages && allowed,
                        kind,
                        scope.thread_id,
                    ),
            })
        });
    let counts: HashMap<_, _> = service
        .count_chat_unread_cursors(conn, cursors)?
        .into_iter()
        .map(|(cursor, count)| (cursor.chat_id, count))
        .collect();

    // Zero represents the main scope; validated thread IDs are positive.
    let eligible: Vec<_> = scopes
        .iter()
        .filter(|scope| memberships.contains_key(&scope.chat_id))
        .collect();
    let mut batched = HashMap::new();
    if !eligible.is_empty() {
        let chat_ids: Vec<_> = eligible.iter().map(|scope| scope.chat_id).collect();
        let thread_ids: Vec<_> = eligible
            .iter()
            .map(|scope| scope.thread_id.unwrap_or(0))
            .collect();
        // Lateral probes retain the indexed per-scope predicates and stop at
        // the cap without issuing a database round trip for each watch.
        let rows = diesel::sql_query(
            "SELECT s.chat_id, s.thread_id,
                    CASE WHEN s.thread_id = 0 THEN gm.last_read_message_id
                         ELSE ts.last_read_message_id END AS last_read_message_id,
                    unread.unread_count, mentions.unread_mentions, reactions.unread_reactions
             FROM unnest($1::bigint[], $2::bigint[]) AS s(chat_id, thread_id)
             JOIN group_membership gm ON gm.chat_id = s.chat_id AND gm.uid = $3
             LEFT JOIN messages root ON root.id = s.thread_id AND root.chat_id = s.chat_id
                 AND root.reply_root_id IS NULL AND root.is_published = TRUE
             LEFT JOIN thread_user_states ts ON ts.chat_id = s.chat_id
                 AND ts.thread_root_id = s.thread_id AND ts.uid = $3
             CROSS JOIN LATERAL (
                 SELECT COUNT(*)::bigint AS unread_count FROM (
                     SELECT 1 FROM messages m
                     WHERE s.thread_id <> 0 AND ts.thread_root_id IS NOT NULL
                       AND m.reply_root_id = s.thread_id AND m.deleted_at IS NULL
                       AND m.is_published = TRUE AND m.id > COALESCE(ts.last_read_message_id, 0)
                     LIMIT $4
                 ) items
             ) unread
             CROSS JOIN LATERAL (
                 SELECT COUNT(*)::bigint AS unread_mentions FROM (
                     SELECT 1 FROM message_mentions mm
                     WHERE mm.mentioned_uid = $3 AND mm.chat_id = s.chat_id
                       AND ((s.thread_id = 0 AND mm.thread_root_id IS NULL)
                            OR (s.thread_id <> 0 AND mm.thread_root_id = s.thread_id))
                       AND mm.message_id > COALESCE(
                           CASE WHEN s.thread_id = 0 THEN gm.last_read_message_id
                                ELSE ts.last_read_message_id END, 0)
                     LIMIT $4
                 ) items
             ) mentions
             CROSS JOIN LATERAL (
                 SELECT COUNT(*)::bigint AS unread_reactions FROM (
                     SELECT DISTINCT mr.message_id
                     FROM message_reactions mr JOIN messages m ON m.id = mr.message_id
                     WHERE mr.message_author_uid = $3 AND mr.user_uid <> $3
                       AND m.chat_id = s.chat_id AND m.deleted_at IS NULL
                       AND m.is_published = TRUE
                       AND ((s.thread_id = 0 AND m.reply_root_id IS NULL)
                            OR (s.thread_id <> 0 AND m.reply_root_id = s.thread_id))
                       AND mr.created_at > COALESCE(
                           CASE WHEN s.thread_id = 0 THEN gm.last_reactions_read_at
                                ELSE ts.last_reactions_read_at END, '-infinity'::timestamptz)
                     LIMIT $4
                 ) items
             ) reactions
             WHERE s.thread_id = 0 OR root.id IS NOT NULL",
        )
        .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(chat_ids)
        .bind::<diesel::sql_types::Array<diesel::sql_types::BigInt>, _>(thread_ids)
        .bind::<diesel::sql_types::Integer, _>(uid)
        .bind::<diesel::sql_types::BigInt, _>(MAX_UNREAD_COUNT)
        .load::<ScopeCounts>(conn)?;
        for row in rows {
            batched.insert((row.chat_id, row.thread_id), row);
        }
    }
    Ok(scopes
        .iter()
        .map(|&scope| {
            let row = batched.get(&(scope.chat_id, scope.thread_id.unwrap_or(0)));
            ConversationState {
                conversation: scope,
                accessible: row.is_some(),
                last_read_message_id: row.and_then(|row| row.last_read_message_id),
                unread_count: row.map_or(0, |row| {
                    if scope.thread_id.is_some() {
                        row.unread_count
                    } else {
                        counts.get(&scope.chat_id).copied().unwrap_or(0)
                    }
                }),
                unread_mentions: row.map_or(0, |row| row.unread_mentions),
                unread_reactions: row.map_or(0, |row| row.unread_reactions),
            }
        })
        .collect())
}

pub async fn run(
    db: DbPool,
    service: Arc<UnreadService>,
    uid: i32,
    changed: Arc<Notify>,
    subscription: watch::Receiver<Option<StateWatch>>,
    output: mpsc::Sender<ServerWsMessage>,
) {
    run_with(
        changed,
        subscription,
        WatchOutput::Legacy(output),
        move |watch| {
            let db = db.clone();
            let service = service.clone();
            async move {
                tokio::task::spawn_blocking(move || {
                    let mut conn = db.get().map_err(|error| error.to_string())?;
                    load_states(&mut conn, &service, uid, &watch.conversations)
                        .map_err(|error| error.to_string())
                })
                .await
                .map_err(|error| error.to_string())?
            }
        },
    )
    .await;
}

/// Runs a watch while retaining the installation generation on queued output.
pub async fn run_tagged(
    db: DbPool,
    service: Arc<UnreadService>,
    uid: i32,
    changed: Arc<Notify>,
    subscription: watch::Receiver<Option<StateWatch>>,
    output: mpsc::Sender<StateWatchEvent>,
) {
    run_with(
        changed,
        subscription,
        WatchOutput::Tagged(output),
        move |watch| {
            let db = db.clone();
            let service = service.clone();
            async move {
                tokio::task::spawn_blocking(move || {
                    let mut conn = db.get().map_err(|error| error.to_string())?;
                    load_states(&mut conn, &service, uid, &watch.conversations)
                        .map_err(|error| error.to_string())
                })
                .await
                .map_err(|error| error.to_string())?
            }
        },
    )
    .await;
}

async fn run_with<F, Fut>(
    changed: Arc<Notify>,
    mut subscription: watch::Receiver<Option<StateWatch>>,
    output: WatchOutput,
    mut load: F,
) where
    F: FnMut(StateWatch) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<ConversationState>, String>>,
{
    let mut current: Option<StateWatch> = None;
    let mut previous = HashMap::new();
    let mut full = true;
    let mut deadline = None;
    let mut retry = Duration::from_secs(1);
    loop {
        tokio::select! {
            biased;
            result = subscription.changed() => {
                if result.is_err() { break; }
                current = subscription.borrow_and_update().clone();
                previous.clear(); full = true; retry = Duration::from_secs(1);
                deadline = current.as_ref().map(|_| Instant::now());
            }
            _ = async { match deadline { Some(at) => tokio::time::sleep_until(at).await, None => std::future::pending().await } } => {
                let Some(watch) = current.clone() else { continue; };
                let request_id = watch.request_id;
                let generation = watch.generation;
                let result = load(watch).await;
                match subscription.has_changed() { Ok(false) => {}, Ok(true) => continue, Err(_) => break }
                match result {
                    Ok(rows) => {
                        deadline = None; retry = Duration::from_secs(1);
                        let states: Vec<_> = rows.iter().filter(|row| full || previous.get(&row.conversation) != Some(*row)).cloned().collect();
                        previous = rows.into_iter().map(|row| (row.conversation, row)).collect();
                        if (full || !states.is_empty())
                            && !output
                                .send(
                                    generation,
                                    ServerWsMessage::ConversationStates(ConversationStatesPayload {
                                        request_id,
                                        full,
                                        states,
                                    }),
                                )
                                .await
                        {
                            break;
                        }
                        full = false;
                    }
                    Err(error) => {
                        tracing::warn!(?error, "conversation state snapshot failed");
                        full = true; deadline = Some(Instant::now() + retry); retry = (retry * 2).min(Duration::from_secs(30));
                        if !output
                            .send(
                                generation,
                                ServerWsMessage::ConversationStatesError(
                                    ConversationUnreadErrorPayload { request_id },
                                ),
                            )
                            .await
                        {
                            break;
                        }
                    }
                }
            }
            _ = changed.notified(), if current.is_some() => {
                let due = Instant::now() + Duration::from_millis(150);
                deadline = Some(deadline.map_or(due, |at| at.min(due)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_batch_visibility_and_preserve_scope_access_and_cursors() {
        use diesel::connection::{InstrumentationEvent, SimpleConnection};
        use std::sync::Mutex;

        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
            conn.batch_execute(
                "INSERT INTO groups(id, name)
                    SELECT 9876710000 + n, 'state-watch-' || n FROM generate_series(1, 50) n;
                 UPDATE groups SET kind='dm', dm_uid1=987671000, dm_uid2=987671001
                    WHERE id=9876710049;
                 INSERT INTO group_membership(chat_id, uid, last_read_message_id, archived)
                    SELECT 9876710000 + n, 987671000,
                        CASE WHEN n=1 THEN NULL ELSE (9876710000 + n) * 10 + 1 END, n % 2 = 0
                    FROM generate_series(1, 49) n;
                 INSERT INTO messages(id, chat_id, sender_uid, client_generated_id, message_type, system_kind, created_at)
                    SELECT g.id * 10 + n, g.id, 1717, 'state-watch-' || g.id || '-' || n,
                        CASE WHEN n IN (2,4) THEN 'system'::message_type ELSE 'text'::message_type END,
                        CASE WHEN n=2 THEN 'member_joined'::system_message_kind
                             WHEN n=4 THEN 'unknown'::system_message_kind ELSE NULL END, NOW()
                    FROM groups g CROSS JOIN generate_series(1,4) n
                    WHERE g.id BETWEEN 9876710001 AND 9876710050;
                 UPDATE messages SET has_thread=TRUE WHERE id=98767100011;
                 INSERT INTO messages(id, chat_id, sender_uid, client_generated_id, message_type, system_kind, reply_root_id, created_at)
                    VALUES (98767100015,9876710001,987671000,'state-watch-reply','system','member_joined',98767100011,NOW()),
                           (98767100025,9876710002,987671000,'state-watch-untracked','text',NULL,98767100021,NOW());
                 INSERT INTO thread_user_states(chat_id, thread_root_id, uid, subscribed, last_read_message_id)
                    VALUES (9876710001,98767100011,987671000,FALSE,98767100011);
                 UPDATE messages SET sender_uid=987671000 WHERE id=98767100013;
                 INSERT INTO message_mentions(message_id, mentioned_uid, chat_id, thread_root_id)
                    VALUES (98767100013,987671000,9876710001,NULL),
                           (98767100015,987671000,9876710001,98767100011),
                           (98767100025,987671000,9876710002,98767100021);
                 INSERT INTO message_reactions(message_id,user_uid,emoji,message_author_uid,created_at)
                    VALUES (98767100013,1717,'a',987671000,NOW() + INTERVAL '1 second'),
                           (98767100013,1718,'b',987671000,NOW() + INTERVAL '1 second'),
                           (98767100015,1717,'a',987671000,NOW() + INTERVAL '1 second'),
                           (98767100025,1717,'a',987671000,NOW() + INTERVAL '1 second'),
                           (98767100025,987671000,'self',987671000,NOW() + INTERVAL '1 second');"
            )?;
            let uid = 987671000;
            crate::services::user::save_chat_settings(conn, uid, crate::dto::users::UpdateChatSettings {
                show_membership_messages: false,
            })?;
            let queries = Arc::new(Mutex::new(Vec::new()));
            let recorded = queries.clone();
            conn.set_instrumentation(move |event: InstrumentationEvent<'_>| {
                if let InstrumentationEvent::StartQuery { query, .. } = event {
                    recorded.lock().unwrap().push(query.to_string());
                }
            });
            let service = UnreadService::new();
            let mut scopes: Vec<_> = (1..=50).map(|n| ConversationRef {
                chat_id: 9876710000 + n, thread_id: None,
            }).collect();
            scopes.extend([
                ConversationRef { chat_id: 9876710001, thread_id: Some(98767100011) },
                ConversationRef { chat_id: 9876710002, thread_id: Some(98767100011) },
                ConversationRef { chat_id: 9876710050, thread_id: Some(98767100501) },
                ConversationRef { chat_id: 9876710002, thread_id: Some(98767100021) },
                ConversationRef { chat_id: 9876710001, thread_id: Some(98767100015) },
            ]);
            let rows = load_states(conn, &service, uid, &scopes)?;
            assert_eq!(rows.iter().map(|row| row.conversation).collect::<Vec<_>>(), scopes);
            assert_eq!(rows[0].last_read_message_id, None);
            assert_eq!(rows[0].unread_count, 3);
            for (index, row) in rows[1..48].iter().enumerate() {
                assert!(row.accessible);
                assert_eq!(row.unread_count, 2);
                assert_eq!(row.last_read_message_id, Some((9876710002 + index as i64) * 10 + 1));
            }
            assert_eq!(rows[48].unread_count, 3); // DM events remain visible.
            assert!(rows[50].accessible); // Thread access needs membership, not a subscription.
            assert_eq!(rows[50].unread_count, 1);
            assert_eq!((rows[0].unread_mentions, rows[0].unread_reactions), (1, 1));
            assert_eq!((rows[50].unread_mentions, rows[50].unread_reactions), (1, 1));
            // A valid root without a thread state has no unread messages, but
            // mentions use cursor zero and reactions use the -infinity fallback.
            assert!(rows[53].accessible);
            assert_eq!(rows[53].last_read_message_id, None);
            assert_eq!((rows[53].unread_count, rows[53].unread_mentions, rows[53].unread_reactions), (0, 1, 1));
            assert!(!rows[54].accessible); // A reply is not a thread root.
            for index in [49,51,52] {
                assert!(!rows[index].accessible);
                assert_eq!(rows[index].last_read_message_id, None);
                assert_eq!(rows[index].unread_count, 0);
            }
            assert!(queries.lock().unwrap().len() <= 8, "snapshot queries must not grow per scope");
            crate::services::user::save_chat_settings(conn, uid, crate::dto::users::UpdateChatSettings {
                show_membership_messages: true,
            })?;
            queries.lock().unwrap().clear();
            let shown = load_states(conn, &service, uid, &scopes)?;
            assert_eq!(shown[0].unread_count, 4);
            assert_eq!(shown[1].unread_count, 3);
            assert_eq!(shown[50].unread_count, 1);
            assert!(queries.lock().unwrap().len() <= 8, "snapshot queries must stay batched");
            queries.lock().unwrap().clear();
            assert!(load_states(conn, &service, uid, &[])?.is_empty());
            assert!(queries.lock().unwrap().is_empty());
            Ok(())
        });
    }

    #[test]
    fn scopes_are_bounded_unique_and_positive() {
        let scope = ConversationRef {
            chat_id: 1,
            thread_id: None,
        };
        assert!(valid_scopes(&[scope]));
        assert!(!valid_scopes(&[scope, scope]));
        assert!(!valid_scopes(&[ConversationRef {
            chat_id: 0,
            ..scope
        }]));
        assert!(!valid_scopes(
            &(1..=513)
                .map(|chat_id| ConversationRef {
                    chat_id,
                    thread_id: None
                })
                .collect::<Vec<_>>()
        ));
    }
    #[tokio::test]
    async fn publishes_full_then_only_changes_and_cancels() {
        let changed = Arc::new(Notify::new());
        let (tx, rx) = watch::channel(None);
        let (output, mut messages) = mpsc::channel(8);
        let count = Arc::new(std::sync::atomic::AtomicI64::new(2));
        let load_count = count.clone();
        let task = tokio::spawn(run_with(
            changed.clone(),
            rx,
            WatchOutput::Legacy(output),
            move |watch| {
                let count = load_count.load(std::sync::atomic::Ordering::SeqCst);
                async move {
                    Ok(watch
                        .conversations
                        .into_iter()
                        .map(|conversation| ConversationState {
                            conversation,
                            accessible: true,
                            last_read_message_id: None,
                            unread_count: count,
                            unread_mentions: 0,
                            unread_reactions: 0,
                        })
                        .collect())
                }
            },
        ));
        tx.send_replace(Some(StateWatch {
            request_id: 1,
            generation: 0,
            conversations: vec![ConversationRef {
                chat_id: 1,
                thread_id: None,
            }],
        }));
        let ServerWsMessage::ConversationStates(first) = messages.recv().await.unwrap() else {
            panic!()
        };
        assert!(first.full);
        count.store(0, std::sync::atomic::Ordering::SeqCst);
        changed.notify_one();
        let ServerWsMessage::ConversationStates(next) = messages.recv().await.unwrap() else {
            panic!()
        };
        assert!(!next.full);
        assert_eq!(next.states[0].unread_count, 0);
        tx.send_replace(None);
        tokio::task::yield_now().await;
        changed.notify_one();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(messages.try_recv().is_err());
        drop(tx);
        task.await.unwrap();
    }
}
