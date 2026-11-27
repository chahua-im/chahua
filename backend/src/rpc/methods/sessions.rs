use crate::dto::rpc::sessions::SessionsListClientsParams;
use crate::dto::ws::OnlineClientConnectionResponse;
use crate::errors::AppError;
use crate::rpc::{AppState, RpcCallContext};

pub async fn list_clients(
    context: &RpcCallContext,
    services: &AppState,
    _: SessionsListClientsParams,
) -> Result<Vec<OnlineClientConnectionResponse>, AppError> {
    crate::services::api::ws::get_online_clients(
        context.verified_session()?,
        services.ws_registry.as_ref(),
        services.client_tracking.as_ref(),
    )
}
