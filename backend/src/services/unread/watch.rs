//! One connection's unread subscription. No periodic polling: commits and mute expiry
//! schedule snapshots, and only changed absolute counters and Main snapshots reach the socket.
use std::{collections::HashMap, sync::Arc, time::Duration};

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use tokio::sync::{mpsc, watch, Notify};
use tokio::time::Instant;

use super::UnreadService;
use crate::dto::conversations::{
    ConversationUnreadErrorPayload, ConversationUnreadPayload, ConversationUnreadSummary,
    ConversationView, MainUnread,
};
use crate::dto::ws::ServerWsMessage;
use crate::schema::group_membership;
use crate::state::DbPool;

const COALESCE: Duration = Duration::from_millis(150);

#[derive(Clone)]
pub struct UnreadWatch {
    pub request_id: u32,
    /// Assigned by the owning transport when it installs the watch. Legacy
    /// sockets retain generation zero; transports that can replace watches
    /// use it to reject events already queued by an older scope.
    pub generation: u64,
    pub views: Vec<ConversationView>,
    pub app_badge: bool,
}

/// A watch result retains the installation generation until the owning
/// transport makes its final publication decision.
pub struct UnreadWatchEvent {
    pub generation: u64,
    pub message: ServerWsMessage,
}

enum WatchOutput {
    Legacy(mpsc::Sender<ServerWsMessage>),
    Tagged(mpsc::Sender<UnreadWatchEvent>),
}

impl WatchOutput {
    async fn send(&self, generation: u64, message: ServerWsMessage) -> bool {
        match self {
            Self::Legacy(output) => output.send(message).await.is_ok(),
            Self::Tagged(output) => output
                .send(UnreadWatchEvent {
                    generation,
                    message,
                })
                .await
                .is_ok(),
        }
    }
}

#[derive(Default)]
struct Published {
    full: bool,
    summaries: HashMap<String, ConversationUnreadSummary>,
    app_badge_count: Option<i64>,
    main_unread: Option<MainUnread>,
}

impl Published {
    fn update(
        &mut self,
        request_id: u32,
        summaries: Vec<ConversationUnreadSummary>,
        app_badge_count: Option<i64>,
        main_unread: Option<MainUnread>,
    ) -> Option<ConversationUnreadPayload> {
        let full = !self.full;
        let changed = summaries
            .iter()
            .filter(|s| full || self.summaries.get(&s.key) != Some(s))
            .cloned()
            .collect::<Vec<_>>();
        let badge_changed = full || app_badge_count != self.app_badge_count;
        let main_changed = full || main_unread != self.main_unread;
        let changed_main = if main_changed {
            main_unread.clone()
        } else {
            None
        };
        self.full = true;
        self.summaries = summaries.into_iter().map(|s| (s.key.clone(), s)).collect();
        self.app_badge_count = app_badge_count;
        self.main_unread = main_unread;
        (full || !changed.is_empty() || badge_changed || main_changed).then_some(
            ConversationUnreadPayload {
                request_id,
                full,
                summaries: changed,
                app_badge_count: if badge_changed { app_badge_count } else { None },
                main_unread: changed_main,
            },
        )
    }
}

async fn wait_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// The receiver is owned by the socket; a bounded, awaited send never drops a counter update.
/// The socket checks request_id again, since the subscription can change during a send.
pub async fn run(
    db: DbPool,
    service: Arc<UnreadService>,
    uid: i32,
    changed: Arc<Notify>,
    subscription: watch::Receiver<Option<UnreadWatch>>,
    output: mpsc::Sender<ServerWsMessage>,
) {
    run_with(
        uid,
        changed,
        subscription,
        WatchOutput::Legacy(output),
        |watch| load_snapshot(db.clone(), service.clone(), uid, watch),
    )
    .await;
}

/// Runs a watch while retaining the installation generation on queued output.
/// The RPC adapter uses this at its final publication boundary; legacy sockets
/// keep the original `run` contract above.
pub async fn run_tagged(
    db: DbPool,
    service: Arc<UnreadService>,
    uid: i32,
    changed: Arc<Notify>,
    subscription: watch::Receiver<Option<UnreadWatch>>,
    output: mpsc::Sender<UnreadWatchEvent>,
) {
    run_with(
        uid,
        changed,
        subscription,
        WatchOutput::Tagged(output),
        |watch| load_snapshot(db.clone(), service.clone(), uid, watch),
    )
    .await;
}

type Snapshot = (
    Vec<ConversationUnreadSummary>,
    Option<i64>,
    Option<MainUnread>,
    Option<DateTime<Utc>>,
);

async fn run_with<F, Fut>(
    uid: i32,
    changed: Arc<Notify>,
    mut subscription: watch::Receiver<Option<UnreadWatch>>,
    output: WatchOutput,
    mut load: F,
) where
    F: FnMut(UnreadWatch) -> Fut,
    Fut: std::future::Future<Output = Result<Snapshot, String>>,
{
    let mut current: Option<UnreadWatch> = None;
    let mut published = Published::default();
    let mut deadline = None;
    let mut retry = Duration::from_secs(1);
    loop {
        tokio::select! {
            biased;
            result = subscription.changed() => {
                if result.is_err() { break; }
                current = subscription.borrow_and_update().clone();
                published = Published::default();
                retry = Duration::from_secs(1);
                deadline = current.as_ref().map(|_| Instant::now());
            }
            _ = wait_until(deadline) => {
                let Some(watch) = current.clone() else { continue; };
                let request_id = watch.request_id;
                let generation = watch.generation;
                let result = load(watch).await;
                // Never publish an old scope/account after a replacement or disconnect.
                match subscription.has_changed() {
                    Ok(false) => {},
                    Ok(true) => continue,
                    Err(_) => break,
                }
                match result {
                    Ok((summaries, badge, main_unread, expiry)) => {
                        retry = Duration::from_secs(1);
                        deadline = expiry.map(|at| {
                            Instant::now() + (at - Utc::now()).to_std().unwrap_or_default()
                        });
                        if let Some(payload) = published.update(request_id, summaries, badge, main_unread) {
                            if !output
                                .send(generation, ServerWsMessage::ConversationUnread(payload))
                                .await
                            {
                                break;
                            }
                        }
                    }
                    error => {
                        tracing::warn!(uid, ?error, "unread watch snapshot failed");
                        published.full = false;
                        deadline = Some(Instant::now() + retry);
                        retry = (retry * 2).min(Duration::from_secs(30));
                        if !output
                            .send(
                                generation,
                                ServerWsMessage::ConversationUnreadError(
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
                let due = Instant::now() + COALESCE;
                deadline = Some(deadline.map_or(due, |existing: Instant| existing.min(due)));
            }

        }
    }
}

async fn load_snapshot(
    db: DbPool,
    service: Arc<UnreadService>,
    uid: i32,
    watch: UnreadWatch,
) -> Result<Snapshot, String> {
    tokio::task::spawn_blocking(move || -> Result<Snapshot, String> {
        let mut conn = db.get().map_err(|e| e.to_string())?;
        // uid uses the existing membership index. Permanent mutes need no timer.
        let expiry = group_membership::table
            .filter(group_membership::uid.eq(uid))
            .filter(group_membership::muted_until.gt(Utc::now()))
            .filter(
                group_membership::muted_until.lt(crate::services::chat::indefinite_mute_until()),
            )
            .select(diesel::dsl::min(group_membership::muted_until))
            .first::<Option<DateTime<Utc>>>(&mut conn)
            .map_err(|e| e.to_string())?;
        let (summaries, badge, main_unread) = service
            .conversation_summaries_and_badge(&mut conn, uid, &watch.views, watch.app_badge)
            .map_err(|e| e.to_string())?;
        Ok((summaries, badge, main_unread, expiry))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests;
