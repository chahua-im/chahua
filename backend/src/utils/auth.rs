use axum::{
    extract::FromRequestParts,
    http::{header::AUTHORIZATION, request::Parts, HeaderMap, StatusCode},
};
use std::fmt;

use crate::errors::AppError;
use crate::services::auth_token::{AuthTokenError, VerifiedSession};
use crate::services::service_tokens::AuthenticatedServiceToken;
use crate::services::{authz, service_tokens, user};

pub const X_ON_BEHALF_OF: &str = "x-on-behalf-of";
pub const X_CLIENT_ID: &str = "x-client-id";
pub const X_APP_VERSION: &str = "x-app-version";

#[derive(Clone, Copy, Debug)]
pub struct CurrentUid(pub i32);
#[derive(Clone, Debug)]
pub struct ClientId(pub String);

#[derive(Clone, Debug)]
pub struct AuthContext {
    pub uid: i32,
    pub client_id: String,
}
#[derive(Clone, Debug)]
pub struct BearerSession(pub VerifiedSession);

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct ServiceTokenPrincipal {
    pub id: i64,
}

/// The entity a request executes on behalf of, after applying delegation.
#[derive(Clone, Debug)]
pub enum Principal {
    /// A user acting directly.
    User { uid: i32 },
    /// A service token acting for `uid`, named by the `X-On-Behalf-Of` header.
    ServiceOnBehalfOf {
        uid: i32,
        service_token: ServiceTokenPrincipal,
    },
    /// A service token acting on its own authority; no user behind the request.
    Service {
        service_token: ServiceTokenPrincipal,
    },
}

impl Principal {
    /// The user this request acts as, or `None` for a service token acting on
    /// its own authority.
    #[allow(dead_code)]
    pub fn uid(&self) -> Option<i32> {
        match self {
            Self::User { uid } | Self::ServiceOnBehalfOf { uid, .. } => Some(*uid),
            Self::Service { .. } => None,
        }
    }

    /// Require an acting user, and require this principal's authority to cover
    /// `action`. Returns the acting uid.
    pub fn require_user_action(
        &self,
        conn: &mut diesel::PgConnection,
        state: &crate::AppState,
        action: authz::Action,
    ) -> Result<i32, AppError> {
        match user_action_mode(self)? {
            UserActionMode::Direct(uid) => Ok(uid),
            UserActionMode::Delegated { uid, service_token } => {
                authorize_token(conn, state, service_token, action)?;
                if !user::lookup_user_profiles(conn, &[uid])?.contains_key(&uid) {
                    return Err(AppError::BadRequest("On-behalf-of user not found"));
                }
                tracing::info!(
                    service_token_id = service_token.id,
                    on_behalf_of_uid = uid,
                    action = action.as_str(),
                    "service token acting on behalf of user"
                );
                Ok(uid)
            }
        }
    }

    /// Require a service token acting on its own authority, and require it to
    /// hold `action`. Returns the token.
    pub fn require_service_action(
        &self,
        conn: &mut diesel::PgConnection,
        state: &crate::AppState,
        action: authz::Action,
    ) -> Result<&ServiceTokenPrincipal, AppError> {
        let service_token = service_action_token(self)?;
        authorize_token(conn, state, service_token, action)?;
        Ok(service_token)
    }
}

enum UserActionMode<'a> {
    Direct(i32),
    Delegated {
        uid: i32,
        service_token: &'a ServiceTokenPrincipal,
    },
}

fn user_action_mode(principal: &Principal) -> Result<UserActionMode<'_>, AppError> {
    match principal {
        Principal::User { uid } => Ok(UserActionMode::Direct(*uid)),
        Principal::Service { .. } => Err(AppError::BadRequest("X-On-Behalf-Of header is required")),
        Principal::ServiceOnBehalfOf { uid, service_token } => Ok(UserActionMode::Delegated {
            uid: *uid,
            service_token,
        }),
    }
}

fn service_action_token(principal: &Principal) -> Result<&ServiceTokenPrincipal, AppError> {
    match principal {
        Principal::User { .. } => Err(AppError::Forbidden("Service token required")),
        Principal::ServiceOnBehalfOf { .. } => Err(AppError::BadRequest(
            "X-On-Behalf-Of is not supported by this endpoint",
        )),
        Principal::Service { service_token } => Ok(service_token),
    }
}

fn authorize_token(
    conn: &mut diesel::PgConnection,
    state: &crate::AppState,
    service_token: &ServiceTokenPrincipal,
    action: authz::Action,
) -> Result<(), AppError> {
    state.authz_service.require_service_token_permission(
        conn,
        service_token.id,
        action,
        authz::Resource::Global,
    )
}

impl fmt::Display for CurrentUid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Verify a session JWT: signature and claims, then the user's required token
/// generation. Strict equality — a token minted before a revocation is rejected.
///
/// A failed generation lookup is a 503, not a 401: an outage must not look like
/// a revoked session to clients.
pub fn verify_session(
    token: &str,
    state: &crate::AppState,
) -> Result<VerifiedSession, (StatusCode, &'static str)> {
    let session = state
        .auth_token_service
        .verify(token)
        .map_err(AuthTokenError::into_rejection)?;
    let required = state
        .token_generation
        .required_for(&state.db, session.uid)
        .map_err(|err| {
            tracing::error!("token generation lookup failed: {:?}", err);
            (StatusCode::SERVICE_UNAVAILABLE, "Auth lookup unavailable")
        })?;
    if session.generation != required {
        return Err((StatusCode::UNAUTHORIZED, "Session revoked"));
    }
    Ok(session)
}

pub fn extract_current_uid(
    headers: &HeaderMap,
    state: &crate::AppState,
) -> Result<i32, (StatusCode, &'static str)> {
    extract_auth_context(headers, state).map(|context| context.uid)
}

pub fn extract_auth_context(
    headers: &HeaderMap,
    state: &crate::AppState,
) -> Result<AuthContext, (StatusCode, &'static str)> {
    let token = required_bearer_token(headers)?;
    let session = verify_session(token, state)?;
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

fn authenticate_credential(
    headers: &HeaderMap,
    state: &crate::AppState,
) -> Result<Credential, AppError> {
    if let Some(token) = bearer_token(headers).map_err(AppError::from)? {
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
    }

    extract_auth_context(headers, state)
        .map(Credential::User)
        .map_err(AppError::from)
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

fn bearer_token(headers: &HeaderMap) -> Result<Option<&str>, (StatusCode, &'static str)> {
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

pub fn is_valid_client_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_'))
}

pub fn resolve_client_id(
    headers: &HeaderMap,
    state: &crate::AppState,
) -> Result<String, (StatusCode, &'static str)> {
    Ok(extract_auth_context(headers, state)?.client_id)
}

impl FromRequestParts<crate::AppState> for BearerSession {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(
        parts: &mut Parts,
        state: &crate::AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = required_bearer_token(&parts.headers)?;
        verify_session(token, state).map(BearerSession)
    }
}

impl FromRequestParts<crate::AppState> for CurrentUid {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(
        parts: &mut Parts,
        state: &crate::AppState,
    ) -> Result<Self, Self::Rejection> {
        extract_current_uid(&parts.headers, state).map(CurrentUid)
    }
}

impl FromRequestParts<crate::AppState> for Principal {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &crate::AppState,
    ) -> Result<Self, Self::Rejection> {
        apply_delegation(
            authenticate_credential(&parts.headers, state)?,
            on_behalf_of_uid(&parts.headers)?,
        )
    }
}

impl FromRequestParts<crate::AppState> for ClientId {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(
        parts: &mut Parts,
        state: &crate::AppState,
    ) -> Result<Self, Self::Rejection> {
        resolve_client_id(&parts.headers, state).map(ClientId)
    }
}

impl From<AuthenticatedServiceToken> for ServiceTokenPrincipal {
    fn from(value: AuthenticatedServiceToken) -> Self {
        Self { id: value.id }
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

    #[test]
    fn user_action_mode_requires_delegation_for_service_identity() {
        let principal = Principal::Service {
            service_token: ServiceTokenPrincipal { id: 5 },
        };

        assert!(matches!(
            user_action_mode(&principal),
            Err(AppError::BadRequest("X-On-Behalf-Of header is required"))
        ));
    }

    #[test]
    fn service_action_mode_rejects_user_and_delegation() {
        let user = Principal::User { uid: 7 };
        assert!(matches!(
            service_action_token(&user),
            Err(AppError::Forbidden("Service token required"))
        ));

        let delegated = Principal::ServiceOnBehalfOf {
            uid: 7,
            service_token: ServiceTokenPrincipal { id: 5 },
        };
        assert!(matches!(
            service_action_token(&delegated),
            Err(AppError::BadRequest(
                "X-On-Behalf-Of is not supported by this endpoint"
            ))
        ));
    }
}
