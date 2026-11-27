use tokio::time::Instant;

use crate::rpc::{
    error::{RpcError, RpcErrorCode, RpcLifecycleFailure},
    protocol::{RpcOutcome, RpcResponse},
    AppState,
};

use super::{io::RpcIoError, MAX_FRAME_BYTES};

pub(super) struct PreparedResponse {
    pub(super) text: String,
    pub(super) success: bool,
    pub(super) oversized: bool,
    pub(super) lifecycle: Option<RpcLifecycleFailure>,
}

pub(super) fn prepare_response(response: RpcResponse) -> Result<PreparedResponse, RpcIoError> {
    let lifecycle = response.lifecycle_failure();
    let success = matches!(&response.outcome, RpcOutcome::Success { .. });
    let text = serde_json::to_string(&response).map_err(|error| {
        tracing::error!(?error, "RPC response serialization failed");
        RpcIoError::Closed
    })?;
    let oversized = text.len() > MAX_FRAME_BYTES;
    let (text, success, lifecycle) = if oversized {
        (
            serde_json::to_string(&RpcResponse::error(
                response.id,
                RpcError::new(RpcErrorCode::PayloadTooLarge),
            ))
            .map_err(|error| {
                tracing::error!(?error, "RPC oversized-result error serialization failed");
                RpcIoError::Closed
            })?,
            false,
            None,
        )
    } else {
        (text, success, lifecycle)
    };
    Ok(PreparedResponse {
        text,
        success,
        oversized,
        lifecycle,
    })
}

pub(super) fn prepare_recorded(
    services: &AppState,
    api: &'static str,
    started: Instant,
    response: Option<RpcResponse>,
    error: Option<RpcErrorCode>,
) -> Result<Option<PreparedResponse>, RpcIoError> {
    let prepared = response.map(prepare_response).transpose();
    let error = match &prepared {
        Err(_) => Some(RpcErrorCode::DispatcherInternal),
        Ok(Some(response)) if response.oversized => Some(RpcErrorCode::PayloadTooLarge),
        _ => error,
    };
    let (status, code) = error.map_or((axum::http::StatusCode::OK, "none"), |code| {
        (code.metric_status(), code.metric_code())
    });
    services
        .metrics
        .api
        .record("rpc", api, status, code, started.elapsed().as_secs_f64());
    prepared
}

pub(super) fn record_rejection(
    services: &AppState,
    api: &'static str,
    started: Instant,
    response: Option<RpcResponse>,
    code: RpcErrorCode,
) -> Result<Option<PreparedResponse>, RpcIoError> {
    prepare_recorded(services, api, started, response, Some(code))
}
