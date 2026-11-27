use super::AppError;
use axum::http::StatusCode;
use axum::response::IntoResponse;

#[tokio::test]
async fn public_errors_preserve_plain_text_bodies_and_statuses() {
    let cases = [
        (
            AppError::BadRequest("bad input"),
            StatusCode::BAD_REQUEST,
            "bad input",
        ),
        (
            AppError::Unauthorized("Session revoked"),
            StatusCode::UNAUTHORIZED,
            "Session revoked",
        ),
        (
            AppError::Forbidden("forbidden"),
            StatusCode::FORBIDDEN,
            "forbidden",
        ),
        (
            AppError::NotFound("missing"),
            StatusCode::NOT_FOUND,
            "missing",
        ),
        (
            AppError::Conflict("conflict"),
            StatusCode::CONFLICT,
            "conflict",
        ),
        (AppError::Gone("gone"), StatusCode::GONE, "gone"),
        (
            AppError::PayloadTooLarge("too large"),
            StatusCode::PAYLOAD_TOO_LARGE,
            "too large",
        ),
        (
            AppError::ServiceUnavailable("Auth lookup unavailable"),
            StatusCode::SERVICE_UNAVAILABLE,
            "Auth lookup unavailable",
        ),
        (
            AppError::Internal("internal"),
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
        ),
        (
            AppError::DbQuery(diesel::result::Error::NotFound),
            StatusCode::INTERNAL_SERVER_ERROR,
            "Database error",
        ),
    ];
    for (error, status, text) in cases {
        let response = error.into_response();
        assert_eq!(response.status(), status);
        assert_eq!(
            response.headers()[axum::http::header::CONTENT_TYPE],
            "text/plain; charset=utf-8"
        );
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(body.as_ref(), text.as_bytes());
    }
}

#[tokio::test]
async fn speaking_restriction_preserves_structured_detail() {
    let response =
        AppError::SpeakingRestricted(crate::models::SpeakingMode::ThreadsOnly).into_response();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        response.headers()[axum::http::header::CONTENT_TYPE],
        "application/json"
    );
    let body = axum::body::to_bytes(response.into_body(), 1024)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({
            "code": "speakingRestricted",
            "effectiveSpeakingMode": "threadsOnly",
        }),
    );
}

#[tokio::test]
async fn group_chat_write_restriction_returns_a_stable_reason() {
    let response = AppError::GroupChatWriteRestricted.into_response();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = axum::body::to_bytes(response.into_body(), 1024)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({"reason": "groupChatWriteRestricted"}),
    );
}

#[tokio::test]
async fn outbox_conflict_uses_the_same_detail_for_http_and_rpc() {
    use crate::dto::{messages::MessageResponse, users::User};
    let existing = MessageResponse {
        system_kind: None,
        system_links: None,
        forwarded_from: None,
        id: 9007199254740993,
        message: Some("Already accepted".into()),
        metadata: None,
        message_type: crate::models::MessageType::Text,
        sticker: None,
        reply_root_id: None,
        client_generated_id: "client-id".into(),
        sender: User {
            uid: 7,
            avatar_url: None,
            name: None,
            gender: 0,
            user_group: None,
        },
        chat_id: 42,
        created_at: chrono::DateTime::from_timestamp(1_700_000_000, 0).unwrap(),
        is_edited: false,
        is_deleted: false,
        has_attachments: false,
        thread_info: None,
        reply_to_message: None,
        attachments: Vec::new(),
        reactions: Vec::new(),
        mentions: Vec::new(),
        forwarded_bundle_id: None,
        forwarded_preview: None,
    };
    let http = AppError::MessageIdConflict(Box::new(existing.clone())).into_response();
    assert_eq!(http.status(), StatusCode::CONFLICT);
    assert_eq!(
        http.headers()[axum::http::header::CONTENT_TYPE],
        "application/json"
    );
    let body = axum::body::to_bytes(http.into_body(), 2048).await.unwrap();
    let detail: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(detail["code"], "clientGeneratedIdConflict");
    assert_eq!(detail["existingMessage"]["id"], "9007199254740993");
    assert_eq!(detail["existingMessage"]["message"], "Already accepted");
    let rpc = serde_json::to_value(crate::rpc::error::RpcError::from(
        AppError::MessageIdConflict(Box::new(existing)),
    ))
    .unwrap();
    assert_eq!(rpc["code"], 1009);
    assert_eq!(rpc["data"], detail);
}
