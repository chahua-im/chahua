use axum::{
    extract::{Path, Query},
    Json,
};
use serde::Deserialize;
use utoipa_axum::router::OpenApiRouter;

use crate::{
    dto::saved_messages::{ListSavedMessagesQuery, ListSavedMessagesResponse},
    errors::AppError,
    extractors::DbConn,
    utils::auth::CurrentUid,
    AppState,
};

#[derive(Debug, Deserialize)]
struct ChatIdPath {
    chat_id: i64,
}

#[utoipa::path(
    get,
    path = "/",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ListSavedMessagesQuery,
    ),
    responses(
        (status = OK, body = ListSavedMessagesResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn list_chat_saved_messages(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    Query(query): Query<ListSavedMessagesQuery>,
) -> Result<Json<ListSavedMessagesResponse>, AppError> {
    crate::services::api::chats::saved_messages::list_chat_saved_messages(
        uid, chat_id, query, &mut conn,
    )
    .map(Json)
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(utoipa_axum::routes!(list_chat_saved_messages))
}
