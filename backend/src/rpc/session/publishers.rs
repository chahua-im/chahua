use std::sync::Arc;

use tokio::{
    sync::{mpsc, watch, Mutex},
    time::{self, Instant},
};

use crate::{
    dto::ws::ServerWsMessage,
    services::{
        message_sync::{SyncDriver, SyncError, SyncSink},
        presence::snapshot_after_pending_changes,
        unread,
        ws_registry::ConnectionEntry,
    },
};

use super::super::{error::RpcLifecycleFailure, events::encode_event, RpcServices};
use super::{
    controls::handle_lifecycle_failure,
    io::{RpcIoError, RpcOutputSink},
    state::{Activation, BoundSession, SessionShared, VersionedPresenceWatch},
    PRESENCE_REFRESH_INTERVAL,
};

pub(super) enum WatchIdentity {
    Presence {
        generation: u64,
        request_id: Option<u64>,
    },
    Unread {
        generation: u64,
        request_id: u32,
    },
    States {
        generation: u64,
        request_id: u32,
    },
}

pub(super) trait OwnedWatchEvent {
    fn into_identity_and_message(self) -> (WatchIdentity, ServerWsMessage);
}

impl OwnedWatchEvent for unread::watch::UnreadWatchEvent {
    fn into_identity_and_message(self) -> (WatchIdentity, ServerWsMessage) {
        let request_id = match &self.message {
            ServerWsMessage::ConversationUnread(payload) => payload.request_id,
            ServerWsMessage::ConversationUnreadError(payload) => payload.request_id,
            _ => unreachable!("unread watch emitted a non-unread event"),
        };
        (
            WatchIdentity::Unread {
                generation: self.generation,
                request_id,
            },
            self.message,
        )
    }
}

impl OwnedWatchEvent for unread::states::StateWatchEvent {
    fn into_identity_and_message(self) -> (WatchIdentity, ServerWsMessage) {
        let request_id = match &self.message {
            ServerWsMessage::ConversationStates(payload) => payload.request_id,
            ServerWsMessage::ConversationStatesError(payload) => payload.request_id,
            _ => unreachable!("state watch emitted a non-state event"),
        };
        (
            WatchIdentity::States {
                generation: self.generation,
                request_id,
            },
            self.message,
        )
    }
}

impl Activation {
    pub(super) fn start_publishers(
        self,
        session: &Arc<SessionShared>,
        services: &RpcServices,
        sink: &RpcOutputSink,
    ) {
        let Activation {
            uid,
            entry,
            registry_events,
            presence_receiver,
            unread_receiver,
            states_receiver,
            sync_driver,
        } = self;
        if let (Some(driver), Some(subscription)) = (sync_driver, entry.message_sync.clone()) {
            tokio::spawn(run_message_sync_drain(
                driver,
                subscription,
                session.clone(),
                sink.clone(),
            ));
        }
        if let Some(events) = registry_events {
            tokio::spawn(forward_registry_events(
                events,
                entry.clone(),
                session.clone(),
                sink.clone(),
            ));
        }
        if let Some(receiver) = presence_receiver {
            let shared = session.clone();
            let sink = sink.clone();
            let service = services.presence_service.clone();
            tokio::spawn(async move {
                let mut close = shared.transport.close_subscription();
                if shared.transport.is_closed() {
                    return;
                }
                tokio::select! {
                    _ = shared.transport.wait_closed(&mut close) => {}
                    _ = run_presence_watch(service, uid, receiver, &shared, sink) => {}
                }
            });
        }
        if let Some(receiver) = unread_receiver {
            let (watch_output, watch_events) = mpsc::channel(1);
            let shared = session.clone();
            let sink = sink.clone();
            let db = services.db.clone();
            let unread_service = services.unread_service.clone();
            let changed = entry.unread_changed.clone();
            tokio::spawn(async move {
                let mut close = shared.transport.close_subscription();
                if shared.transport.is_closed() {
                    return;
                }
                tokio::select! {
                    _ = shared.transport.wait_closed(&mut close) => {}
                    _ = unread::watch::run_tagged(
                        db,
                        unread_service,
                        uid,
                        changed,
                        receiver,
                        watch_output,
                    ) => {}
                }
            });
            tokio::spawn(forward_owned_events(
                watch_events,
                session.clone(),
                sink.clone(),
            ));
        }
        if let Some(receiver) = states_receiver {
            let (watch_output, watch_events) = mpsc::channel(1);
            let shared = session.clone();
            let sink = sink.clone();
            let db = services.db.clone();
            let unread_service = services.unread_service.clone();
            let changed = entry.states_changed.clone();
            tokio::spawn(async move {
                let mut close = shared.transport.close_subscription();
                if shared.transport.is_closed() {
                    return;
                }
                tokio::select! {
                    _ = shared.transport.wait_closed(&mut close) => {}
                    _ = unread::states::run_tagged(
                        db,
                        unread_service,
                        uid,
                        changed,
                        receiver,
                        watch_output,
                    ) => {}
                }
            });
            tokio::spawn(forward_owned_events(
                watch_events,
                session.clone(),
                sink.clone(),
            ));
        }
    }
}

async fn run_message_sync_drain(
    driver: Arc<Mutex<SyncDriver>>,
    subscription: Arc<crate::services::message_sync::SyncSubscription>,
    shared: Arc<SessionShared>,
    sink: RpcOutputSink,
) {
    let mut close = shared.transport.close_subscription();
    let drain = async {
        loop {
            subscription.notified().await;
            if subscription.is_closed() {
                shared.transport.close();
                break;
            }
            let mut driver = driver.lock().await;
            let result = driver
                .drain(RpcSyncSink {
                    shared: &shared,
                    sink: &sink,
                })
                .await;
            match result {
                Ok(()) => {}
                Err(SyncError::Backend(error)) => {
                    tracing::error!(?error, "RPC message sync drain failed");
                    handle_lifecycle_failure(
                        RpcLifecycleFailure::MessageSyncUnavailable,
                        &shared,
                        &sink,
                    )
                    .await;
                    break;
                }
                Err(_) => {
                    shared.transport.close();
                    break;
                }
            }
        }
    };
    tokio::select! {
        _ = shared.transport.wait_closed(&mut close) => {}
        _ = drain => {}
    }
}

async fn send_authorized_event(
    shared: &Arc<SessionShared>,
    sink: &RpcOutputSink,
    message: &ServerWsMessage,
) -> Result<(), RpcIoError> {
    let _gate = shared.event_gate.lock().await;
    if shared.transport.is_closed() || !shared.state.lock().await.accepting {
        return Ok(());
    }
    let text = encode_event(message).map_err(|error| {
        tracing::error!(?error, "RPC event serialization failed");
        RpcIoError::Closed
    })?;
    sink.send_text(text).await
}

fn current_watch_matches(bound: &BoundSession, identity: &WatchIdentity) -> bool {
    match identity {
        WatchIdentity::Presence {
            generation,
            request_id,
        } => bound
            .presence_subscription
            .borrow()
            .as_ref()
            .is_some_and(|watch| {
                watch.generation == *generation && watch.watch.request_id == *request_id
            }),
        WatchIdentity::Unread {
            generation,
            request_id,
        } => bound
            .unread_subscription
            .borrow()
            .as_ref()
            .is_some_and(|watch| {
                watch.generation == *generation && watch.request_id == *request_id
            }),
        WatchIdentity::States {
            generation,
            request_id,
        } => bound
            .states_subscription
            .borrow()
            .as_ref()
            .is_some_and(|watch| {
                watch.generation == *generation && watch.request_id == *request_id
            }),
    }
}

async fn send_current_watch_event(
    shared: &Arc<SessionShared>,
    sink: &RpcOutputSink,
    identity: WatchIdentity,
    message: ServerWsMessage,
) -> Result<(), RpcIoError> {
    // Replacement takes this same gate before updating its watch sender. Keep
    // it through enqueue so a control acknowledgement cannot overtake an old
    // event whose current-subscription check has become stale.
    let _gate = shared.event_gate.lock().await;
    let state = shared.state.lock().await;
    if shared.transport.is_closed()
        || !state.accepting
        || !state.activated
        || !state
            .bound
            .as_ref()
            .is_some_and(|bound| current_watch_matches(bound, &identity))
    {
        return Ok(());
    }
    let text = encode_event(&message).map_err(|error| {
        tracing::error!(?error, "RPC event serialization failed");
        RpcIoError::Closed
    })?;
    sink.send_text(text).await
}
async fn forward_registry_events(
    mut events: mpsc::Receiver<Arc<ServerWsMessage>>,
    entry: Arc<ConnectionEntry>,
    shared: Arc<SessionShared>,
    sink: RpcOutputSink,
) {
    let mut close = shared.transport.close_subscription();
    loop {
        if shared.transport.is_closed() {
            break;
        }
        tokio::select! {
            _ = shared.transport.wait_closed(&mut close) => break,
            _ = entry.lagged.notified() => {
                shared.transport.close();
                break;
            }
            event = events.recv() => match event {
                Some(event) => {
                    if send_authorized_event(&shared, &sink, &event).await.is_err() {
                        shared.transport.close();
                        break;
                    }
                }
                None => break,
            }
        }
    }
}

pub(super) async fn forward_owned_events<E>(
    mut events: mpsc::Receiver<E>,
    shared: Arc<SessionShared>,
    sink: RpcOutputSink,
) where
    E: OwnedWatchEvent,
{
    let mut close = shared.transport.close_subscription();
    loop {
        if shared.transport.is_closed() {
            break;
        }
        tokio::select! {
            _ = shared.transport.wait_closed(&mut close) => break,
            event = events.recv() => match event {
                Some(event) => {
                    let (identity, message) = event.into_identity_and_message();
                    if send_current_watch_event(&shared, &sink, identity, message).await.is_err() {
                        shared.transport.close();
                        break;
                    }
                }
                None => break,
            }
        }
    }
}

async fn run_presence_watch(
    service: Arc<crate::services::presence::PresenceSnapshotService>,
    uid: i32,
    mut subscription: watch::Receiver<Option<VersionedPresenceWatch>>,
    shared: &Arc<SessionShared>,
    sink: RpcOutputSink,
) {
    let mut changes = service.subscribe_changes();
    let mut current = None;
    let mut refresh = time::interval_at(
        Instant::now() + PRESENCE_REFRESH_INTERVAL,
        PRESENCE_REFRESH_INTERVAL,
    );
    loop {
        tokio::select! {
            changed = subscription.changed() => {
                if changed.is_err() { break; }
                current = subscription.borrow_and_update().clone();
                if let Some(watch) = current.as_ref() {
                    if publish_presence_snapshot(&service, &mut changes, uid, watch, shared, &sink).await.is_err() {
                        shared.transport.close();
                        break;
                    }
                }
            }
            change = changes.recv(), if current.is_some() => {
                let refresh_needed = match change {
                    Ok(change) => {
                        let watch = &current.as_ref().expect("guarded above").watch;
                        change.affects(uid, &watch.user_ids)
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        !current
                            .as_ref()
                            .expect("guarded above")
                            .watch
                            .user_ids
                            .is_empty()
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => false,
                };
                if refresh_needed {
                    let watch = current.as_ref().expect("guarded above");
                    if publish_presence_snapshot(&service, &mut changes, uid, watch, shared, &sink).await.is_err() {
                        shared.transport.close();
                        break;
                    }
                }
            }
            _ = refresh.tick(), if current.is_some() => {
                let watch = current.as_ref().expect("guarded above");
                if publish_presence_snapshot(&service, &mut changes, uid, watch, shared, &sink).await.is_err() {
                    shared.transport.close();
                    break;
                }
            }
        }
    }
}

async fn publish_presence_snapshot(
    service: &crate::services::presence::PresenceSnapshotService,
    changes: &mut crate::services::presence::PresenceChanges,
    uid: i32,
    watch: &VersionedPresenceWatch,
    shared: &Arc<SessionShared>,
    sink: &RpcOutputSink,
) -> Result<(), RpcIoError> {
    match snapshot_after_pending_changes(service, changes, uid, &watch.watch).await {
        Ok(snapshot) => {
            send_current_watch_event(
                shared,
                sink,
                WatchIdentity::Presence {
                    generation: watch.generation,
                    request_id: watch.watch.request_id,
                },
                ServerWsMessage::PresenceSnapshot(snapshot),
            )
            .await
        }
        Err(error) => {
            tracing::warn!(?error, uid, "RPC presence snapshot failed");
            Ok(())
        }
    }
}

pub(super) struct RpcSyncSink<'a> {
    pub(super) shared: &'a Arc<SessionShared>,
    pub(super) sink: &'a RpcOutputSink,
}

impl SyncSink for RpcSyncSink<'_> {
    async fn send(&mut self, frame: &ServerWsMessage) -> Result<(), SyncError> {
        send_authorized_event(self.shared, self.sink, frame)
            .await
            .map_err(|_| SyncError::Delivery)
    }
}
