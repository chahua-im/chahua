//! One connection's unread subscription. No periodic polling: commits and mute expiry
//! schedule snapshots, and only changed absolute counters reach the socket.
use std::{collections::HashMap, sync::Arc, time::Duration};

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use tokio::sync::{mpsc, watch, Notify};
use tokio::time::Instant;

use super::UnreadService;
use crate::dto::conversations::{
    ConversationUnreadErrorPayload, ConversationUnreadPayload, ConversationUnreadSummary,
    ConversationView,
};
use crate::dto::ws::ServerWsMessage;
use crate::schema::group_membership;
use crate::state::DbPool;

const COALESCE: Duration = Duration::from_millis(150);

#[derive(Clone)]
pub struct UnreadWatch {
    pub request_id: u32,
    pub views: Vec<ConversationView>,
    pub app_badge: bool,
}

#[derive(Default)]
struct Published {
    full: bool,
    summaries: HashMap<String, ConversationUnreadSummary>,
    app_badge_count: Option<i64>,
}

impl Published {
    fn update(
        &mut self,
        request_id: u32,
        summaries: Vec<ConversationUnreadSummary>,
        app_badge_count: Option<i64>,
    ) -> Option<ConversationUnreadPayload> {
        let full = !self.full;
        let changed = summaries
            .iter()
            .filter(|s| full || self.summaries.get(&s.key) != Some(s))
            .cloned()
            .collect::<Vec<_>>();
        let badge_changed = full || app_badge_count != self.app_badge_count;
        self.full = true;
        self.summaries = summaries.into_iter().map(|s| (s.key.clone(), s)).collect();
        self.app_badge_count = app_badge_count;
        (full || !changed.is_empty() || badge_changed).then_some(ConversationUnreadPayload {
            request_id,
            full,
            summaries: changed,
            app_badge_count: if badge_changed { app_badge_count } else { None },
        })
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
    run_with(uid, changed, subscription, output, |watch| {
        load_snapshot(db.clone(), service.clone(), uid, watch)
    })
    .await;
}

type Snapshot = (
    Vec<ConversationUnreadSummary>,
    Option<i64>,
    Option<DateTime<Utc>>,
);

async fn run_with<F, Fut>(
    uid: i32,
    changed: Arc<Notify>,
    mut subscription: watch::Receiver<Option<UnreadWatch>>,
    output: mpsc::Sender<ServerWsMessage>,
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
                let result = load(watch).await;
                // Never publish an old scope/account after a replacement or disconnect.
                match subscription.has_changed() {
                    Ok(false) => {},
                    Ok(true) => continue,
                    Err(_) => break,
                }
                match result {
                    Ok((summaries, badge, expiry)) => {
                        retry = Duration::from_secs(1);
                        deadline = expiry.map(|at| Instant::now() + (at - Utc::now()).to_std().unwrap_or_default());
                        if let Some(payload) = published.update(current.as_ref().unwrap().request_id, summaries, badge) {
                            if output.send(ServerWsMessage::ConversationUnread(payload)).await.is_err() { break; }
                        }
                    }
                    error => {
                        tracing::warn!(uid, ?error, "unread watch snapshot failed");
                        published.full = false;
                        deadline = Some(Instant::now() + retry);
                        retry = (retry * 2).min(Duration::from_secs(30));
                        if output.send(ServerWsMessage::ConversationUnreadError(ConversationUnreadErrorPayload {
                            request_id: current.as_ref().unwrap().request_id,
                        })).await.is_err() { break; }
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
        let summaries = service
            .conversation_summaries(&mut conn, uid, &watch.views)
            .map_err(|e| e.to_string())?;
        let badge = if watch.app_badge {
            Some(
                service
                    .count_user_unread_summary(&mut conn, uid)
                    .map_err(|e| e.to_string())?
                    .unread_count,
            )
        } else {
            None
        };
        Ok((summaries, badge, expiry))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    fn summary(count: i64) -> ConversationUnreadSummary {
        ConversationUnreadSummary {
            key: "friends".into(),
            unread_message_count: count,
            ..Default::default()
        }
    }
    fn subscription(request_id: u32) -> Option<UnreadWatch> {
        Some(UnreadWatch {
            request_id,
            views: vec![],
            app_badge: true,
        })
    }

    #[test]
    fn publishes_only_changed_absolute_counters_including_zero() {
        let mut state = Published::default();
        assert!(state.update(1, vec![summary(8)], Some(7)).unwrap().full);
        assert!(state.update(1, vec![summary(8)], Some(7)).is_none());
        let update = state.update(1, vec![summary(0)], Some(0)).unwrap();
        assert!(!update.full);
        assert_eq!(update.summaries[0].unread_message_count, 0);
        assert_eq!(update.app_badge_count, Some(0));
        let badge_only = state.update(1, vec![summary(0)], Some(2)).unwrap();
        assert!(badge_only.summaries.is_empty());
        assert_eq!(badge_only.app_badge_count, Some(2));
    }

    // A controlled loader verifies races without production DB access or wall-clock sleeps.
    #[tokio::test]
    async fn replacement_discards_inflight_snapshot_and_dirty_signal_survives_loading() {
        let (config, receiver) = watch::channel(None);
        let dirty = Arc::new(Notify::new());
        let (output, mut messages) = mpsc::channel(1);
        let (loads, mut requests) =
            mpsc::unbounded_channel::<(u32, oneshot::Sender<Result<Snapshot, String>>)>();
        let task = tokio::spawn(run_with(1, dirty.clone(), receiver, output, move |watch| {
            let (reply, response) = oneshot::channel();
            loads.send((watch.request_id, reply)).unwrap();
            async move { response.await.unwrap() }
        }));
        config.send_replace(subscription(1));
        let (id, old) = requests.recv().await.unwrap();
        assert_eq!(id, 1);
        config.send_replace(subscription(2));
        old.send(Ok((vec![summary(99)], Some(99), None))).unwrap();
        let (id, current) = requests.recv().await.unwrap();
        assert_eq!(id, 2);
        assert!(messages.try_recv().is_err());
        dirty.notify_one();
        dirty.notify_one();
        current.send(Ok((vec![summary(4)], Some(4), None))).unwrap();
        let ServerWsMessage::ConversationUnread(first) = messages.recv().await.unwrap() else {
            panic!()
        };
        assert!(first.full);
        assert_eq!(first.request_id, 2);
        let (_, next) = tokio::time::timeout(Duration::from_secs(2), requests.recv())
            .await
            .unwrap()
            .unwrap();
        next.send(Ok((vec![summary(0)], Some(0), None))).unwrap();
        let ServerWsMessage::ConversationUnread(update) = messages.recv().await.unwrap() else {
            panic!()
        };
        assert!(!update.full);
        assert_eq!(update.app_badge_count, Some(0));
        config.send_replace(None);
        tokio::task::yield_now().await;
        dirty.notify_one();
        assert!(tokio::time::timeout(COALESCE * 2, requests.recv())
            .await
            .is_err());
        drop(config);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn mute_expiry_refreshes_without_messages_and_retry_restores_full_state() {
        let (config, receiver) = watch::channel(None);
        let dirty = Arc::new(Notify::new());
        let (output, mut messages) = mpsc::channel(1);
        let (loads, mut requests) =
            mpsc::unbounded_channel::<oneshot::Sender<Result<Snapshot, String>>>();
        let task = tokio::spawn(run_with(1, dirty, receiver, output, move |_| {
            let (reply, response) = oneshot::channel();
            loads.send(reply).unwrap();
            async move { response.await.unwrap() }
        }));
        config.send_replace(subscription(1));
        requests
            .recv()
            .await
            .unwrap()
            .send(Ok((
                vec![summary(1)],
                Some(1),
                Some(Utc::now() + chrono::Duration::milliseconds(30)),
            )))
            .unwrap();
        assert!(matches!(
            messages.recv().await,
            Some(ServerWsMessage::ConversationUnread(_))
        ));
        let retry = tokio::time::timeout(Duration::from_secs(2), requests.recv())
            .await
            .unwrap()
            .unwrap();
        retry.send(Err("offline".into())).unwrap();
        assert!(matches!(
            messages.recv().await,
            Some(ServerWsMessage::ConversationUnreadError(_))
        ));
        let recovered = tokio::time::timeout(Duration::from_secs(2), requests.recv())
            .await
            .unwrap()
            .unwrap();
        recovered
            .send(Ok((vec![summary(1)], Some(1), None)))
            .unwrap();
        let Some(ServerWsMessage::ConversationUnread(payload)) = messages.recv().await else {
            panic!()
        };
        assert!(payload.full); // Identical counters must still clear the client's error state.
        drop(config);
        task.await.unwrap();
    }
}
