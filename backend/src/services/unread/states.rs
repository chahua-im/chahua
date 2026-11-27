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
mod tests;
