use serde::Deserialize;
use utoipa::ToSchema;

use crate::dto::blocks::BlockRequestBody;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BlocksListParams {}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BlocksCreateParams {
    #[serde(flatten)]
    pub body: BlockRequestBody,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BlocksDeleteParams {
    pub uid: i32,
}
