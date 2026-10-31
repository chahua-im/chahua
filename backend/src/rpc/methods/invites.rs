use crate::dto::invites::*;
use crate::dto::rpc::invites::*;
use crate::errors::AppError;
use crate::rpc::{RpcCallContext, RpcServices};
use crate::services::api::invites;

pub async fn list(
    context: &RpcCallContext,
    services: &RpcServices,
    params: InvitesListParams,
) -> Result<ListInvitesResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    invites::get_invites(uid, params.query, &mut conn)
}

pub async fn create(
    context: &RpcCallContext,
    services: &RpcServices,
    params: InvitesCreateParams,
) -> Result<InviteResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    invites::post_invite(uid, params.body, &mut conn, &services.id_gen).await
}

pub async fn send(
    context: &RpcCallContext,
    services: &RpcServices,
    params: InvitesSendParams,
) -> Result<SendInviteMessageResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    invites::post_send_invite_message(
        uid,
        params.body,
        &mut conn,
        invites::PostSendInviteMessageDeps {
            id_gen: &services.id_gen,
            media: &services.media,
            avatars: &services.avatars,
            metrics: &services.metrics,
            ws_registry: &services.ws_registry,
            push_service: &services.push_service,
        },
    )
    .await
}

pub async fn get(
    context: &RpcCallContext,
    services: &RpcServices,
    params: InvitesGetParams,
) -> Result<InviteResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    invites::get_invite(uid, params.invite_id, &mut conn)
}

pub async fn get_by_code(
    context: &RpcCallContext,
    services: &RpcServices,
    params: InvitesGetByCodeParams,
) -> Result<InvitePreviewResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    invites::get_invite_by_code(
        uid,
        params.query,
        &mut conn,
        &services.media,
        &services.avatars,
    )
}

pub async fn update(
    context: &RpcCallContext,
    services: &RpcServices,
    params: InvitesUpdateParams,
) -> Result<InviteResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    invites::patch_invite(uid, params.invite_id, params.body, &mut conn)
}

pub async fn delete(
    context: &RpcCallContext,
    services: &RpcServices,
    params: InvitesDeleteParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    invites::delete_invite(uid, params.invite_id, &mut conn)
}

pub async fn redeem(
    context: &RpcCallContext,
    services: &RpcServices,
    params: InvitesRedeemParams,
) -> Result<RedeemInviteResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    invites::post_redeem_invite(
        uid,
        params.body,
        &mut conn,
        invites::PostRedeemInviteDeps {
            id_gen: &services.id_gen,
            media: &services.media,
            avatars: &services.avatars,
            metrics: &services.metrics,
            ws_registry: &services.ws_registry,
            push_service: &services.push_service,
        },
    )
    .await
}
