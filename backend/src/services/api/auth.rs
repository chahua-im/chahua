use std::sync::Arc;

use crate::config::AppConfig;
use crate::dto::auth::{AuthTokenResponse, DevSessionRequest};
use crate::errors::AppError;
use crate::services::auth_token::{AuthTokenService, TokenVersion, VerifiedSession};
use crate::services::authentication::is_valid_client_id;
use crate::services::token_generation::TokenGenerationService;
use crate::state::DbPool;

pub struct PostDevSessionDeps<'a> {
    pub config: &'a Arc<AppConfig>,
    pub auth_token_service: &'a Arc<AuthTokenService>,
    pub token_generation: &'a Arc<TokenGenerationService>,
    pub db: &'a DbPool,
}

/// The issuer's known identity can be bound directly without verifying its own JWT.
pub struct DevSessionIssued {
    pub response: AuthTokenResponse,
    pub session: VerifiedSession,
}

pub fn post_refresh(
    session: &VerifiedSession,
    auth_token_service: &AuthTokenService,
) -> Result<AuthTokenResponse, AppError> {
    let token =
        auth_token_service.issue_session(session.uid, &session.client_id, session.generation)?;
    Ok(AuthTokenResponse { token })
}

pub fn post_dev_session(
    request: DevSessionRequest,
    client_id: Option<String>,
    deps: PostDevSessionDeps<'_>,
) -> Result<DevSessionIssued, AppError> {
    if !deps.config.auth.debug_auth_enabled {
        return Err(AppError::NotFound("Not found"));
    }
    if request.uid <= 0 {
        return Err(AppError::BadRequest("UID must be a positive i32"));
    }
    let client_id = dev_session_client_id(client_id)?;
    let generation = deps.token_generation.required_for(deps.db, request.uid)?;
    let session = VerifiedSession {
        uid: request.uid,
        client_id,
        generation,
        version: TokenVersion::V2,
    };
    let response = post_refresh(&session, deps.auth_token_service)?;
    Ok(DevSessionIssued { response, session })
}

fn dev_session_client_id(value: Option<String>) -> Result<String, AppError> {
    let value = value.ok_or(AppError::BadRequest("Missing X-Client-Id header"))?;
    if !is_valid_client_id(value.trim()) {
        return Ok(uuid::Uuid::new_v4().to_string());
    }
    if value.trim().len() == value.len() {
        Ok(value)
    } else {
        Ok(value.trim().to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_client_id_preserves_valid_values_and_replaces_malformed_values() {
        assert_eq!(
            dev_session_client_id(Some("client-7".into())).unwrap(),
            "client-7"
        );
        assert_eq!(
            dev_session_client_id(Some(" client-7 ".into())).unwrap(),
            "client-7"
        );
        let generated = dev_session_client_id(Some("invalid client id".into())).unwrap();
        assert!(uuid::Uuid::parse_str(&generated).is_ok());
        assert!(matches!(
            dev_session_client_id(None),
            Err(AppError::BadRequest("Missing X-Client-Id header"))
        ));
    }
}
