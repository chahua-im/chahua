use crate::dto::ws::{OnlineClientConnectionResponse, OnlineClientStatus, TicketResponse};
use crate::errors::AppError;
use crate::services::auth_token::{AuthTokenService, VerifiedSession};
use crate::services::client_tracking::ClientTrackingService;
use crate::services::ws_registry::{AppPresenceState, ConnectionRegistry};

pub fn get_ws_ticket(
    session: &VerifiedSession,
    auth_token_service: &AuthTokenService,
) -> Result<TicketResponse, AppError> {
    let ticket = auth_token_service.issue_legacy_session(
        session.uid,
        &session.client_id,
        session.generation,
    )?;
    Ok(TicketResponse { ticket })
}

pub fn get_online_clients(
    session: &VerifiedSession,
    registry: &ConnectionRegistry,
    tracking: &ClientTrackingService,
) -> Result<Vec<OnlineClientConnectionResponse>, AppError> {
    let connections = registry.online_connections(session.uid);
    let mut client_ids = connections
        .iter()
        .map(|connection| connection.client_id.clone())
        .collect::<Vec<_>>();
    client_ids.sort_unstable();
    client_ids.dedup();
    let app_versions = tracking.last_app_versions(&client_ids)?;
    Ok(connections
        .into_iter()
        .map(|connection| OnlineClientConnectionResponse {
            connection_id: connection.connection_id,
            last_app_version: app_versions.get(&connection.client_id).cloned().flatten(),
            client_id: connection.client_id,
            status: match connection.app_state {
                AppPresenceState::Active => OnlineClientStatus::Active,
                AppPresenceState::Inactive => OnlineClientStatus::Inactive,
            },
        })
        .collect())
}
