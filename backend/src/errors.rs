use axum::http::StatusCode;
use axum::response::IntoResponse;

/// Unified error type for handler functions, replacing repetitive `.map_err()` boilerplate.
///
/// Common database and pool errors implement `From`, so bare `?` works for the 500 case.
/// Handlers can explicitly return `NotFound`, `Forbidden`, `BadRequest`, `Conflict`, or `Gone`
/// for non-500 status codes.
#[derive(Debug)]
pub enum AppError {
    /// r2d2 pool error (failed to acquire a DB connection).
    DbPool(diesel::r2d2::PoolError),
    /// Diesel query / transaction error.
    DbQuery(diesel::result::Error),
    /// 400 Bad Request with a static message.
    BadRequest(&'static str),
    /// 401 Unauthorized with a static message.
    Unauthorized(&'static str),
    /// 403 Forbidden with a static message.
    Forbidden(&'static str),
    /// 404 Not Found with a static message.
    NotFound(&'static str),
    /// 409 Conflict with a static message.
    Conflict(&'static str),
    /// 410 Gone with a static message.
    Gone(&'static str),
    /// 503 Service Unavailable with a static message.
    ServiceUnavailable(&'static str),
    /// Generic internal server error with a static message (for non-diesel/pool errors).
    Internal(&'static str),
}

impl From<diesel::r2d2::PoolError> for AppError {
    fn from(err: diesel::r2d2::PoolError) -> Self {
        AppError::DbPool(err)
    }
}

impl From<diesel::result::Error> for AppError {
    fn from(err: diesel::result::Error) -> Self {
        AppError::DbQuery(err)
    }
}

/// Allow converting from the legacy `(StatusCode, &'static str)` tuple so that existing
/// helpers (e.g. `presign_public_upload`, auth extractors) can interop without rewriting
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
            AppError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg).into_response(),
            AppError::Forbidden(msg) => (StatusCode::FORBIDDEN, msg).into_response(),
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

    #[test]
    fn service_unavailable_maps_to_503() {
        let response = AppError::ServiceUnavailable("Message search unavailable").into_response();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
