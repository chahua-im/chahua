use axum::{
    extract::FromRequestParts,
    http::{header::AUTHORIZATION, request::Parts, HeaderMap, StatusCode},
};
use std::fmt;

use crate::errors::AppError;
use crate::services::auth_token::VerifiedSession;
use crate::services::authentication::{
    verify_session, AuthContext, Principal, ServiceTokenPrincipal,
};
use crate::services::service_tokens;

pub const X_ON_BEHALF_OF: &str = "x-on-behalf-of";
pub const X_CLIENT_ID: &str = "x-client-id";
pub const X_APP_VERSION: &str = "x-app-version";

#[derive(Clone, Copy, Debug)]
pub struct CurrentUid(pub i32);
#[derive(Clone, Debug)]
pub struct ClientId(pub String);

#[derive(Clone, Debug)]
pub struct BearerSession(pub VerifiedSession);

impl fmt::Display for CurrentUid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

fn auth_error_rejection(error: AppError) -> (StatusCode, &'static str) {
    match error {
        AppError::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
        AppError::PayloadTooLarge(message) => (StatusCode::PAYLOAD_TOO_LARGE, message),
        AppError::Unauthorized(message) => (StatusCode::UNAUTHORIZED, message),
        AppError::Forbidden(message) => (StatusCode::FORBIDDEN, message),
        AppError::SpeakingRestricted(_) => (StatusCode::FORBIDDEN, "Speaking is restricted"),
        AppError::NotFound(message) => (StatusCode::NOT_FOUND, message),
        AppError::Conflict(message) => (StatusCode::CONFLICT, message),
        AppError::Gone(message) => (StatusCode::GONE, message),
        AppError::ServiceUnavailable(message) => (StatusCode::SERVICE_UNAVAILABLE, message),
        AppError::DbPool(_) | AppError::DbQuery(_) => {
            (StatusCode::INTERNAL_SERVER_ERROR, "Database error")
        }
        AppError::Internal(message) => (StatusCode::INTERNAL_SERVER_ERROR, message),
    }
}

fn verified_session(
    token: &str,
    state: &crate::AppState,
) -> Result<VerifiedSession, (StatusCode, &'static str)> {
    verify_session(
        token,
        &state.auth_token_service,
        &state.token_generation,
        &state.db,
    )
    .map_err(auth_error_rejection)
}

pub fn extract_auth_context(
    headers: &HeaderMap,
    state: &crate::AppState,
) -> Result<AuthContext, (StatusCode, &'static str)> {
    let token = required_bearer_token(headers)?;
    let session = verified_session(token, state)?;
    Ok(AuthContext {
        uid: session.uid,
        client_id: session.client_id,
    })
}

/// What the `Authorization` header authenticated, before delegation is applied.
enum Credential {
    User(AuthContext),
    ServiceToken(ServiceTokenPrincipal),
}

fn authenticate_credential(token: &str, state: &crate::AppState) -> Result<Credential, AppError> {
    if token.starts_with(service_tokens::TOKEN_PREFIX) {
        let mut conn = state.db.get()?;
        let service_token = service_tokens::authenticate(
            &mut conn,
            &state.config.auth.service_token_hash_key,
            token,
        )?;
        return Ok(Credential::ServiceToken(ServiceTokenPrincipal::from(
            service_token,
        )));
    }

    let session = verified_session(token, state).map_err(AppError::from)?;
    Ok(Credential::User(AuthContext {
        uid: session.uid,
        client_id: session.client_id,
    }))
}

/// Apply the `X-On-Behalf-Of` header to an authenticated credential.
fn apply_delegation(
    credential: Credential,
    on_behalf_of: Option<i32>,
) -> Result<Principal, AppError> {
    match (credential, on_behalf_of) {
        (Credential::User(_), Some(_)) => {
            Err(AppError::Forbidden("On-behalf-of requires a service token"))
        }
        (Credential::User(ctx), None) => Ok(Principal::User { uid: ctx.uid }),
        (Credential::ServiceToken(service_token), Some(uid)) => {
            Ok(Principal::ServiceOnBehalfOf { uid, service_token })
        }
        (Credential::ServiceToken(service_token), None) => Ok(Principal::Service { service_token }),
    }
}

fn on_behalf_of_uid(headers: &HeaderMap) -> Result<Option<i32>, AppError> {
    let Some(value) = headers.get(X_ON_BEHALF_OF) else {
        return Ok(None);
    };
    let uid = value
        .to_str()
        .ok()
        .and_then(|value| value.trim().parse::<i32>().ok())
        .filter(|uid| *uid > 0)
        .ok_or(AppError::BadRequest(
            "X-On-Behalf-Of must be a positive i32",
        ))?;
    Ok(Some(uid))
}

pub(crate) fn bearer_token(
    headers: &HeaderMap,
) -> Result<Option<&str>, (StatusCode, &'static str)> {
    let Some(value) = headers.get(AUTHORIZATION) else {
        return Ok(None);
    };

    let value = value
        .to_str()
        .map_err(|_| (StatusCode::UNAUTHORIZED, "Invalid Authorization header"))?;
    let token = value
        .strip_prefix("Bearer ")
        .ok_or((StatusCode::UNAUTHORIZED, "Invalid Authorization header"))?
        .trim();

    if token.is_empty() {
        return Err((StatusCode::UNAUTHORIZED, "Invalid Authorization header"));
    }

    Ok(Some(token))
}

fn required_bearer_token(headers: &HeaderMap) -> Result<&str, (StatusCode, &'static str)> {
    bearer_token(headers)?.ok_or((StatusCode::UNAUTHORIZED, "Missing auth token"))
}

impl FromRequestParts<crate::AppState> for BearerSession {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(
        parts: &mut Parts,
        state: &crate::AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = required_bearer_token(&parts.headers)?.to_owned();
        let state = state.clone();
        tokio::task::spawn_blocking(move || verified_session(&token, &state).map(BearerSession))
            .await
            .map_err(|error| {
                tracing::error!(?error, "bearer authentication worker failed");
                auth_error_rejection(AppError::Internal("Authentication worker failed"))
            })?
    }
}

impl FromRequestParts<crate::AppState> for CurrentUid {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(
        parts: &mut Parts,
        state: &crate::AppState,
    ) -> Result<Self, Self::Rejection> {
        BearerSession::from_request_parts(parts, state)
            .await
            .map(|BearerSession(session)| CurrentUid(session.uid))
    }
}

impl FromRequestParts<crate::AppState> for Principal {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &crate::AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = required_bearer_token(&parts.headers)
            .map_err(AppError::from)?
            .to_owned();
        let delegation = on_behalf_of_uid(&parts.headers);
        let state = state.clone();
        tokio::task::spawn_blocking(move || {
            apply_delegation(authenticate_credential(&token, &state)?, delegation?)
        })
        .await
        .map_err(|error| {
            tracing::error!(?error, "principal authentication worker failed");
            AppError::Internal("Authentication worker failed")
        })?
    }
}

impl FromRequestParts<crate::AppState> for ClientId {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(
        parts: &mut Parts,
        state: &crate::AppState,
    ) -> Result<Self, Self::Rejection> {
        BearerSession::from_request_parts(parts, state)
            .await
            .map(|BearerSession(session)| ClientId(session.client_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderValue, StatusCode};

    #[test]
    fn bearer_token_requires_bearer_prefix() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Token abc"));

        let result = bearer_token(&headers);

        assert_eq!(
            result,
            Err((StatusCode::UNAUTHORIZED, "Invalid Authorization header"))
        );
    }

    #[test]
    fn required_bearer_token_rejects_missing_authorization() {
        assert_eq!(
            required_bearer_token(&HeaderMap::new()),
            Err((StatusCode::UNAUTHORIZED, "Missing auth token"))
        );
    }

    #[test]
    fn apply_delegation_keeps_direct_jwt_user_identity() {
        let principal = apply_delegation(
            Credential::User(AuthContext {
                uid: 7,
                client_id: "client-7".to_string(),
            }),
            None,
        )
        .unwrap();

        assert!(matches!(&principal, Principal::User { uid: 7 }));
        assert_eq!(principal.uid(), Some(7));
    }

    #[test]
    fn apply_delegation_rejects_jwt_user_delegation() {
        let result = apply_delegation(
            Credential::User(AuthContext {
                uid: 7,
                client_id: "client-7".to_string(),
            }),
            Some(9),
        );

        assert!(matches!(
            result,
            Err(AppError::Forbidden("On-behalf-of requires a service token"))
        ));
    }

    #[test]
    fn apply_delegation_models_service_delegation() {
        let principal = apply_delegation(
            Credential::ServiceToken(ServiceTokenPrincipal { id: 5 }),
            Some(9),
        )
        .unwrap();

        assert!(matches!(
            &principal,
            Principal::ServiceOnBehalfOf {
                uid: 9,
                service_token: ServiceTokenPrincipal { id: 5 },
            }
        ));
        assert_eq!(principal.uid(), Some(9));
    }

    #[test]
    fn apply_delegation_models_service_identity() {
        let principal = apply_delegation(
            Credential::ServiceToken(ServiceTokenPrincipal { id: 5 }),
            None,
        )
        .unwrap();

        assert!(matches!(
            &principal,
            Principal::Service {
                service_token: ServiceTokenPrincipal { id: 5 },
            }
        ));
        assert_eq!(principal.uid(), None);
    }

    #[test]
    fn on_behalf_of_uid_validates_header() {
        assert_eq!(on_behalf_of_uid(&HeaderMap::new()).unwrap(), None);

        let mut headers = HeaderMap::new();
        headers.insert(X_ON_BEHALF_OF, HeaderValue::from_static(" 42 "));
        assert_eq!(on_behalf_of_uid(&headers).unwrap(), Some(42));

        for value in ["abc", "0", "-3"] {
            headers.insert(X_ON_BEHALF_OF, HeaderValue::from_static(value));
            assert!(matches!(
                on_behalf_of_uid(&headers),
                Err(AppError::BadRequest(
                    "X-On-Behalf-Of must be a positive i32"
                ))
            ));
        }
    }
}
