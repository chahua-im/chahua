/// Shared semantic application failures; transports own their response mapping.
///
/// Database and pool errors implement `From` for propagation with `?`.
#[derive(Debug)]
pub enum AppError {
    /// r2d2 pool error (failed to acquire a DB connection).
    DbPool(diesel::r2d2::PoolError),
    /// Diesel query / transaction error.
    DbQuery(diesel::result::Error),
    /// 400 Bad Request with a static message.
    BadRequest(&'static str),
    /// 413 Payload Too Large with a static message.
    PayloadTooLarge(&'static str),

    /// 401 Unauthorized with a static message.
    Unauthorized(&'static str),
    /// 403 Forbidden with a static message.
    Forbidden(&'static str),
    /// A user-originated send or edit is disallowed by the current group/member mode.
    SpeakingRestricted(crate::models::SpeakingMode),
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
