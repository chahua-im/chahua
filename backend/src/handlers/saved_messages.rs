use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use utoipa_axum::router::OpenApiRouter;

use crate::{
    dto::saved_messages::{ListSavedMessagesResponse, SavedMessageResponse},
    errors::AppError,
    extractors::DbConn,
    services::saved_messages as saved_messages_svc,
    utils::auth::CurrentUid,
    AppState,
};

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct ListSavedMessagesQuery {
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
struct MessageIdPath {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    message_id: i64,
}

#[derive(Debug, Deserialize)]
struct SavedMessageIdPath {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    saved_message_id: i64,
}

#[utoipa::path(
    get,
    path = "/",
    tag = "saved_messages",
    params(ListSavedMessagesQuery),
    responses(
        (status = OK, body = ListSavedMessagesResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn list_saved_messages(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
    Query(query): Query<ListSavedMessagesQuery>,
) -> Result<Json<ListSavedMessagesResponse>, AppError> {
    let conn = &mut *conn;

    let response =
        saved_messages_svc::list_saved_messages(conn, uid, None, query.before, query.limit)?;

    Ok(Json(response))
}

#[utoipa::path(
    put,
    path = "/{message_id}",
    tag = "saved_messages",
    params(
        ("message_id" = String, Path, description = "Original message ID"),
    ),
    responses(
        (status = OK, body = SavedMessageResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn put_saved_message(
    State(state): State<AppState>,
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
    Path(MessageIdPath { message_id }): Path<MessageIdPath>,
) -> Result<Json<SavedMessageResponse>, AppError> {
    let conn = &mut *conn;

    let response = saved_messages_svc::save_message_snapshot(
        conn,
        &state.media,
        state.users.as_ref(),
        state.id_gen.as_ref(),
        uid,
        message_id,
    )
    .await?;

    Ok(Json(response))
}

#[utoipa::path(
    delete,
    path = "/by-message/{message_id}",
    tag = "saved_messages",
    params(
        ("message_id" = String, Path, description = "Original message ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn delete_saved_message_by_original(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
    Path(MessageIdPath { message_id }): Path<MessageIdPath>,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;

    saved_messages_svc::delete_saved_message_by_original(conn, uid, message_id)?;

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete,
    path = "/by-id/{saved_message_id}",
    tag = "saved_messages",
    params(
        ("saved_message_id" = String, Path, description = "Saved message row ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn delete_saved_message_by_id(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
    Path(SavedMessageIdPath { saved_message_id }): Path<SavedMessageIdPath>,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;

    saved_messages_svc::delete_saved_message_by_id(conn, uid, saved_message_id)?;

    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(list_saved_messages))
        .routes(utoipa_axum::routes!(put_saved_message))
        .routes(utoipa_axum::routes!(delete_saved_message_by_original))
        .routes(utoipa_axum::routes!(delete_saved_message_by_id))
}

#[cfg(test)]
mod tests {
    #[test]
    fn router_constructs_without_route_conflicts() {
        let _router = super::router();
    }
}
