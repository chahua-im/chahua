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
