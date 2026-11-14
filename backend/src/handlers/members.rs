use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use utoipa_axum::router::OpenApiRouter;

use crate::dto::members::{
    AddMemberBody, ListMembersQuery, ListMembersResponse, MemberResponse, RemoveMemberQuery,
    UpdateMemberBody,
};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::services::api::members::{self, DeleteRemoveMemberDeps, PostAddMemberDeps};
use crate::utils::auth::CurrentUid;
use crate::AppState;

#[derive(serde::Deserialize)]
pub struct ChatIdPath {
    pub chat_id: i64,
}

#[derive(serde::Deserialize)]
pub struct MemberPath {
    chat_id: i64,
    uid: i32,
}

/// GET /group/:chat_id/members — List members of a chat.
#[utoipa::path(
    get,
    path = "/",
    tag = "members",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("limit" = Option<i64>, Query, description = "Page size limit"),
        ("after" = Option<i32>, Query, description = "Cursor for pagination"),
        ("q" = Option<String>, Query, description = "Search query"),
        ("mode" = Option<crate::services::user::UserSearchMode>, Query, description = "Search mode"),
    ),
    responses(
        (status = OK, body = ListMembersResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_members(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    conn: DbConn,
    Query(query): Query<ListMembersQuery>,
) -> Result<Json<ListMembersResponse>, AppError> {
    conn.run(move |mut conn| async move {
        members::get_members(uid, chat_id, query, &mut conn, &state.avatars).map(Json)
    })
    .await
}

/// POST /group/:chat_id/members — Add a member to the chat (caller must be admin).
#[utoipa::path(
    post,
    path = "/",
    tag = "members",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
    ),
    request_body = AddMemberBody,
    responses(
        (status = CREATED, body = MemberResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn post_add_member(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    conn: DbConn,
    Json(body): Json<AddMemberBody>,
) -> Result<(StatusCode, Json<MemberResponse>), AppError> {
    conn.run(move |mut conn| async move {
        let response = members::post_add_member(
            uid,
            chat_id,
            body,
            &mut conn,
            PostAddMemberDeps {
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
    })
    .await
}

/// DELETE /group/:chat_id/members/:uid — Remove a member from the chat (caller must be admin).
#[utoipa::path(
    delete,
    path = "/{uid}",
    tag = "members",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("uid" = i32, Path, description = "User ID of the member"),
        RemoveMemberQuery,
    ),
    responses(
        (status = NO_CONTENT),
        (status = 400, description = "DM chats cannot be left"),
    ),
    security(("bearer_jwt" = [])),
)]
async fn delete_remove_member(
    CurrentUid(uid): CurrentUid,
    Path(MemberPath {
        chat_id,
        uid: target_uid,
    }): Path<MemberPath>,
    Query(query): Query<RemoveMemberQuery>,
    State(state): State<AppState>,
    conn: DbConn,
) -> Result<StatusCode, AppError> {
    conn.run(move |mut conn| async move {
        members::delete_remove_member(
            uid,
            chat_id,
            target_uid,
            query,
            &mut conn,
            DeleteRemoveMemberDeps {
                id_gen: &state.id_gen,
                media: &state.media,
                avatars: &state.avatars,
                metrics: &state.metrics,
                ws_registry: &state.ws_registry,
                push_service: &state.push_service,
                background_service: &state.background_service,
            },
        )
        .await?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

/// PATCH /group/:chat_id/members/:uid — Update member role (admin only).
#[utoipa::path(
    patch,
    path = "/{uid}",
    tag = "members",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("uid" = i32, Path, description = "User ID of the member"),
    ),
    request_body = UpdateMemberBody,
    responses(
        (status = OK, body = MemberResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn patch_member(
    CurrentUid(requester_uid): CurrentUid,
    State(state): State<AppState>,
    Path(MemberPath {
        chat_id,
        uid: target_uid,
    }): Path<MemberPath>,
    conn: DbConn,
    Json(body): Json<UpdateMemberBody>,
) -> Result<Json<MemberResponse>, AppError> {
    conn.run(move |mut conn| async move {
        members::patch_member(
            requester_uid,
            chat_id,
            target_uid,
            body,
            &mut conn,
            &state.avatars,
            &state.ws_registry,
        )
        .map(Json)
    })
    .await
}

#[utoipa::path(
    put,
    path = "/{uid}/speaking-mode",
    tag = "members",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("uid" = i32, Path, description = "Member UID"),
    ),
    request_body = crate::dto::speaking::UpdateSpeakingModeRequest,
    responses(
        (status = OK, body = crate::dto::speaking::MemberSpeakingModeResponse),
        (status = FORBIDDEN, description = "Group admin required"),
        (status = BAD_REQUEST, description = "Target is an administrator, or chat is a DM"),
        (status = NOT_FOUND, description = "Target is not a member"),
    ),
    security(("bearer_jwt" = [])),
)]
async fn put_member_speaking_mode(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(MemberPath {
        chat_id,
        uid: target_uid,
    }): Path<MemberPath>,
    conn: DbConn,
    Json(body): Json<crate::dto::speaking::UpdateSpeakingModeRequest>,
) -> Result<Json<crate::dto::speaking::MemberSpeakingModeResponse>, AppError> {
    conn.run(move |mut conn| async move {
        members::put_member_speaking_mode(
            uid,
            chat_id,
            target_uid,
            body,
            &mut conn,
            &state.ws_registry,
        )
        .map(Json)
    })
    .await
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(get_members, post_add_member))
        .routes(utoipa_axum::routes!(delete_remove_member, patch_member))
        .routes(utoipa_axum::routes!(put_member_speaking_mode))
}
