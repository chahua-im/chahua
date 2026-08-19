use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::dto::users::MemberSummary;

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateDmBody {
    pub peer_uid: i32,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DmResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub peer: MemberSummary,
}
