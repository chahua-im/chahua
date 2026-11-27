use tokio::sync::oneshot;

use crate::dto::auth::AuthTokenResponse;
use crate::dto::message_sync::{MessageSyncPageParams, MessageSyncResumeParams};
use crate::dto::rpc::session::EmptyResult;
use crate::dto::rpc::{
    auth::{AuthCreateDevSessionParams, AuthRefreshParams},
    conversations::{ConversationsWatchStatesParams, ConversationsWatchUnreadParams},
    presence::PresenceWatchParams,
    session::{SessionOpenParams, SessionOpenResult, SessionPingParams, SessionSetAppStateParams},
};
use crate::rpc::error::{RpcError, RpcErrorCode};
use crate::rpc::session::{ControlReply, RpcControlCommand};
use crate::rpc::{AppState, RpcCallContext};

async fn command<T>(
    context: &RpcCallContext,
    make: impl FnOnce(ControlReply<T>) -> RpcControlCommand,
) -> Result<T, RpcError> {
    let (reply, result) = oneshot::channel();
    let command = make(reply);
    if let Some(slot) = &context.sync_control {
        slot.send(command);
    } else {
        match context.controls.try_send(command) {
            Ok(()) => {}
            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                if let Some(close_session) = &context.close_session {
                    close_session.close();
                }
                return Err(RpcError::new(RpcErrorCode::Overloaded));
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                return Err(RpcError::with_message(
                    RpcErrorCode::Unavailable,
                    "Session unavailable",
                ));
            }
        }
    }
    let outcome = result
        .await
        .map_err(|_| RpcError::with_message(RpcErrorCode::Unavailable, "Session unavailable"))?;
    if context.rpc_id.is_none() {
        if let Err(error) = &outcome {
            if let (Some(failure), Some(guard_failures)) =
                (error.lifecycle_failure(), &context.guard_failures)
            {
                let _ = guard_failures.send(failure);
            }
        }
    }
    outcome
}

pub async fn open(
    context: &RpcCallContext,
    _services: &AppState,
    params: SessionOpenParams,
) -> Result<SessionOpenResult, RpcError> {
    command(context, |reply| RpcControlCommand::Open { params, reply }).await
}

pub async fn message_sync_resume(
    context: &RpcCallContext,
    _services: &AppState,
    params: MessageSyncResumeParams,
) -> Result<EmptyResult, RpcError> {
    command(context, |reply| RpcControlCommand::MessageSyncResume {
        sync_seq: context
            .sync_control
            .as_ref()
            .expect("sync control slot")
            .seq,
        params,
        reply,
    })
    .await
}

pub async fn message_sync_page(
    context: &RpcCallContext,
    _services: &AppState,
    params: MessageSyncPageParams,
) -> Result<EmptyResult, RpcError> {
    command(context, |reply| RpcControlCommand::MessageSyncPage {
        sync_seq: context
            .sync_control
            .as_ref()
            .expect("sync control slot")
            .seq,
        params,
        reply,
    })
    .await
}

pub async fn create_dev_session(
    context: &RpcCallContext,
    _services: &AppState,
    params: AuthCreateDevSessionParams,
) -> Result<AuthTokenResponse, RpcError> {
    command(context, |reply| RpcControlCommand::CreateDevSession {
        params,
        reply,
    })
    .await
}

pub async fn refresh(
    context: &RpcCallContext,
    _services: &AppState,
    _params: AuthRefreshParams,
) -> Result<AuthTokenResponse, RpcError> {
    command(context, |reply| RpcControlCommand::Refresh { reply }).await
}

pub async fn ping(
    context: &RpcCallContext,
    _services: &AppState,
    params: SessionPingParams,
) -> Result<(), RpcError> {
    command(context, |reply| RpcControlCommand::Ping { params, reply }).await
}

pub async fn set_app_state(
    context: &RpcCallContext,
    _services: &AppState,
    params: SessionSetAppStateParams,
) -> Result<(), RpcError> {
    command(context, |reply| RpcControlCommand::SetAppState {
        params,
        reply,
    })
    .await
}

pub async fn watch_presence(
    context: &RpcCallContext,
    _services: &AppState,
    params: PresenceWatchParams,
) -> Result<(), RpcError> {
    command(context, |reply| RpcControlCommand::WatchPresence {
        params,
        reply,
    })
    .await
}

pub async fn watch_unread(
    context: &RpcCallContext,
    _services: &AppState,
    params: ConversationsWatchUnreadParams,
) -> Result<(), RpcError> {
    command(context, |reply| RpcControlCommand::WatchUnread {
        params,
        reply,
    })
    .await
}

pub async fn watch_states(
    context: &RpcCallContext,
    _services: &AppState,
    params: ConversationsWatchStatesParams,
) -> Result<(), RpcError> {
    command(context, |reply| RpcControlCommand::WatchStates {
        params,
        reply,
    })
    .await
}
