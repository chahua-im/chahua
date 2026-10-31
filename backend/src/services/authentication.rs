use diesel::PgConnection;

use crate::errors::AppError;
use crate::services::auth_token::{AuthTokenService, VerifiedSession};
use crate::services::authz::{self, AuthorizationService};
use crate::services::service_tokens::AuthenticatedServiceToken;
use crate::services::{token_generation::TokenGenerationService, user};
use crate::state::DbPool;

#[derive(Clone, Debug)]
pub struct AuthContext {
    pub uid: i32,
    pub client_id: String,
}

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
        conn: &mut PgConnection,
        authz_service: &AuthorizationService,
        action: authz::Action,
    ) -> Result<i32, AppError> {
        match user_action_mode(self)? {
            UserActionMode::Direct(uid) => Ok(uid),
            UserActionMode::Delegated { uid, service_token } => {
                authorize_token(conn, authz_service, service_token, action)?;
                if !user::lookup_user_profiles(conn, &[uid])?.contains_key(&uid) {
                    return Err(AppError::BadRequest("On-behalf-of user not found"));
                }
                Ok(uid)
            }
        }
    }

    /// Require a service token acting on its own authority, and require it to
    /// hold `action`. Returns the token.
    pub fn require_service_action(
        &self,
        conn: &mut PgConnection,
        authz_service: &AuthorizationService,
        action: authz::Action,
    ) -> Result<&ServiceTokenPrincipal, AppError> {
        let service_token = service_action_token(self)?;
        authorize_token(conn, authz_service, service_token, action)?;
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
    conn: &mut PgConnection,
    authz_service: &AuthorizationService,
    service_token: &ServiceTokenPrincipal,
    action: authz::Action,
) -> Result<(), AppError> {
    authz_service.require_service_token_permission(
        conn,
        service_token.id,
        action,
        authz::Resource::Global,
    )
}

/// Failure classes for a retained-session generation lookup.
///
/// This keeps session lifecycle decisions independent from public error text:
/// revocation closes an RPC session, while an unavailable lookup asks the
/// client to reconnect without discarding its credential.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionGenerationFailure {
    Revoked,
    LookupUnavailable,
}

impl SessionGenerationFailure {
    pub const fn into_app_error(self) -> AppError {
        match self {
            Self::Revoked => AppError::Unauthorized("Session revoked"),
            Self::LookupUnavailable => AppError::ServiceUnavailable("Auth lookup unavailable"),
        }
    }
}

/// Verify a session JWT: signature and claims, then the user's required token
/// generation. Strict equality — a token minted before a revocation is rejected.
///
/// A failed generation lookup is unavailable, not unauthorized: an outage must
/// not look like a revoked session to callers.
pub fn verify_session(
    token: &str,
    auth_token_service: &AuthTokenService,
    token_generation: &TokenGenerationService,
    db: &DbPool,
) -> Result<VerifiedSession, AppError> {
    let session = auth_token_service.verify(token)?;
    check_session_generation(&session, token_generation, db)?;
    Ok(session)
}

/// Returns a typed cause so transport session engines can make lifecycle
/// decisions without inferring semantics from an application's public message.
pub fn check_session_generation_cause(
    session: &VerifiedSession,
    token_generation: &TokenGenerationService,
    db: &DbPool,
) -> Result<(), SessionGenerationFailure> {
    let required = token_generation
        .required_for(db, session.uid)
        .map_err(|err| {
            tracing::error!("token generation lookup failed: {:?}", err);
            SessionGenerationFailure::LookupUnavailable
        })?;
    if session.generation != required {
        return Err(SessionGenerationFailure::Revoked);
    }
    Ok(())
}

/// Check revocation for a retained identity without repeating JWT verification.
pub fn check_session_generation(
    session: &VerifiedSession,
    token_generation: &TokenGenerationService,
    db: &DbPool,
) -> Result<(), AppError> {
    check_session_generation_cause(session, token_generation, db)
        .map_err(SessionGenerationFailure::into_app_error)
}

impl From<AuthenticatedServiceToken> for ServiceTokenPrincipal {
    fn from(value: AuthenticatedServiceToken) -> Self {
        Self { id: value.id }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
pub fn is_valid_client_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_'))
}
