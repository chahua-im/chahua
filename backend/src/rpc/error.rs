use serde::{Serialize, Serializer};
use serde_json::{json, Value};

use crate::errors::AppError;

macro_rules! error_codes {
    ($( $name:ident = $code:expr => $message:literal ),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        #[repr(i32)]
        pub enum RpcErrorCode { $( $name = $code, )+ }

        impl RpcErrorCode {
            pub const ALL: &'static [Self] = &[$( Self::$name, )+];

            pub fn name(self) -> &'static str {
                match self { $( Self::$name => stringify!($name), )+ }
            }

            pub fn message(self) -> &'static str {
                match self { $( Self::$name => $message, )+ }
            }
        }
    };
}

error_codes! {
    ParseError = -32700 => "Parse error",
    InvalidRequest = -32600 => "Invalid Request",
    MethodNotFound = -32601 => "Method not found",
    InvalidParams = -32602 => "Invalid params",
    DispatcherInternal = -32603 => "Internal error",
    BadRequest = 1000 => "Bad request",
    Unauthorized = 1001 => "Unauthorized",
    Forbidden = 1003 => "Forbidden",
    NotFound = 1004 => "Not found",
    Conflict = 1009 => "Conflict",
    Gone = 1010 => "Gone",
    PayloadTooLarge = 1013 => "Payload too large",
    SpeakingRestricted = 1103 => "Speaking is restricted",
    Unavailable = 1503 => "Service unavailable",
    Internal = 1500 => "Internal error",
    Overloaded = 1429 => "Too many requests",
}

impl RpcErrorCode {
    pub fn metric_status(self) -> axum::http::StatusCode {
        use axum::http::StatusCode;
        match self {
            Self::ParseError | Self::InvalidRequest | Self::InvalidParams | Self::BadRequest => {
                StatusCode::BAD_REQUEST
            }
            Self::MethodNotFound | Self::NotFound => StatusCode::NOT_FOUND,
            Self::DispatcherInternal | Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Forbidden | Self::SpeakingRestricted => StatusCode::FORBIDDEN,
            Self::Conflict => StatusCode::CONFLICT,
            Self::Gone => StatusCode::GONE,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::Overloaded => StatusCode::TOO_MANY_REQUESTS,
        }
    }

    pub fn metric_code(self) -> &'static str {
        match self {
            Self::ParseError => "-32700",
            Self::InvalidRequest => "-32600",
            Self::MethodNotFound => "-32601",
            Self::InvalidParams => "-32602",
            Self::DispatcherInternal => "-32603",
            Self::BadRequest => "1000",
            Self::Unauthorized => "1001",
            Self::Forbidden => "1003",
            Self::NotFound => "1004",
            Self::Conflict => "1009",
            Self::Gone => "1010",
            Self::PayloadTooLarge => "1013",
            Self::SpeakingRestricted => "1103",
            Self::Unavailable => "1503",
            Self::Internal => "1500",
            Self::Overloaded => "1429",
        }
    }
}

impl Serialize for RpcErrorCode {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_i32(*self as i32)
    }
}

impl utoipa::PartialSchema for RpcErrorCode {
    fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
        serde_json::from_value(json!({
            "type": "integer",
            "enum": Self::ALL.iter().map(|code| *code as i32).collect::<Vec<_>>(),
            "x-enum-varnames": Self::ALL.iter().map(|code| code.name()).collect::<Vec<_>>(),
        }))
        .expect("valid static RPC error code schema")
    }
}

impl utoipa::ToSchema for RpcErrorCode {}

/// A session-engine action associated with an otherwise normal wire error.
///
/// This is deliberately not serialized: callers receive the standard public
/// JSON-RPC error while the transport decides whether to invalidate or
/// temporarily unavailable-close the retained authenticated identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RpcLifecycleFailure {
    Revoked,
    AuthLookupUnavailable,
}

impl RpcLifecycleFailure {
    pub const fn code(self) -> RpcErrorCode {
        match self {
            Self::Revoked => RpcErrorCode::Unauthorized,
            Self::AuthLookupUnavailable => RpcErrorCode::Unavailable,
        }
    }

    pub const fn message(self) -> &'static str {
        match self {
            Self::Revoked => "Session revoked",
            Self::AuthLookupUnavailable => "Auth lookup unavailable",
        }
    }
}

impl From<crate::services::authentication::SessionGenerationFailure> for RpcLifecycleFailure {
    fn from(value: crate::services::authentication::SessionGenerationFailure) -> Self {
        match value {
            crate::services::authentication::SessionGenerationFailure::Revoked => Self::Revoked,
            crate::services::authentication::SessionGenerationFailure::LookupUnavailable => {
                Self::AuthLookupUnavailable
            }
        }
    }
}

impl From<RpcLifecycleFailure> for RpcError {
    fn from(value: RpcLifecycleFailure) -> Self {
        Self {
            code: value.code(),
            message: value.message(),
            data: None,
            lifecycle: Some(value),
        }
    }
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct RpcError {
    pub code: RpcErrorCode,
    pub message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip)]
    #[schema(ignore)]
    lifecycle: Option<RpcLifecycleFailure>,
}

impl RpcError {
    pub fn new(code: RpcErrorCode) -> Self {
        Self {
            code,
            message: code.message(),
            data: None,
            lifecycle: None,
        }
    }

    pub fn with_message(code: RpcErrorCode, message: &'static str) -> Self {
        Self {
            code,
            message,
            data: None,
            lifecycle: None,
        }
    }

    pub(crate) const fn lifecycle_failure(&self) -> Option<RpcLifecycleFailure> {
        self.lifecycle
    }
}

impl From<AppError> for RpcError {
    fn from(error: AppError) -> Self {
        match error {
            AppError::BadRequest(message) => Self::with_message(RpcErrorCode::BadRequest, message),
            AppError::Unauthorized(message) => {
                Self::with_message(RpcErrorCode::Unauthorized, message)
            }
            AppError::Forbidden(message) => Self::with_message(RpcErrorCode::Forbidden, message),
            AppError::NotFound(message) => Self::with_message(RpcErrorCode::NotFound, message),
            AppError::Conflict(message) => Self::with_message(RpcErrorCode::Conflict, message),
            AppError::Gone(message) => Self::with_message(RpcErrorCode::Gone, message),
            AppError::PayloadTooLarge(message) => {
                Self::with_message(RpcErrorCode::PayloadTooLarge, message)
            }
            AppError::ServiceUnavailable(message) => {
                Self::with_message(RpcErrorCode::Unavailable, message)
            }
            AppError::Internal(message) => Self::with_message(RpcErrorCode::Internal, message),
            AppError::SpeakingRestricted(mode) => Self {
                code: RpcErrorCode::SpeakingRestricted,
                message: "Speaking is restricted",
                data: Some(json!({"code": "speakingRestricted", "effectiveSpeakingMode": mode})),
                lifecycle: None,
            },
            AppError::DbPool(error) => {
                tracing::error!(?error, "database pool error");
                Self::with_message(RpcErrorCode::Internal, "Database connection failed")
            }
            AppError::DbQuery(error) => {
                tracing::error!(?error, "database query error");
                Self::with_message(RpcErrorCode::Internal, "Database error")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_error_has_a_native_metric_code_and_http_equivalent() {
        use axum::http::StatusCode;
        let expected = [
            StatusCode::BAD_REQUEST,
            StatusCode::BAD_REQUEST,
            StatusCode::NOT_FOUND,
            StatusCode::BAD_REQUEST,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::BAD_REQUEST,
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
            StatusCode::CONFLICT,
            StatusCode::GONE,
            StatusCode::PAYLOAD_TOO_LARGE,
            StatusCode::FORBIDDEN,
            StatusCode::SERVICE_UNAVAILABLE,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::TOO_MANY_REQUESTS,
        ];
        assert_eq!(RpcErrorCode::ALL.len(), expected.len());
        for (code, status) in RpcErrorCode::ALL.iter().zip(expected) {
            assert_eq!(code.metric_status(), status);
            assert_eq!(code.metric_code().parse::<i32>().unwrap(), *code as i32);
        }
    }

    #[test]
    fn business_restriction_preserves_safe_detail_without_http_status() {
        let value = serde_json::to_value(RpcError::from(AppError::SpeakingRestricted(
            crate::models::SpeakingMode::ThreadsOnly,
        )))
        .unwrap();
        assert_eq!(
            value,
            json!({
                "code": 1103,
                "message": "Speaking is restricted",
                "data": {"code": "speakingRestricted", "effectiveSpeakingMode": "threadsOnly"},
            })
        );
    }

    #[test]
    fn database_failure_does_not_expose_query_details() {
        let value = serde_json::to_value(RpcError::from(AppError::DbQuery(
            diesel::result::Error::NotFound,
        )))
        .unwrap();
        assert_eq!(value, json!({"code": 1500, "message": "Database error"}));
    }
}
