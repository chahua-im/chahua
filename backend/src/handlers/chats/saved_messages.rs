use axum::{
    extract::{Path, Query},
    Json,
};
use serde::Deserialize;
use utoipa_axum::router::OpenApiRouter;

use crate::{
    dto::saved_messages::ListSavedMessagesResponse, errors::AppError, extractors::DbConn,
    handlers::members::check_membership, services::saved_messages as saved_messages_svc,
    utils::auth::CurrentUid, AppState,
};

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
struct ListSavedMessagesQuery {
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[param(value_type = Option<String>)]
    before: Option<i64>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ChatIdPath {
    chat_id: i64,
}

#[utoipa::path(
    get,
    path = "/",
    tag = "chats",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
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
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;
    let response = saved_messages_svc::list_saved_messages(
        conn,
        uid,
        Some(chat_id),
        query.before,
        query.limit,
    )?;

    Ok(Json(response))
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(utoipa_axum::routes!(list_chat_saved_messages))
}
