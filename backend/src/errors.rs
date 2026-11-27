use crate::models::ForwardPlaceholder;
use std::collections::HashMap;

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
    /// This forward can proceed after the user agrees to a placeholder.
    ForwardPlaceholderRequired(ForwardPlaceholderConsent),
    /// 413 Payload Too Large with a static message.
    PayloadTooLarge(&'static str),

    /// 401 Unauthorized with a static message.
    Unauthorized(&'static str),
    /// 403 Forbidden with a static message.
    Forbidden(&'static str),
    /// The actor's Discuz primary group is restricted from writing to group chats.
    GroupChatWriteRestricted,
    /// A user-originated send or edit is disallowed by the current group/member mode.
    SpeakingRestricted(crate::models::SpeakingMode),
    /// 404 Not Found with a static message.
    NotFound(&'static str),
    /// 409 Conflict with a static message.
    Conflict(&'static str),
    /// 409 with a recipient-scoped copy of the already accepted message.
    MessageIdConflict(Box<crate::dto::messages::MessageResponse>),
    /// 410 Gone with a static message.
    Gone(&'static str),
    /// 503 Service Unavailable with a static message.
    ServiceUnavailable(&'static str),
    /// Generic internal server error with a static message (for non-diesel/pool errors).
    Internal(&'static str),
}

#[derive(Debug)]
pub struct ForwardPlaceholderConsent {
    pub by_message: HashMap<i64, ForwardPlaceholder>,
}

impl ForwardPlaceholderConsent {
    pub fn confirmation_required_message(&self) -> &'static str {
        if self
            .by_message
            .values()
            .any(|&item| item == ForwardPlaceholder::PendingAudio)
        {
            "Audio messages cannot be forwarded until transcoding finishes"
        } else {
            "Forwarded messages cannot include nested forwarded messages"
        }
    }
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
pub const GROUP_CHAT_WRITE_RESTRICTION_REASON: &str = "groupChatWriteRestricted";
pub const GROUP_CHAT_WRITE_RESTRICTION_MESSAGE: &str = "Your account cannot write to group chats";
