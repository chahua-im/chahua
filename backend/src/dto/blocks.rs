use chrono::{DateTime, Utc};
use serde::Serialize;
use utoipa::ToSchema;

use crate::dto::users::MemberSummary;

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BlockResponse {
    pub user: MemberSummary,
    pub since: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListBlocksResponse {
    pub blocks: Vec<BlockResponse>,
}
