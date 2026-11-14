use axum::{
    extract::{Query, State},
    Json,
};
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::auth::AuthTokenResponse;
use crate::dto::users::{
    ChatSettings, MeResponse, SearchUsersQuery, SearchUsersResponse, UpdateChatSettings,
    UpdateStickerPackOrderRequest,
};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::services::api::users;
use crate::utils::auth::{BearerSession, CurrentUid};
use crate::AppState;

#[utoipa::path(
    put,
    path = "/me/stickerpack-order",
    tag = "users",
    request_body = UpdateStickerPackOrderRequest,
    responses(
        (status = 200, description = "Order updated successfully")
    ),
    security(("bearer_jwt" = []))
)]
async fn put_stickerpack_order(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    conn: DbConn,
    Json(req): Json<UpdateStickerPackOrderRequest>,
) -> Result<Json<()>, AppError> {
    conn.run(move |mut conn| async move {
        users::put_stickerpack_order(uid, req, &mut conn, &state.ws_registry)?;
        Ok(Json(()))
    })
    .await
}

/// GET /users/me — Get the current logged in user's information
#[utoipa::path(
    get,
    path = "/me",
    tag = "users",
    responses(
        (status = 200, description = "Current user info", body = MeResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn get_me(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    conn: DbConn,
) -> Result<Json<MeResponse>, AppError> {
    conn.run(move |mut conn| async move {
        users::get_me(uid, &mut conn, &state.avatars, &state.authz_service).map(Json)
    })
    .await
}

#[utoipa::path(
    put, path = "/me/chat-settings", tag = "users", request_body = UpdateChatSettings,
    responses((status = 200, description = "Saved account chat settings", body = ChatSettings)),
    security(("bearer_jwt" = []))
)]
async fn put_chat_settings(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    conn: DbConn,
    Json(settings): Json<UpdateChatSettings>,
) -> Result<Json<ChatSettings>, AppError> {
    conn.run(move |mut conn| async move {
        users::put_chat_settings(uid, settings, &mut conn, &state.ws_registry).map(Json)
    })
    .await
}

/// GET /users/search — Search global users for targeted invites.
#[utoipa::path(
    get,
    path = "/search",
    tag = "users",
    params(SearchUsersQuery),
    responses(
        (status = 200, description = "User search results", body = SearchUsersResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn get_user_search(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    conn: DbConn,
    Query(query): Query<SearchUsersQuery>,
) -> Result<Json<SearchUsersResponse>, AppError> {
    conn.run(move |mut conn| async move {
        users::get_user_search(uid, query, &mut conn, &state.avatars, &state.authz_service)
            .map(Json)
    })
    .await
}

#[utoipa::path(
    get,
    path = "/auth-token",
    tag = "users",
    responses(
        (status = 200, description = "Auth token", body = AuthTokenResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn get_auth_token(
    State(state): State<AppState>,
    BearerSession(session): BearerSession,
) -> Result<Json<AuthTokenResponse>, AppError> {
    let token = state.auth_token_service.issue_legacy_session(
        session.uid,
        &session.client_id,
        session.generation,
    )?;

    Ok(Json(AuthTokenResponse { token }))
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .merge(super::notification_preferences::router())
        .routes(routes!(get_me))
        .routes(routes!(put_chat_settings))
        .routes(routes!(get_user_search))
        .routes(routes!(get_auth_token))
        .routes(routes!(put_stickerpack_order))
}
