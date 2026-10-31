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
}
