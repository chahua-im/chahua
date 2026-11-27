use axum::http::StatusCode;
use axum::response::IntoResponse;

use crate::errors::{AppError, GROUP_CHAT_WRITE_RESTRICTION_REASON};

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
            AppError::GroupChatWriteRestricted => (
                StatusCode::FORBIDDEN,
                axum::Json(serde_json::json!({"reason": GROUP_CHAT_WRITE_RESTRICTION_REASON})),
            )
                .into_response(),
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
mod tests;
