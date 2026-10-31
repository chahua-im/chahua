use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use utoipa_axum::router::OpenApiRouter;

use crate::dto::pins::{CreatePinBody, ListPinsResponse, PinResponse};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::services::api::pins::{self, CreatePinDeps, DeletePinDeps};
use crate::utils::auth::CurrentUid;
use crate::AppState;

#[derive(Deserialize)]
struct ChatIdPath {
    chat_id: i64,
}

#[derive(Deserialize)]
struct PinIdPath {
    chat_id: i64,
    pin_id: i64,
}

#[derive(Deserialize)]
struct ThreadPinsPath {
    chat_id: i64,
    thread_root_id: i64,
}

#[derive(Deserialize)]
struct ThreadPinIdPath {
    chat_id: i64,
    thread_root_id: i64,
    pin_id: i64,
}

#[utoipa::path(
    get,
    path = "/",
    tag = "pins",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
    ),
    responses(
        (status = OK, body = ListPinsResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn list_pins(
    State(state): State<AppState>,
    Path(path): Path<ChatIdPath>,
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<Json<ListPinsResponse>, AppError> {
    let response =
        pins::list_pins(uid, path.chat_id, &mut conn, &state.media, &state.avatars).await?;
    Ok(Json(response))
}

#[utoipa::path(
    post,
    path = "/",
    tag = "pins",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
    ),
    request_body = CreatePinBody,
    responses(
        (status = CREATED, body = PinResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn create_pin(
    State(state): State<AppState>,
    Path(path): Path<ChatIdPath>,
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
    Json(body): Json<CreatePinBody>,
) -> Result<(StatusCode, Json<PinResponse>), AppError> {
    let pin_response = pins::create_pin(
        uid,
        path.chat_id,
        body,
        &mut conn,
        CreatePinDeps {
            id_gen: &state.id_gen,
            media: &state.media,
            avatars: &state.avatars,
            metrics: &state.metrics,
            ws_registry: &state.ws_registry,
            push_service: &state.push_service,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(pin_response)))
}

#[utoipa::path(
    delete,
    path = "/{pin_id}",
    tag = "pins",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("pin_id" = String, Path, description = "Pin ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("bearer_jwt" = [])),
)]
async fn delete_pin(
    State(state): State<AppState>,
    Path(path): Path<PinIdPath>,
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    pins::delete_pin(
        uid,
        path.chat_id,
        path.pin_id,
        &mut conn,
        DeletePinDeps {
            id_gen: &state.id_gen,
            media: &state.media,
            avatars: &state.avatars,
            metrics: &state.metrics,
            ws_registry: &state.ws_registry,
            push_service: &state.push_service,
        },
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/",
    tag = "pins",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("thread_root_id" = String, Path, description = "Thread root message ID"),
    ),
    responses(
        (status = OK, body = ListPinsResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn list_thread_pins(
    State(state): State<AppState>,
    Path(path): Path<ThreadPinsPath>,
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<Json<ListPinsResponse>, AppError> {
    let response = pins::list_thread_pins(
        uid,
        path.chat_id,
        path.thread_root_id,
        &mut conn,
        &state.media,
        &state.avatars,
    )
    .await?;
    Ok(Json(response))
}

#[utoipa::path(
    post,
    path = "/",
    tag = "pins",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("thread_root_id" = String, Path, description = "Thread root message ID"),
    ),
    request_body = CreatePinBody,
    responses(
        (status = CREATED, body = PinResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn create_thread_pin(
    State(state): State<AppState>,
    Path(path): Path<ThreadPinsPath>,
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
    Json(body): Json<CreatePinBody>,
) -> Result<(StatusCode, Json<PinResponse>), AppError> {
    let pin_response = pins::create_thread_pin(
        uid,
        path.chat_id,
        path.thread_root_id,
        body,
        &mut conn,
        CreatePinDeps {
            id_gen: &state.id_gen,
            media: &state.media,
            avatars: &state.avatars,
            metrics: &state.metrics,
            ws_registry: &state.ws_registry,
            push_service: &state.push_service,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(pin_response)))
}

#[utoipa::path(
    delete,
    path = "/{pin_id}",
    tag = "pins",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("thread_root_id" = String, Path, description = "Thread root message ID"),
        ("pin_id" = String, Path, description = "Pin ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("bearer_jwt" = [])),
)]
async fn delete_thread_pin(
    State(state): State<AppState>,
    Path(path): Path<ThreadPinIdPath>,
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    pins::delete_thread_pin(
        uid,
        path.chat_id,
        path.thread_root_id,
        path.pin_id,
        &mut conn,
        DeletePinDeps {
            id_gen: &state.id_gen,
            media: &state.media,
            avatars: &state.avatars,
            metrics: &state.metrics,
            ws_registry: &state.ws_registry,
            push_service: &state.push_service,
        },
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(list_pins, create_pin))
        .routes(utoipa_axum::routes!(delete_pin))
}

pub fn thread_router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(list_thread_pins, create_thread_pin))
        .routes(utoipa_axum::routes!(delete_thread_pin))
}
