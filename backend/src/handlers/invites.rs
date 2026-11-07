use axum::{
    extract::{Json, Path, Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::invites::{
    CreateInviteBody, GetInviteByCodeQuery, InvitePreviewResponse, InviteResponse,
    ListInvitesQuery, ListInvitesResponse, PatchInviteBody, RedeemInviteBody, RedeemInviteResponse,
    SendInviteMessageBody, SendInviteMessageResponse,
};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::utils::auth::CurrentUid;
use crate::AppState;

#[derive(Deserialize)]
struct InviteIdPath {
    invite_id: i64,
}

#[utoipa::path(
    post,
    path = "/",
    tag = "invites",
    request_body = CreateInviteBody,
    responses(
        (status = 201, description = "Invite created", body = InviteResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn post_invite(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<CreateInviteBody>,
) -> Result<(StatusCode, Json<InviteResponse>), AppError> {
    let response =
        crate::services::api::invites::post_invite(uid, body, &mut conn, &state.id_gen).await?;
    Ok((StatusCode::CREATED, Json(response)))
}

#[utoipa::path(
    post,
    path = "/send",
    tag = "invites",
    request_body = SendInviteMessageBody,
    responses(
        (status = 201, description = "Invite message sent", body = SendInviteMessageResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn post_send_invite_message(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<SendInviteMessageBody>,
) -> Result<(StatusCode, Json<SendInviteMessageResponse>), AppError> {
    let response = crate::services::api::invites::post_send_invite_message(
        uid,
        body,
        &mut conn,
        crate::services::api::invites::PostSendInviteMessageDeps {
            id_gen: &state.id_gen,
            media: &state.media,
            avatars: &state.avatars,
            metrics: &state.metrics,
            ws_registry: &state.ws_registry,
            push_service: &state.push_service,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(response)))
}

#[utoipa::path(
    get,
    path = "/",
    tag = "invites",
    params(ListInvitesQuery),
    responses(
        (status = 200, description = "List of invites", body = ListInvitesResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn get_invites(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
    Query(query): Query<ListInvitesQuery>,
) -> Result<Json<ListInvitesResponse>, AppError> {
    crate::services::api::invites::get_invites(uid, query, &mut conn).map(Json)
}

#[utoipa::path(
    get,
    path = "/invite/{invite_id}",
    tag = "invites",
    params(
        ("invite_id" = String, Path, description = "Invite ID")
    ),
    responses(
        (status = 200, description = "Invite details", body = InviteResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn get_invite(
    CurrentUid(uid): CurrentUid,
    Path(InviteIdPath { invite_id }): Path<InviteIdPath>,
    mut conn: DbConn,
) -> Result<Json<InviteResponse>, AppError> {
    crate::services::api::invites::get_invite(uid, invite_id, &mut conn).map(Json)
}

#[utoipa::path(
    get,
    path = "/invite",
    tag = "invites",
    params(GetInviteByCodeQuery),
    responses(
        (status = 200, description = "Invite preview", body = InvitePreviewResponse),
        (status = 400, description = "Invalid invitation code"),
        (status = 404, description = "Invitation does not exist"),
        (status = 410, description = "Invitation expired or revoked")
    ),
    security(("bearer_jwt" = []))
)]
async fn get_invite_by_code(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(query): Query<GetInviteByCodeQuery>,
) -> Result<Json<InvitePreviewResponse>, AppError> {
    crate::services::api::invites::get_invite_by_code(
        uid,
        query,
        &mut conn,
        &state.media,
        &state.avatars,
    )
    .map(Json)
}

#[utoipa::path(
    patch,
    path = "/invite/{invite_id}",
    tag = "invites",
    params(
        ("invite_id" = String, Path, description = "Invite ID")
    ),
    request_body = PatchInviteBody,
    responses(
        (status = 200, description = "Invite updated", body = InviteResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn patch_invite(
    CurrentUid(uid): CurrentUid,
    Path(InviteIdPath { invite_id }): Path<InviteIdPath>,
    mut conn: DbConn,
    Json(body): Json<PatchInviteBody>,
) -> Result<Json<InviteResponse>, AppError> {
    crate::services::api::invites::patch_invite(uid, invite_id, body, &mut conn).map(Json)
}

#[utoipa::path(
    delete,
    path = "/invite/{invite_id}",
    tag = "invites",
    params(
        ("invite_id" = String, Path, description = "Invite ID")
    ),
    responses(
        (status = 204, description = "Invite deleted")
    ),
    security(("bearer_jwt" = []))
)]
async fn delete_invite(
    CurrentUid(uid): CurrentUid,
    Path(InviteIdPath { invite_id }): Path<InviteIdPath>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    crate::services::api::invites::delete_invite(uid, invite_id, &mut conn)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/redeem",
    tag = "invites",
    request_body = RedeemInviteBody,
    responses(
        (status = 200, description = "Invite redeemed", body = RedeemInviteResponse),
        (status = 400, description = "Empty invitation code"),
        (status = 403, description = "Not eligible for this invitation"),
        (status = 404, description = "Invitation does not exist"),
        (status = 409, description = "Already a member or targeted invitation already used"),
        (status = 410, description = "Invitation expired or revoked")
    ),
    security(("bearer_jwt" = []))
)]
async fn post_redeem_invite(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<RedeemInviteBody>,
) -> Result<Json<RedeemInviteResponse>, AppError> {
    crate::services::api::invites::post_redeem_invite(
        uid,
        body,
        &mut conn,
        crate::services::api::invites::PostRedeemInviteDeps {
            id_gen: &state.id_gen,
            media: &state.media,
            avatars: &state.avatars,
            metrics: &state.metrics,
            ws_registry: &state.ws_registry,
            push_service: &state.push_service,
        },
    )
    .await
    .map(Json)
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(routes!(post_invite, get_invites))
        .routes(routes!(post_send_invite_message))
        .routes(routes!(post_redeem_invite))
        .routes(routes!(get_invite_by_code))
        .routes(routes!(get_invite, patch_invite, delete_invite))
}
