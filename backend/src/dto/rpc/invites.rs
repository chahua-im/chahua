use serde::Deserialize;
use utoipa::ToSchema;

use crate::dto::invites::{
    CreateInviteBody, GetInviteByCodeQuery, ListInvitesQuery, PatchInviteBody, RedeemInviteBody,
    SendInviteMessageBody,
};

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvitesListParams {
    #[serde(flatten)]
    pub query: ListInvitesQuery,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvitesCreateParams {
    #[serde(flatten)]
    pub body: CreateInviteBody,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvitesSendParams {
    #[serde(flatten)]
    pub body: SendInviteMessageBody,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvitesGetParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub invite_id: i64,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvitesGetByCodeParams {
    #[serde(flatten)]
    pub query: GetInviteByCodeQuery,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvitesUpdateParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub invite_id: i64,
    #[serde(flatten)]
    pub body: PatchInviteBody,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvitesDeleteParams {
    #[serde(deserialize_with = "crate::dto::rpc::deserialize_id")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub invite_id: i64,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvitesRedeemParams {
    #[serde(flatten)]
    pub body: RedeemInviteBody,
}
