use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use utoipa_axum::router::OpenApiRouter;

use crate::{
    dto::messages::ReactionDetailResponse, errors::AppError, extractors::DbConn,
    utils::auth::CurrentUid, AppState,
};

#[utoipa::path(
    get,
    path = "/",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("message_id" = String, Path, description = "Message ID"),
    ),
    responses(
        (status = 200, description = "Reaction details", body = ReactionDetailResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_reaction_details(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path((chat_id, message_id)): Path<(i64, i64)>,
    conn: DbConn,
) -> Result<Json<ReactionDetailResponse>, AppError> {
    conn.run(move |mut conn| async move {
        crate::services::api::chats::reactions::get_reaction_details(
            uid,
            chat_id,
            message_id,
            &mut conn,
            &state.avatars,
        )
        .map(Json)
    })
    .await
}

#[utoipa::path(
    put,
    path = "/{emoji}",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("message_id" = String, Path, description = "Message ID"),
        ("emoji" = String, Path, description = "Emoji character"),
    ),
    responses(
        (status = 204, description = "Reaction added"),
    ),
    security(("bearer_jwt" = [])),
)]
async fn put_reaction(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path((chat_id, message_id, emoji)): Path<(i64, i64, String)>,
    conn: DbConn,
) -> Result<StatusCode, AppError> {
    conn.run(move |mut conn| async move {
        crate::services::api::chats::reactions::put_reaction(
            uid,
            chat_id,
            message_id,
            emoji,
            &mut conn,
            &state.avatars,
            &state.ws_registry,
        )?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

#[utoipa::path(
    delete,
    path = "/{emoji}",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("message_id" = String, Path, description = "Message ID"),
        ("emoji" = String, Path, description = "Emoji character"),
    ),
    responses(
        (status = 204, description = "Reaction removed"),
    ),
    security(("bearer_jwt" = [])),
)]
async fn delete_reaction(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path((chat_id, message_id, emoji)): Path<(i64, i64, String)>,
    conn: DbConn,
) -> Result<StatusCode, AppError> {
    conn.run(move |mut conn| async move {
        crate::services::api::chats::reactions::delete_reaction(
            uid,
            chat_id,
            message_id,
            emoji,
            &mut conn,
            &state.avatars,
            &state.ws_registry,
        )?;
        Ok(StatusCode::NO_CONTENT)
    })
    .await
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(get_reaction_details))
        .routes(utoipa_axum::routes!(put_reaction, delete_reaction))
}
