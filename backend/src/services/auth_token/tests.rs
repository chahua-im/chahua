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

#[test]
fn verifier_instrumentation_is_per_service_instance() {
    let first = AuthTokenService::new(TEST_KEY);
    let second = AuthTokenService::new(TEST_KEY);
    let token = first.issue_session(7, "client-7", 0).unwrap();

    first.verify(&token).unwrap();
    assert_eq!(first.verifier_invocations(), 1);
    assert_eq!(second.verifier_invocations(), 0);

    second.verify(&token).unwrap();
    assert_eq!(first.verifier_invocations(), 1);
    assert_eq!(second.verifier_invocations(), 1);
}

fn encode_value(claims: Value, kid: Option<&str>) -> String {
    ensure_jwt_crypto_provider();
    let mut header = Header::new(Algorithm::HS256);
    header.kid = kid.map(str::to_string);
    encode(&header, &claims, &EncodingKey::from_secret(TEST_KEY)).unwrap()
}
