use axum::http::StatusCode;
use axum::response::IntoResponse;

use crate::errors::AppError;

/// Allow converting from the legacy `(StatusCode, &'static str)` tuple so that existing
/// helpers (e.g. `MediaStore` methods, auth extractors) can interop without rewriting
/// everything at once.
impl From<(StatusCode, &'static str)> for AppError {
    fn from((status, msg): (StatusCode, &'static str)) -> Self {
        match status {
            StatusCode::BAD_REQUEST => AppError::BadRequest(msg),
            StatusCode::UNAUTHORIZED => AppError::Unauthorized(msg),
            StatusCode::FORBIDDEN => AppError::Forbidden(msg),
            StatusCode::NOT_FOUND => AppError::NotFound(msg),
            StatusCode::CONFLICT => AppError::Conflict(msg),
            StatusCode::GONE => AppError::Gone(msg),
            StatusCode::SERVICE_UNAVAILABLE => AppError::ServiceUnavailable(msg),
            _ => AppError::Internal(msg),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        match self {
            AppError::DbPool(err) => {
                tracing::error!("database pool error: {:?}", err);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Database connection failed",
                )
                    .into_response()
            }
            AppError::DbQuery(err) => {
                tracing::error!("database query error: {:?}", err);
                (StatusCode::INTERNAL_SERVER_ERROR, "Database error").into_response()
            }
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
            AppError::PayloadTooLarge(msg) => (StatusCode::PAYLOAD_TOO_LARGE, msg).into_response(),
            AppError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg).into_response(),
            AppError::Forbidden(msg) => (StatusCode::FORBIDDEN, msg).into_response(),
            AppError::SpeakingRestricted(mode) => (
                StatusCode::FORBIDDEN,
                axum::Json(crate::dto::speaking::SpeakingRestrictedResponse {
                    code: "speakingRestricted",
                    effective_speaking_mode: mode,
                }),
            )
                .into_response(),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg).into_response(),
            AppError::Conflict(msg) => (StatusCode::CONFLICT, msg).into_response(),
            AppError::MessageIdConflict(existing) => (
                StatusCode::CONFLICT,
                axum::Json(crate::dto::messages::MessageIdConflictResponse::new(
                    existing,
                )),
            )
                .into_response(),
            AppError::Gone(msg) => (StatusCode::GONE, msg).into_response(),
            AppError::ServiceUnavailable(msg) => {
                (StatusCode::SERVICE_UNAVAILABLE, msg).into_response()
            }
            AppError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg).into_response(),
        }
    }
}

#[cfg(test)]
mod tests {
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
}
