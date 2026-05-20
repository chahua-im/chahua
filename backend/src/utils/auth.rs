use axum::{
    extract::FromRequestParts,
    http::{header::AUTHORIZATION, request::Parts, HeaderMap, StatusCode},
};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::{fmt, sync::Once};

use crate::errors::AppError;
use crate::services::service_tokens::{self, AuthenticatedServiceToken};

pub const X_USER_ID: &str = "x-user-id";
pub const X_CLIENT_ID: &str = "x-client-id";
pub const X_APP_VERSION: &str = "x-app-version";

#[derive(Clone, Copy, Debug)]
pub struct CurrentUid(pub i32);

#[derive(Clone, Debug)]
pub struct ClientId(pub String);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthSource {
    Jwt,
    Legacy,
}

#[derive(Clone, Debug)]
pub struct AuthContext {
    pub uid: i32,
    pub client_id: Option<String>,
    pub source: AuthSource,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct ServiceTokenPrincipal {
    pub id: i64,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub enum Principal {
    User(AuthContext),
    ServiceToken(ServiceTokenPrincipal),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthClaims {
    pub uid: i32,
    pub cid: String,
    pub gen: i32,
}

impl fmt::Display for CurrentUid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

static JWT_CRYPTO_PROVIDER: Once = Once::new();

fn jwt_validation() -> Validation {
    let mut validation = Validation::default();
    validation.validate_exp = false;
    validation.required_spec_claims.clear();
    validation
}

fn ensure_jwt_crypto_provider() {
    JWT_CRYPTO_PROVIDER.call_once(|| {
        let _ = jsonwebtoken::crypto::rust_crypto::DEFAULT_PROVIDER.install_default();
    });
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
    if let Some(token) = bearer_token(headers)? {
        let claims = decode_auth_token(token, &state.jwt_signing_key)?;
        return Ok(AuthContext {
            uid: claims.uid,
            client_id: Some(claims.cid),
            source: AuthSource::Jwt,
        });
    }

    extract_legacy_auth_context(headers, state)
}

#[allow(dead_code)]
pub fn extract_principal(
    headers: &HeaderMap,
    state: &crate::AppState,
) -> Result<Principal, AppError> {
    if let Some(token) = bearer_token(headers).map_err(AppError::from)? {
        if token.starts_with(service_tokens::TOKEN_PREFIX) {
            let mut conn = state.db.get()?;
            let service_token =
                service_tokens::authenticate(&mut conn, &state.service_token_hash_key, token)?;
            return Ok(Principal::ServiceToken(ServiceTokenPrincipal::from(
                service_token,
            )));
        }
    }

    extract_auth_context(headers, state)
        .map(Principal::User)
        .map_err(AppError::from)
}

fn extract_legacy_auth_context(
    headers: &HeaderMap,
    state: &crate::AppState,
) -> Result<AuthContext, (StatusCode, &'static str)> {
    match state.auth_method {
        crate::AuthMethod::UIDHeader => {
            let value = headers
                .get(X_USER_ID)
                .and_then(|v| v.to_str().ok())
                .ok_or((
                    StatusCode::UNAUTHORIZED,
                    "Missing or invalid X-User-Id header",
                ))?;
            let uid = value
                .trim()
                .parse::<i32>()
                .map_err(|_| (StatusCode::UNAUTHORIZED, "X-User-Id must be a valid i32"))?;
            Ok(AuthContext {
                uid,
                client_id: None,
                source: AuthSource::Legacy,
            })
        }
        crate::AuthMethod::JwtOnly => Err((StatusCode::UNAUTHORIZED, "Missing auth token")),
    }
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

pub fn decode_auth_token(
    token: &str,
    jwt_signing_key: &[u8],
) -> Result<AuthClaims, (StatusCode, &'static str)> {
    ensure_jwt_crypto_provider();
    decode::<AuthClaims>(
        token,
        &DecodingKey::from_secret(jwt_signing_key),
        &jwt_validation(),
    )
    .map(|data| data.claims)
    .map_err(|_| (StatusCode::UNAUTHORIZED, "Invalid auth token"))
}

pub fn encode_auth_token(
    claims: &AuthClaims,
    jwt_signing_key: &[u8],
) -> Result<String, (StatusCode, &'static str)> {
    ensure_jwt_crypto_provider();
    encode(
        &Header::default(),
        claims,
        &EncodingKey::from_secret(jwt_signing_key),
    )
    .map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create auth token",
        )
    })
}

fn validate_client_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_'))
}

pub fn optional_client_id(
    headers: &HeaderMap,
) -> Result<Option<String>, (StatusCode, &'static str)> {
    match headers.get(X_CLIENT_ID) {
        None => Ok(None),
        Some(value) => {
            let value = value.to_str().map_err(|_| {
                (
                    StatusCode::BAD_REQUEST,
                    "Missing or invalid X-Client-Id header",
                )
            })?;
            let value = value.trim();
            if !validate_client_id(value) {
                return Err((StatusCode::BAD_REQUEST, "X-Client-Id is invalid"));
            }
            Ok(Some(value.to_string()))
        }
    }
}

pub fn resolve_client_id(
    headers: &HeaderMap,
    state: &crate::AppState,
) -> Result<Option<String>, (StatusCode, &'static str)> {
    let context = extract_auth_context(headers, state)?;
    match context.client_id {
        Some(client_id) => Ok(Some(client_id)),
        None => optional_client_id(headers),
    }
}

pub fn required_client_id(headers: &HeaderMap) -> Result<String, (StatusCode, &'static str)> {
    optional_client_id(headers)?.ok_or((StatusCode::BAD_REQUEST, "Missing X-Client-Id header"))
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
        extract_principal(&parts.headers, state)
    }
}

impl FromRequestParts<crate::AppState> for ClientId {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(
        parts: &mut Parts,
        state: &crate::AppState,
    ) -> Result<Self, Self::Rejection> {
        resolve_client_id(&parts.headers, state)?
            .ok_or((StatusCode::BAD_REQUEST, "Missing X-Client-Id header"))
            .map(ClientId)
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
    fn auth_token_round_trip_preserves_claims() {
        let claims = AuthClaims {
            uid: 42,
            cid: "client_123".to_string(),
            gen: 0,
        };

        let token = encode_auth_token(&claims, b"01234567890123456789012345678901").unwrap();
        let decoded = decode_auth_token(&token, b"01234567890123456789012345678901").unwrap();

        assert_eq!(decoded, claims);
    }

    #[test]
    fn auth_token_rejects_wrong_key() {
        let claims = AuthClaims {
            uid: 42,
            cid: "client_123".to_string(),
            gen: 0,
        };

        let token = encode_auth_token(&claims, b"01234567890123456789012345678901").unwrap();
        let result = decode_auth_token(&token, b"abcdefabcdefabcdefabcdefabcdefab");

        assert_eq!(
            result,
            Err((StatusCode::UNAUTHORIZED, "Invalid auth token"))
        );
    }

    #[test]
    fn optional_client_id_validates_shape() {
        let mut headers = HeaderMap::new();
        headers.insert(X_CLIENT_ID, HeaderValue::from_static("bad value"));

        let result = optional_client_id(&headers);

        assert_eq!(
            result,
            Err((StatusCode::BAD_REQUEST, "X-Client-Id is invalid"))
        );
    }
}
