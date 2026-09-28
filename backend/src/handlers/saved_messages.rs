use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use utoipa_axum::router::OpenApiRouter;

use crate::{
    dto::{
        messages::ForwardedMessagesResponse,
        saved_messages::{ListSavedMessagesResponse, SavedMessageResponse},
    },
    errors::AppError,
    extractors::DbConn,
    services::{
        messages::{
            deserialize_forwarded_bundle_payload, forwarded_messages_response_from_items,
            load_target_forwarded_bundle_from_root,
        },
        saved_messages as saved_messages_svc,
    },
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

#[derive(Debug, Deserialize)]
struct SavedForwardedBundleMessagesPath {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    saved_message_id: i64,
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    bundle_id: i64,
}

#[utoipa::path(
    get,
    path = "/",
    tag = "saved_messages",
    params(ListSavedMessagesQuery),
    responses(
        (status = OK, body = ListSavedMessagesResponse),
    ),
    security(("bearer_jwt" = [])),
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
    security(("bearer_jwt" = [])),
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
        &state.avatars,
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
    security(("bearer_jwt" = [])),
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
    security(("bearer_jwt" = [])),
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

#[utoipa::path(
    get,
    path = "/{saved_message_id}/forwarded-messages",
    tag = "saved_messages",
    params(
        ("saved_message_id" = String, Path, description = "Saved forwarded message ID"),
    ),
    responses(
        (status = OK, description = "Saved forwarded message details", body = ForwardedMessagesResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_saved_forwarded_messages(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(SavedMessageIdPath { saved_message_id }): Path<SavedMessageIdPath>,
    mut conn: DbConn,
) -> Result<Json<ForwardedMessagesResponse>, AppError> {
    let conn = &mut *conn;
    let bundle = saved_messages_svc::load_saved_forwarded_bundle(conn, uid, saved_message_id)?;
    let (total, items) = deserialize_forwarded_bundle_payload(bundle)?;

    Ok(Json(forwarded_messages_response_from_items(
        conn, &state, total, items,
    )))
}

#[utoipa::path(
    get,
    path = "/{saved_message_id}/forwarded-bundles/{bundle_id}/messages",
    tag = "saved_messages",
    params(
        ("saved_message_id" = String, Path, description = "Saved root forwarded message ID"),
        ("bundle_id" = String, Path, description = "Reachable forwarded bundle ID"),
    ),
    responses(
        (status = OK, description = "Saved forwarded message details", body = ForwardedMessagesResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_saved_forwarded_bundle_messages(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(SavedForwardedBundleMessagesPath {
        saved_message_id,
        bundle_id,
    }): Path<SavedForwardedBundleMessagesPath>,
    mut conn: DbConn,
) -> Result<Json<ForwardedMessagesResponse>, AppError> {
    let conn = &mut *conn;
    let root_bundle = saved_messages_svc::load_saved_forwarded_bundle(conn, uid, saved_message_id)?;
    let bundle = load_target_forwarded_bundle_from_root(conn, root_bundle, bundle_id)?;
    let (total, items) = deserialize_forwarded_bundle_payload(bundle)?;

    Ok(Json(forwarded_messages_response_from_items(
        conn, &state, total, items,
    )))
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(list_saved_messages))
        .routes(utoipa_axum::routes!(put_saved_message))
        .routes(utoipa_axum::routes!(delete_saved_message_by_original))
        .routes(utoipa_axum::routes!(delete_saved_message_by_id))
        .routes(utoipa_axum::routes!(get_saved_forwarded_messages))
        .routes(utoipa_axum::routes!(get_saved_forwarded_bundle_messages))
}
