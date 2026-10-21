use serde::Serialize;
use utoipa::ToSchema;

/// The peer's last visible read receipt for one direct-message scope.
///
/// A missing value means the peer has no known receipt in that scope or their
/// policy does not permit publishing one. Receipt timestamps are intentionally
/// never exposed.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadReceiptResponse {
    #[serde(
        serialize_with = "crate::serde_i64_string::opt::serialize",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(value_type = Option<String>)]
    pub last_read_message_id: Option<i64>,
}
