use std::sync::Once;
use std::time::{SystemTime, UNIX_EPOCH};

use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::errors::AppError;

pub const JWT_V2_KEY_ID: &str = "v2-1";

const JWT_VERSION_V2: u8 = 2;
const MAX_FUTURE_IAT_SECONDS: u64 = 60;

static JWT_CRYPTO_PROVIDER: Once = Once::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenVersion {
    Legacy,
    V2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedSession {
    pub uid: i32,
    pub client_id: String,
    pub generation: i32,
    pub version: TokenVersion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthTokenError {
    InvalidToken,
    IssueFailed,
}

impl AuthTokenError {
    pub fn into_rejection(self) -> (axum::http::StatusCode, &'static str) {
        match self {
            Self::InvalidToken => (axum::http::StatusCode::UNAUTHORIZED, "Invalid auth token"),
            Self::IssueFailed => (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to create auth token",
            ),
        }
    }
}

impl From<AuthTokenError> for AppError {
    fn from(value: AuthTokenError) -> Self {
        match value {
            AuthTokenError::InvalidToken => AppError::Unauthorized("Invalid auth token"),
            AuthTokenError::IssueFailed => AppError::Internal("Failed to create auth token"),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct LegacyClaims {
    /// Application user ID represented by the session.
    uid: i32,
    /// Client installation ID bound to the session.
    cid: String,
    /// User-wide token generation captured when the session was issued.
    gen: i32,
}

#[derive(Serialize)]
struct LegacyClaimsRef<'a> {
    /// Application user ID represented by the session.
    uid: i32,
    /// Client installation ID bound to the session.
    cid: &'a str,
    /// User-wide token generation captured when the session was issued.
    gen: i32,
}

#[derive(Debug, Deserialize)]
struct SessionClaimsV2 {
    /// Token schema version; must be `2`.
    ver: u8,
    /// Application user ID represented by the session.
    uid: i32,
    /// Client installation ID bound to the session.
    cid: String,
    /// User-wide token generation captured when the session was issued.
    gen: i32,
    /// Token issuance time as seconds since the Unix epoch.
    iat: u64,
}

#[derive(Serialize)]
struct SessionClaimsV2Ref<'a> {
    /// Token schema version; always `2`.
    ver: u8,
    /// Application user ID represented by the session.
    uid: i32,
    /// Client installation ID bound to the session.
    cid: &'a str,
    /// User-wide token generation captured when the session was issued.
    gen: i32,
    /// Token issuance time as seconds since the Unix epoch.
    iat: u64,
}

pub struct AuthTokenService {
    encoding_key: EncodingKey,
    decoding_key: DecodingKey,
}

impl AuthTokenService {
    pub fn new(signing_key: &[u8]) -> Self {
        ensure_jwt_crypto_provider();
        Self {
            encoding_key: EncodingKey::from_secret(signing_key),
            decoding_key: DecodingKey::from_secret(signing_key),
        }
    }

    pub fn verify(&self, token: &str) -> Result<VerifiedSession, AuthTokenError> {
        let data = decode::<Value>(token, &self.decoding_key, &jwt_validation())
            .map_err(|_| AuthTokenError::InvalidToken)?;
        let has_version = data
            .claims
            .as_object()
            .is_some_and(|claims| claims.contains_key("ver"));

        if has_version {
            if data.header.kid.as_deref() != Some(JWT_V2_KEY_ID) {
                return Err(AuthTokenError::InvalidToken);
            }
            let claims: SessionClaimsV2 =
                serde_json::from_value(data.claims).map_err(|_| AuthTokenError::InvalidToken)?;
            validate_v2_claims(&claims)?;
            return Ok(VerifiedSession {
                uid: claims.uid,
                client_id: claims.cid,
                generation: claims.gen,
                version: TokenVersion::V2,
            });
        }

        if data.header.kid.as_deref() == Some(JWT_V2_KEY_ID) {
            return Err(AuthTokenError::InvalidToken);
        }
        let claims: LegacyClaims =
            serde_json::from_value(data.claims).map_err(|_| AuthTokenError::InvalidToken)?;
        Ok(VerifiedSession {
            uid: claims.uid,
            client_id: claims.cid,
            generation: claims.gen,
            version: TokenVersion::Legacy,
        })
    }

    pub fn issue_session(
        &self,
        uid: i32,
        client_id: &str,
        generation: i32,
    ) -> Result<String, AuthTokenError> {
        let claims = SessionClaimsV2Ref {
            ver: JWT_VERSION_V2,
            uid,
            cid: client_id,
            gen: generation,
            iat: unix_timestamp(),
        };
        let mut header = Header::new(Algorithm::HS256);
        header.kid = Some(JWT_V2_KEY_ID.to_string());
        encode(&header, &claims, &self.encoding_key).map_err(|_| AuthTokenError::IssueFailed)
    }

    /// Compatibility-only issuer for existing endpoints. New code must issue v2 sessions.
    pub fn issue_legacy_session(
        &self,
        uid: i32,
        client_id: &str,
        generation: i32,
    ) -> Result<String, AuthTokenError> {
        let claims = LegacyClaimsRef {
            uid,
            cid: client_id,
            gen: generation,
        };
        encode(&Header::new(Algorithm::HS256), &claims, &self.encoding_key)
            .map_err(|_| AuthTokenError::IssueFailed)
    }
}

fn jwt_validation() -> Validation {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = false;
    validation.validate_aud = false;
    validation.required_spec_claims.clear();
    validation
}

fn validate_v2_claims(claims: &SessionClaimsV2) -> Result<(), AuthTokenError> {
    if claims.ver != JWT_VERSION_V2
        || claims.gen < 0
        || claims.iat > unix_timestamp().saturating_add(MAX_FUTURE_IAT_SECONDS)
    {
        return Err(AuthTokenError::InvalidToken);
    }
    Ok(())
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn ensure_jwt_crypto_provider() {
    JWT_CRYPTO_PROVIDER.call_once(|| {
        let _ = jsonwebtoken::crypto::rust_crypto::DEFAULT_PROVIDER.install_default();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TEST_KEY: &[u8] = b"01234567890123456789012345678901";
    const WRONG_KEY: &[u8] = b"abcdefabcdefabcdefabcdefabcdefab";

    #[test]
    fn legacy_session_round_trip() {
        let service = AuthTokenService::new(TEST_KEY);
        let token = service.issue_legacy_session(42, "client_123", 7).unwrap();

        assert_eq!(
            service.verify(&token).unwrap(),
            VerifiedSession {
                uid: 42,
                client_id: "client_123".to_string(),
                generation: 7,
                version: TokenVersion::Legacy,
            }
        );
    }

    #[test]
    fn v2_session_round_trip_preserves_generation() {
        let service = AuthTokenService::new(TEST_KEY);
        let token = service.issue_session(99, "client-abc", 3).unwrap();

        assert_eq!(
            service.verify(&token).unwrap(),
            VerifiedSession {
                uid: 99,
                client_id: "client-abc".to_string(),
                generation: 3,
                version: TokenVersion::V2,
            }
        );
    }

    #[test]
    fn rejects_token_signed_with_wrong_key() {
        let issuer = AuthTokenService::new(TEST_KEY);
        let verifier = AuthTokenService::new(WRONG_KEY);
        let token = issuer.issue_session(42, "client_123", 0).unwrap();

        assert_eq!(verifier.verify(&token), Err(AuthTokenError::InvalidToken));
    }

    #[test]
    fn rejects_present_null_version_instead_of_falling_back() {
        let service = AuthTokenService::new(TEST_KEY);
        let token = encode_value(json!({"ver": null, "uid": 1, "cid": "c", "gen": 0}), None);

        assert_eq!(service.verify(&token), Err(AuthTokenError::InvalidToken));
    }

    #[test]
    fn rejects_v2_without_iat() {
        let service = AuthTokenService::new(TEST_KEY);
        let token = encode_value(
            json!({
                "ver": 2,
                "uid": 1,
                "cid": "c",
                "gen": 0
            }),
            Some(JWT_V2_KEY_ID),
        );

        assert_eq!(service.verify(&token), Err(AuthTokenError::InvalidToken));
    }

    #[test]
    fn rejects_v2_with_negative_generation() {
        let service = AuthTokenService::new(TEST_KEY);
        let token = encode_value(
            json!({
                "ver": 2,
                "uid": 1,
                "cid": "c",
                "gen": -1,
                "iat": unix_timestamp()
            }),
            Some(JWT_V2_KEY_ID),
        );

        assert_eq!(service.verify(&token), Err(AuthTokenError::InvalidToken));
    }

    #[test]
    fn rejects_v2_without_expected_key_id() {
        let service = AuthTokenService::new(TEST_KEY);
        let token = encode_value(
            json!({
                "ver": 2,
                "uid": 1,
                "cid": "c",
                "gen": 0,
                "iat": unix_timestamp()
            }),
            None,
        );

        assert_eq!(service.verify(&token), Err(AuthTokenError::InvalidToken));
    }

    #[test]
    fn rejects_materially_future_iat() {
        let service = AuthTokenService::new(TEST_KEY);
        let token = encode_value(
            json!({
                "ver": 2,
                "uid": 1,
                "cid": "c",
                "gen": 0,
                "iat": unix_timestamp() + MAX_FUTURE_IAT_SECONDS + 1
            }),
            Some(JWT_V2_KEY_ID),
        );

        assert_eq!(service.verify(&token), Err(AuthTokenError::InvalidToken));
    }

    fn encode_value(claims: Value, kid: Option<&str>) -> String {
        ensure_jwt_crypto_provider();
        let mut header = Header::new(Algorithm::HS256);
        header.kid = kid.map(str::to_string);
        encode(&header, &claims, &EncodingKey::from_secret(TEST_KEY)).unwrap()
    }
}
