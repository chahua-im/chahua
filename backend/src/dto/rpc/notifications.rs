use serde::Serialize;

/// Typed server notifications emitted when an RPC session can no longer use
/// its authenticated identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionNotification {
    Invalidated { reason: SessionInvalidatedReason },
    Unavailable { reason: SessionUnavailableReason },
}

impl SessionNotification {
    pub const fn method(self) -> &'static str {
        match self {
            Self::Invalidated { .. } => "session.invalidated",
            Self::Unavailable { .. } => "session.unavailable",
        }
    }
}

/// The only safe invalidation cause exposed to RPC clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum SessionInvalidatedReason {
    Revoked,
}

/// The only safe unavailable cause exposed to RPC clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum SessionUnavailableReason {
    AuthLookupUnavailable,
}

/// Payload for the `session.invalidated` notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionInvalidatedNotification {
    pub reason: SessionInvalidatedReason,
}

/// Payload for the `session.unavailable` notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionUnavailableNotification {
    pub reason: SessionUnavailableReason,
}
