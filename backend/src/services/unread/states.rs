//! Explicit conversation watches share the commit invalidation path with tab summaries.
//! Independent sticky notifications prevent one consumer from stealing another's refresh.
use super::UnreadService;
use crate::{
    dto::{
        conversations::{
            ConversationRef, ConversationState, ConversationStatesPayload,
            ConversationUnreadErrorPayload,
        },
        ws::ServerWsMessage,
    },
    schema::{group_membership, messages},
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
    pub conversations: Vec<ConversationRef>,
}

pub fn valid_scopes(scopes: &[ConversationRef]) -> bool {
    let unique: HashSet<_> = scopes.iter().collect();
    scopes.len() <= MAX_SCOPES
        && unique.len() == scopes.len()
        && scopes
            .iter()
            .all(|scope| scope.chat_id > 0 && scope.thread_id.is_none_or(|id| id > 0))
}

fn load_state(
    conn: &mut PgConnection,
    service: &UnreadService,
    uid: i32,
    scope: ConversationRef,
) -> QueryResult<ConversationState> {
    // Both membership and root lookups use existing equality indexes. Never derive
    // authorization from a subscription: an unsubscribed member may open a thread.
    let membership = group_membership::table
        .filter(group_membership::chat_id.eq(scope.chat_id))
        .filter(group_membership::uid.eq(uid))
        .select(group_membership::last_read_message_id)
        .first::<Option<i64>>(conn)
        .optional()?;
    let mut row = ConversationState {
        conversation: scope,
        accessible: false,
        last_read_message_id: None,
        unread_count: 0,
        unread_mentions: 0,
        unread_reactions: 0,
    };
    let Some(cursor) = membership else {
        return Ok(row);
    };
    row.last_read_message_id = cursor;
    if let Some(root) = scope.thread_id {
        let exists = diesel::select(diesel::dsl::exists(
            messages::table
                .filter(messages::id.eq(root))
                .filter(messages::chat_id.eq(scope.chat_id))
                .filter(messages::reply_root_id.is_null())
                .filter(messages::is_published.eq(true)),
        ))
        .get_result::<bool>(conn)?;
        if !exists {
            row.last_read_message_id = None;
            return Ok(row);
        }
        row.last_read_message_id = crate::services::threads::get_thread_last_read_message_id(
            conn,
            scope.chat_id,
            root,
            uid,
        )?;
        row.unread_count = crate::services::threads::get_thread_unread_count(
            conn,
            root,
            uid,
            row.last_read_message_id,
        )?;
    } else {
        row.unread_count = service.count_chat_unread(conn, scope.chat_id, cursor)?;
    }
    row.accessible = true;
    row.unread_mentions = service.count_chat_unread_mentions(
        conn,
        uid,
        scope.chat_id,
        row.last_read_message_id,
        scope.thread_id,
    )?;
    row.unread_reactions =
        service.count_chat_unread_reactions(conn, uid, scope.chat_id, scope.thread_id)?;
    Ok(row)
}

pub async fn run(
    db: DbPool,
    service: Arc<UnreadService>,
    uid: i32,
    changed: Arc<Notify>,
    subscription: watch::Receiver<Option<StateWatch>>,
    output: mpsc::Sender<ServerWsMessage>,
) {
    run_with(changed, subscription, output, move |watch| {
        let db = db.clone();
        let service = service.clone();
        async move {
            tokio::task::spawn_blocking(move || {
                let mut conn = db.get().map_err(|error| error.to_string())?;
                watch
                    .conversations
                    .into_iter()
                    .map(|scope| {
                        load_state(&mut conn, &service, uid, scope)
                            .map_err(|error| error.to_string())
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .await
            .map_err(|error| error.to_string())?
        }
    })
    .await;
}

async fn run_with<F, Fut>(
    changed: Arc<Notify>,
    mut subscription: watch::Receiver<Option<StateWatch>>,
    output: mpsc::Sender<ServerWsMessage>,
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
                let result = load(watch).await;
                match subscription.has_changed() { Ok(false) => {}, Ok(true) => continue, Err(_) => break }
                match result {
                    Ok(rows) => {
                        deadline = None; retry = Duration::from_secs(1);
                        let states: Vec<_> = rows.iter().filter(|row| full || previous.get(&row.conversation) != Some(*row)).cloned().collect();
                        previous = rows.into_iter().map(|row| (row.conversation, row)).collect();
                        if (full || !states.is_empty()) && output.send(ServerWsMessage::ConversationStates(ConversationStatesPayload { request_id, full, states })).await.is_err() { break; }
                        full = false;
                    }
                    Err(error) => {
                        tracing::warn!(?error, "conversation state snapshot failed");
                        full = true; deadline = Some(Instant::now() + retry); retry = (retry * 2).min(Duration::from_secs(30));
                        if output.send(ServerWsMessage::ConversationStatesError(ConversationUnreadErrorPayload { request_id })).await.is_err() { break; }
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
        let task = tokio::spawn(run_with(changed.clone(), rx, output, move |watch| {
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
        }));
        tx.send_replace(Some(StateWatch {
            request_id: 1,
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
