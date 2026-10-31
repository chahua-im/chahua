use axum::{
    extract::{Json, Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use utoipa_axum::router::OpenApiRouter;

use crate::dto::groups::{
    AvatarUploadUrlRequest, AvatarUploadUrlResponse, CreateChatBody, CreateChatResponse,
    GroupInfoResponse, GroupSearchMode, GroupSelectorScope, ListGroupsQuery, ListGroupsResponse,
    MuteBody, MuteResponse, UpdateChatBody,
};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::services::api::groups;
use crate::utils::auth::CurrentUid;
use crate::AppState;

#[derive(serde::Deserialize)]
pub(super) struct ChatIdPath {
    pub(super) chat_id: i64,
}

/// POST /group — Create a new chat.
#[utoipa::path(
    post,
    path = "/",
    tag = "groups",
    request_body = CreateChatBody,
    responses(
        (status = CREATED, body = CreateChatResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn post_group(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<CreateChatBody>,
) -> Result<impl IntoResponse, AppError> {
    let response =
        groups::post_group(uid, body, &mut conn, &state.authz_service, &state.id_gen).await?;
    Ok((StatusCode::CREATED, Json(response)))
}

/// GET /group — List groups for selector/search.
#[utoipa::path(
    get,
    path = "/",
    tag = "groups",
    params(
        ("q" = Option<String>, Query, description = "Search query"),
        ("mode" = Option<GroupSearchMode>, Query, description = "Search mode"),
        ("limit" = Option<i64>, Query, description = "Page size limit"),
        ("after" = Option<String>, Query, description = "Cursor for pagination"),
        ("scope" = Option<GroupSelectorScope>, Query, description = "Group scope filter"),
    ),
    responses(
        (status = OK, body = ListGroupsResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_groups(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(query): Query<ListGroupsQuery>,
) -> Result<Json<ListGroupsResponse>, AppError> {
    Ok(Json(
        groups::get_groups(uid, query, &mut conn, &state.media).await?,
    ))
}

/// GET /group/:chat_id — Get chat details.
#[utoipa::path(
    get,
    path = "/{chat_id}",
    tag = "groups",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
    ),
    responses(
        (status = OK, body = GroupInfoResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_group(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
) -> Result<Json<GroupInfoResponse>, AppError> {
    Ok(Json(
        groups::get_group(
            uid,
            chat_id,
            &mut conn,
            &state.media,
            state.avatars.as_ref(),
        )
        .await?,
    ))
}

/// POST /group/:chat_id/avatar/upload-url — Create a group avatar upload URL.
#[utoipa::path(
    post,
    path = "/{chat_id}/avatar/upload-url",
    tag = "groups",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
    ),
    request_body = AvatarUploadUrlRequest,
    responses(
        (status = CREATED, body = AvatarUploadUrlResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn post_avatar_upload_url(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Json(payload): Json<AvatarUploadUrlRequest>,
) -> Result<impl IntoResponse, AppError> {
    let response = groups::post_avatar_upload_url(
        uid,
        chat_id,
        payload,
        &mut conn,
        &state.id_gen,
        &state.media,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(response)))
}

/// PATCH /group/:chat_id — Update chat metadata (admin only).
#[utoipa::path(
    patch,
    path = "/{chat_id}",
    tag = "groups",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
    ),
    request_body = UpdateChatBody,
    responses(
        (status = OK, body = GroupInfoResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn patch_group(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Json(body): Json<UpdateChatBody>,
) -> Result<Json<GroupInfoResponse>, AppError> {
    Ok(Json(
        groups::patch_group(
            uid,
            chat_id,
            body,
            &mut conn,
            &state.media,
            state.avatars.as_ref(),
            state.ws_registry.as_ref(),
        )
        .await?,
    ))
}

/// PUT /group/:chat_id/mute — Mute notifications for a chat.
#[utoipa::path(
    put,
    path = "/{chat_id}/mute",
    tag = "groups",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
    ),
    request_body = MuteBody,
    responses(
        (status = OK, body = MuteResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn put_mute(
    State(state): State<AppState>,
    CurrentUid(uid): CurrentUid,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Json(body): Json<MuteBody>,
) -> Result<Json<MuteResponse>, AppError> {
    Ok(Json(
        groups::put_mute(uid, chat_id, body, &mut conn, state.ws_registry.as_ref()).await?,
    ))
}

/// DELETE /group/:chat_id/mute — Unmute notifications for a chat.
#[utoipa::path(
    delete,
    path = "/{chat_id}/mute",
    tag = "groups",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("bearer_jwt" = [])),
)]
async fn delete_mute(
    State(state): State<AppState>,
    CurrentUid(uid): CurrentUid,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    groups::delete_mute(uid, chat_id, &mut conn, state.ws_registry.as_ref()).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(put, path = "/{chat_id}/notification-setting", tag = "groups",
    params(("chat_id" = String, Path, description = "Chat ID")),
    request_body = crate::dto::groups::UpdateNotificationSettingRequest,
    responses((status = OK, body = crate::dto::groups::ChatNotificationSettingResponse)), security(("bearer_jwt" = [])))]
async fn put_notification_setting(
    State(state): State<AppState>,
    CurrentUid(uid): CurrentUid,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Json(body): Json<crate::dto::groups::UpdateNotificationSettingRequest>,
) -> Result<Json<crate::dto::groups::ChatNotificationSettingResponse>, AppError> {
    Ok(Json(
        groups::put_notification_setting(uid, chat_id, body, &mut conn, state.ws_registry.as_ref())
            .await?,
    ))
}

#[utoipa::path(
    put,
    path = "/{chat_id}/speaking-mode",
    tag = "groups",
    params(("chat_id" = String, Path, description = "Chat ID")),
    request_body = crate::dto::speaking::UpdateSpeakingModeRequest,
    responses(
        (status = OK, body = crate::dto::speaking::GroupSpeakingModeResponse),
        (status = FORBIDDEN, description = "Group admin required"),
        (status = BAD_REQUEST, description = "Not supported in DM chats"),
    ),
    security(("bearer_jwt" = [])),
)]
async fn put_speaking_mode(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Json(body): Json<crate::dto::speaking::UpdateSpeakingModeRequest>,
) -> Result<Json<crate::dto::speaking::GroupSpeakingModeResponse>, AppError> {
    Ok(Json(
        groups::put_speaking_mode(uid, chat_id, body, &mut conn, state.ws_registry.as_ref())
            .await?,
    ))
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(get_groups, post_group))
        .routes(utoipa_axum::routes!(get_group, patch_group))
        .routes(utoipa_axum::routes!(post_avatar_upload_url))
        .routes(utoipa_axum::routes!(put_mute, delete_mute))
        .routes(utoipa_axum::routes!(put_notification_setting))
        .routes(utoipa_axum::routes!(put_speaking_mode))
        .nest("/{chat_id}/members", crate::handlers::members::router())
}
