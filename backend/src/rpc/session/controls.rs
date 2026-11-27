use std::{collections::BTreeMap, sync::Arc};

use tokio::{
    sync::{mpsc, oneshot},
    task::JoinSet,
    time::{self, Instant},
};

use crate::{
    dto::{
        auth::{AuthTokenResponse, DevSessionRequest},
        message_sync::{MessageSyncPageParams, MessageSyncResumeParams},
        rpc::{
            auth::AuthCreateDevSessionParams,
            conversations::{ConversationsWatchStatesParams, ConversationsWatchUnreadParams},
            notifications::{
                SessionInvalidatedReason, SessionNotification, SessionUnavailableReason,
            },
            presence::PresenceWatchParams,
            session::{
                SessionOpenParams, SessionOpenResult, SessionPingParams, SessionSetAppStateParams,
            },
        },
        ws::OnlineClientStatus,
    },
    services::{
        api::auth,
        auth_token::VerifiedSession,
        authentication,
        message_sync::SyncError,
        presence::validate_presence_watch,
        unread,
        ws_registry::{AppPresenceState, ConnectionEntry},
    },
};

use super::super::{
    error::{RpcError, RpcErrorCode, RpcLifecycleFailure},
    events::encode_session_notification,
    AppState,
};
use super::{
    io::RpcOutputSink, publishers::RpcSyncSink, state::SessionShared, REVOCATION_CHECK_INTERVAL,
};

pub type ControlReply<T> = oneshot::Sender<Result<T, RpcError>>;

/// Typed commands carried by the session's bounded, serial control lane.
pub enum RpcControlCommand {
    MessageSyncResume {
        sync_seq: u64,
        params: MessageSyncResumeParams,
        reply: ControlReply<crate::dto::rpc::session::EmptyResult>,
    },
    MessageSyncPage {
        sync_seq: u64,
        params: MessageSyncPageParams,
        reply: ControlReply<crate::dto::rpc::session::EmptyResult>,
    },
    MessageSyncSkip {
        sync_seq: u64,
    },
    Open {
        params: SessionOpenParams,
        reply: ControlReply<SessionOpenResult>,
    },
    CreateDevSession {
        params: AuthCreateDevSessionParams,
        reply: ControlReply<AuthTokenResponse>,
    },
    Refresh {
        reply: ControlReply<AuthTokenResponse>,
    },
    Ping {
        params: SessionPingParams,
        reply: ControlReply<()>,
    },
    SetAppState {
        params: SessionSetAppStateParams,
        reply: ControlReply<()>,
    },
    WatchPresence {
        params: PresenceWatchParams,
        reply: ControlReply<()>,
    },
    WatchUnread {
        params: ConversationsWatchUnreadParams,
        reply: ControlReply<()>,
    },
    WatchStates {
        params: ConversationsWatchStatesParams,
        reply: ControlReply<()>,
    },
}

impl RpcControlCommand {
    fn sync_seq(&self) -> Option<u64> {
        match self {
            Self::MessageSyncResume { sync_seq, .. }
            | Self::MessageSyncPage { sync_seq, .. }
            | Self::MessageSyncSkip { sync_seq } => Some(*sync_seq),
            _ => None,
        }
    }
}

/// Reserve space before dispatch. Dropping an unused reservation fills the gap
/// even if decoding fails or the dispatch future is cancelled before polling.
pub(crate) struct SyncControlSlot {
    pub(crate) seq: u64,
    pub(super) permit: std::sync::Mutex<Option<mpsc::OwnedPermit<RpcControlCommand>>>,
}

impl SyncControlSlot {
    pub(crate) fn send(&self, command: RpcControlCommand) {
        let permit = self
            .permit
            .lock()
            .unwrap()
            .take()
            .expect("one sync control");
        drop(permit.send(command));
    }
}

impl Drop for SyncControlSlot {
    fn drop(&mut self) {
        if let Some(permit) = self.permit.get_mut().unwrap().take() {
            drop(permit.send(RpcControlCommand::MessageSyncSkip { sync_seq: self.seq }));
        }
    }
}

async fn record_bind_activity(
    services: &AppState,
    session: &VerifiedSession,
    app_version: Option<String>,
) -> Result<(), RpcError> {
    let tracking = services.client_tracking.clone();
    let client_id = session.client_id.clone();
    let uid = session.uid;
    tokio::task::spawn_blocking(move || {
        tracking
            .record_activity(uid, &client_id, app_version.as_deref())
            .map_err(RpcError::from)
    })
    .await
    .map_err(|error| {
        tracing::error!(?error, uid, "RPC bind activity worker failed");
        RpcError::new(RpcErrorCode::DispatcherInternal)
    })?
}

fn record_active_rpc_activity(
    activity_tasks: &mut JoinSet<()>,
    services: &AppState,
    session: &VerifiedSession,
) {
    let uid = session.uid;
    if activity_tasks.is_empty() {
        let tracking = services.client_tracking.clone();
        let client_id = session.client_id.clone();
        activity_tasks.spawn_blocking(move || {
            if let Err(error) = tracking.record_client_activity(uid, &client_id, None) {
                tracing::warn!(?error, uid, "RPC client activity recording failed");
            }
        });
    }
}

async fn verify_open(services: &AppState, token: String) -> Result<VerifiedSession, RpcError> {
    let services = services.clone();
    tokio::task::spawn_blocking(move || {
        authentication::verify_session(
            &token,
            &services.auth_token_service,
            &services.token_generation,
            &services.db,
        )
        .map_err(RpcError::from)
    })
    .await
    .map_err(|error| {
        tracing::error!(?error, "RPC session-open verifier worker failed");
        RpcError::new(RpcErrorCode::DispatcherInternal)
    })?
}

async fn guard_bound(
    shared: &Arc<SessionShared>,
    services: &AppState,
) -> Result<(Arc<VerifiedSession>, Arc<ConnectionEntry>), RpcError> {
    let identity = shared.bound_identity().await.ok_or_else(|| {
        RpcError::with_message(RpcErrorCode::Unauthorized, "Authentication required")
    })?;
    let services = services.clone();
    let session = identity.0.clone();
    tokio::task::spawn_blocking(move || {
        authentication::check_session_generation_cause(
            &session,
            &services.token_generation,
            &services.db,
        )
        .map_err(|failure| RpcError::from(RpcLifecycleFailure::from(failure)))
    })
    .await
    .map_err(|error| {
        tracing::error!(?error, "RPC generation-guard worker failed");
        RpcError::new(RpcErrorCode::DispatcherInternal)
    })??;
    Ok(identity)
}

fn app_presence_state(
    status: Option<OnlineClientStatus>,
    default: AppPresenceState,
) -> AppPresenceState {
    status.map(AppPresenceState::from).unwrap_or(default)
}

async fn bind_authenticated(
    shared: &Arc<SessionShared>,
    services: &AppState,
    session: VerifiedSession,
    app_version: Option<String>,
    sync_enabled: bool,
) -> Result<SessionOpenResult, RpcError> {
    let response = SessionOpenResult::authenticated(&session, sync_enabled.then_some(1));
    let app_version = shared.binding_app_version(app_version).await;
    record_bind_activity(services, &session, app_version).await?;
    shared.bind(services, session, sync_enabled).await?;
    Ok(response)
}

pub(super) async fn run_controls(
    mut controls: mpsc::Receiver<RpcControlCommand>,
    shared: Arc<SessionShared>,
    services: AppState,
    sink: RpcOutputSink,
) {
    let mut close = shared.transport.close_subscription();
    let mut activity_tasks = JoinSet::new();
    let mut next_sync_seq = 0;
    let mut pending_sync = BTreeMap::new();
    loop {
        if shared.transport.is_closed() {
            break;
        }
        tokio::select! {
            _ = shared.transport.wait_closed(&mut close) => break,
            result = activity_tasks.join_next(), if !activity_tasks.is_empty() => {
                if let Some(Err(error)) = result {
                    tracing::warn!(?error, "RPC client activity worker failed");
                }
            }
            command = controls.recv() => {
                let Some(command) = command else { break };
                if let Some(seq) = command.sync_seq() {
                    pending_sync.insert(seq, command);
                    while let Some(command) = pending_sync.remove(&next_sync_seq) {
                        next_sync_seq += 1;
                        handle_control(command, &shared, &services, &sink, &mut activity_tasks).await;
                        if shared.transport.is_closed() {
                            break;
                        }
                    }
                } else {
                    handle_control(command, &shared, &services, &sink, &mut activity_tasks).await;
                }
            }
        }
    }
}

async fn run_sync_control(
    shared: &Arc<SessionShared>,
    services: &AppState,
    sink: &RpcOutputSink,
    resume: Option<MessageSyncResumeParams>,
    page: Option<MessageSyncPageParams>,
) -> Result<crate::dto::rpc::session::EmptyResult, RpcError> {
    let driver = {
        let state = shared.state.lock().await;
        state
            .bound
            .as_ref()
            .and_then(|bound| bound.sync_driver.clone())
    }
    .ok_or_else(|| {
        RpcError::with_message(
            RpcErrorCode::InvalidParams,
            "message sync is not enabled for this session",
        )
    })?;
    let _ = guard_bound(shared, services).await?;
    let mut close = shared.transport.close_subscription();
    let operation = async {
        let mut driver = driver.lock().await;
        let sender = RpcSyncSink { shared, sink };
        if let Some(params) = resume {
            driver.resume(params, sender).await
        } else {
            driver
                .page(page.expect("page control has parameters"), sender)
                .await
        }
    };
    let result = tokio::select! {
        _ = shared.transport.wait_closed(&mut close) => Err(SyncError::Delivery),
        result = operation => result,
    };
    match result {
        Ok(()) => Ok(crate::dto::rpc::session::EmptyResult {}),
        Err(SyncError::Protocol(message)) => {
            Err(RpcError::with_message(RpcErrorCode::InvalidParams, message))
        }
        Err(SyncError::Backend(error)) => {
            tracing::error!(?error, "RPC message sync operation failed");
            Err(RpcLifecycleFailure::MessageSyncUnavailable.into())
        }
        Err(SyncError::Delivery) => {
            shared.transport.close();
            Err(RpcError::new(RpcErrorCode::Unavailable))
        }
    }
}

pub(super) async fn handle_control(
    command: RpcControlCommand,
    shared: &Arc<SessionShared>,
    services: &AppState,
    sink: &RpcOutputSink,
    activity_tasks: &mut JoinSet<()>,
) {
    match command {
        RpcControlCommand::MessageSyncResume { params, reply, .. } => {
            let result = run_sync_control(shared, services, sink, Some(params), None).await;
            let _ = reply.send(result);
        }
        RpcControlCommand::MessageSyncPage { params, reply, .. } => {
            let result = run_sync_control(shared, services, sink, None, Some(params)).await;
            let _ = reply.send(result);
        }
        RpcControlCommand::MessageSyncSkip { .. } => {}
        RpcControlCommand::Open { params, reply } => {
            let result = async {
                if params.protocol_version != 1 {
                    return Err(RpcError::new(RpcErrorCode::InvalidParams));
                }
                if shared.opened().await {
                    if shared.bound_identity().await.is_some() {
                        let _ = guard_bound(shared, services).await?;
                    }
                    return Err(RpcError::with_message(
                        RpcErrorCode::Conflict,
                        "Session already opened",
                    ));
                }
                match params.token {
                    Some(token) => {
                        let session = verify_open(services, token).await?;
                        bind_authenticated(
                            shared,
                            services,
                            session,
                            params.app_version,
                            params.message_sync == Some(1),
                        )
                        .await
                    }
                    None => {
                        shared.mark_anonymous(params.app_version).await?;
                        Ok(SessionOpenResult::anonymous())
                    }
                }
            }
            .await;
            let _ = reply.send(result);
        }
        RpcControlCommand::CreateDevSession { params, reply } => {
            let result = async {
                let already_authenticated = {
                    let state = shared.state.lock().await;
                    if !state.opened {
                        return Err(RpcError::with_message(
                            RpcErrorCode::Unauthorized,
                            "Authentication required",
                        ));
                    }
                    state.bound.is_some()
                };
                if already_authenticated {
                    let _ = guard_bound(shared, services).await?;
                    return Err(RpcError::with_message(
                        RpcErrorCode::Conflict,
                        "Session already authenticated",
                    ));
                }
                let services_for_issue = services.clone();
                let uid = params.uid;
                let client_id = params.client_id;
                let issued = tokio::task::spawn_blocking(move || {
                    services_for_issue
                        .dev_sessions
                        .post_dev_session(DevSessionRequest { uid }, client_id)
                        .map_err(RpcError::from)
                })
                .await
                .map_err(|error| {
                    tracing::error!(?error, "RPC development-session worker failed");
                    RpcError::new(RpcErrorCode::DispatcherInternal)
                })??;
                let response = issued.response;
                bind_authenticated(shared, services, issued.session, None, false).await?;
                Ok(response)
            }
            .await;
            let _ = reply.send(result);
        }
        RpcControlCommand::Refresh { reply } => {
            let result = async {
                let (session, _) = guard_bound(shared, services).await?;
                record_bind_activity(services, &session, None).await?;
                auth::post_refresh(&session, &services.auth_token_service).map_err(RpcError::from)
            }
            .await;
            let _ = reply.send(result);
        }
        RpcControlCommand::Ping { params, reply } => {
            let result = async {
                let (session, entry) = guard_bound(shared, services).await?;
                let state = app_presence_state(params.state, AppPresenceState::Active);
                entry.update_ping(state);
                services.ws_registry.refresh_metrics();
                if state == AppPresenceState::Active {
                    record_active_rpc_activity(activity_tasks, services, &session);
                }
                Ok(())
            }
            .await;
            let _ = reply.send(result);
        }
        RpcControlCommand::SetAppState { params, reply } => {
            let result = async {
                let (session, entry) = guard_bound(shared, services).await?;
                let state = app_presence_state(params.state, AppPresenceState::Inactive);
                entry.update_app_state(state);
                services.ws_registry.refresh_metrics();
                if state == AppPresenceState::Active {
                    record_active_rpc_activity(activity_tasks, services, &session);
                }
                Ok(())
            }
            .await;
            let _ = reply.send(result);
        }
        RpcControlCommand::WatchPresence { params, reply } => {
            let result = async {
                let _ = guard_bound(shared, services).await?;
                if params
                    .user_ids
                    .as_ref()
                    .is_some_and(|user_ids| user_ids.iter().any(|uid| *uid <= 0))
                {
                    return Err(RpcError::new(RpcErrorCode::InvalidParams));
                }
                let watch =
                    validate_presence_watch(params.request_id, params.user_ids, params.chat_ids)
                        .map_err(|_| RpcError::new(RpcErrorCode::InvalidParams))?;
                shared.replace_presence_watch(watch).await
            }
            .await;
            let _ = reply.send(result);
        }
        RpcControlCommand::WatchUnread { params, reply } => {
            let result = async {
                let _ = guard_bound(shared, services).await?;
                unread::validate_conversation_views(&params.views)
                    .map_err(|_| RpcError::new(RpcErrorCode::InvalidParams))?;
                shared
                    .replace_unread_watch((!params.views.is_empty() || params.app_badge).then_some(
                        unread::watch::UnreadWatch {
                            request_id: params.request_id,
                            generation: 0,
                            views: params.views,
                            app_badge: params.app_badge,
                        },
                    ))
                    .await
            }
            .await;
            let _ = reply.send(result);
        }
        RpcControlCommand::WatchStates { params, reply } => {
            let result = async {
                let _ = guard_bound(shared, services).await?;
                if !unread::states::valid_scopes(&params.conversations) {
                    return Err(RpcError::new(RpcErrorCode::InvalidParams));
                }
                shared
                    .replace_states_watch((!params.conversations.is_empty()).then_some(
                        unread::states::StateWatch {
                            request_id: params.request_id,
                            generation: 0,
                            conversations: params.conversations,
                        },
                    ))
                    .await
            }
            .await;
            let _ = reply.send(result);
        }
    }
}

pub(super) async fn generation_checks(
    shared: Arc<SessionShared>,
    services: AppState,
    session: Arc<VerifiedSession>,
    guard_failures: mpsc::UnboundedSender<RpcLifecycleFailure>,
) {
    let mut close = shared.transport.close_subscription();
    let mut interval = time::interval_at(
        Instant::now() + REVOCATION_CHECK_INTERVAL,
        REVOCATION_CHECK_INTERVAL,
    );
    loop {
        if shared.transport.is_closed() {
            break;
        }
        tokio::select! {
            _ = shared.transport.wait_closed(&mut close) => break,
            _ = interval.tick() => {
                let services = services.clone();
                let checked = session.clone();
                let result = tokio::task::spawn_blocking(move || {
                    authentication::check_session_generation_cause(
                        &checked,
                        &services.token_generation,
                        &services.db,
                    )
                }).await;
                let failure = match result {
                    Ok(Ok(())) => None,
                    Ok(Err(failure)) => Some(RpcLifecycleFailure::from(failure)),
                    Err(error) => {
                        tracing::error!(?error, "RPC periodic generation-guard worker failed");
                        Some(RpcLifecycleFailure::AuthLookupUnavailable)
                    }
                };
                if let Some(failure) = failure {
                    let _ = guard_failures.send(failure);
                    break;
                }
            }
        }
    }
}

pub(super) async fn handle_lifecycle_failure(
    failure: RpcLifecycleFailure,
    shared: &Arc<SessionShared>,
    sink: &RpcOutputSink,
) {
    let _gate = shared.event_gate.lock().await;
    {
        let mut state = shared.state.lock().await;
        if state.lifecycle_notified {
            return;
        }
        state.accepting = false;
        state.lifecycle_notified = true;
    }
    let notification = match failure {
        RpcLifecycleFailure::Revoked => SessionNotification::Invalidated {
            reason: SessionInvalidatedReason::Revoked,
        },
        RpcLifecycleFailure::AuthLookupUnavailable => SessionNotification::Unavailable {
            reason: SessionUnavailableReason::AuthLookupUnavailable,
        },
        RpcLifecycleFailure::MessageSyncUnavailable => SessionNotification::Unavailable {
            reason: SessionUnavailableReason::MessageSyncUnavailable,
        },
    };
    match encode_session_notification(&notification) {
        Ok(text) => {
            let _ = sink.send_text(text).await;
        }
        Err(error) => tracing::error!(?error, "RPC session lifecycle serialization failed"),
    }
    shared.transport.close();
}
