use crate::dto::invites::*;
use crate::dto::rpc::invites::*;
use crate::errors::AppError;
use crate::rpc::{AppState, RpcCallContext};
use crate::services::api::invites;

pub async fn list(
    context: &RpcCallContext,
    services: &AppState,
    params: InvitesListParams,
) -> Result<ListInvitesResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    invites::get_invites(uid, params.query, &mut conn)
}

pub async fn create(
    context: &RpcCallContext,
    services: &AppState,
    params: InvitesCreateParams,
) -> Result<InviteResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .invites
        .post_invite(uid, params.body, &mut conn)
        .await
}

pub async fn send(
    context: &RpcCallContext,
    services: &AppState,
    params: InvitesSendParams,
) -> Result<SendInviteMessageResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .invites
        .post_send_invite_message(uid, params.body, &mut conn)
        .await
}

pub async fn get(
    context: &RpcCallContext,
    services: &AppState,
    params: InvitesGetParams,
) -> Result<InviteResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    invites::get_invite(uid, params.invite_id, &mut conn)
}

pub async fn get_by_code(
    context: &RpcCallContext,
    services: &AppState,
    params: InvitesGetByCodeParams,
) -> Result<InvitePreviewResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .invites
        .get_invite_by_code(uid, params.query, &mut conn)
}

pub async fn update(
    context: &RpcCallContext,
    services: &AppState,
    params: InvitesUpdateParams,
) -> Result<InviteResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    invites::patch_invite(uid, params.invite_id, params.body, &mut conn)
}

pub async fn delete(
    context: &RpcCallContext,
    services: &AppState,
    params: InvitesDeleteParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    invites::delete_invite(uid, params.invite_id, &mut conn)
}

pub async fn redeem(
    context: &RpcCallContext,
    services: &AppState,
    params: InvitesRedeemParams,
) -> Result<RedeemInviteResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .invites
        .post_redeem_invite(uid, params.body, &mut conn)
        .await
}
