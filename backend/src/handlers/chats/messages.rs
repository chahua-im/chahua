use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use utoipa_axum::router::OpenApiRouter;

use crate::{
    dto::{
        messages::{
            BulkDeleteMessagesBody, CreateMessageBody, ForwardMessageBody, ForwardMessagesBody,
            ForwardedMessagesResponse, ListMessagesQuery, ListMessagesResponse, MessageResponse,
            SearchMessagesQuery, SearchMessagesResponse, UpdateMessageBody,
        },
        ws::BulkDeletedPayload,
    },
    errors::AppError,
    extractors::DbConn,
    services::authentication::Principal,
    utils::auth::CurrentUid,
    AppState,
};

use super::ChatIdPath;

#[derive(serde::Deserialize)]
pub struct ThreadIdPath {
    chat_id: i64,
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    thread_id: i64,
}

#[derive(serde::Deserialize)]
pub struct MessageIdPath {
    chat_id: i64,
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    message_id: i64,
}

#[derive(serde::Deserialize)]
pub struct ForwardedBundleMessagesPath {
    chat_id: i64,
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    message_id: i64,
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    bundle_id: i64,
}

/// GET /chats/:chat_id/messages — List messages in a chat (cursor-based).
#[utoipa::path(
    get,
    path = "/",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ListMessagesQuery,
    ),
    responses(
        (status = 200, description = "List of messages", body = ListMessagesResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_messages(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Query(q): Query<ListMessagesQuery>,
) -> Result<Json<ListMessagesResponse>, AppError> {
    crate::services::api::chats::messages::get_messages(
        uid,
        chat_id,
        q,
        &mut conn,
        &state.media,
        &state.avatars,
    )
    .await
    .map(Json)
}

/// GET /chats/:chat_id/messages/search — Search visible messages in a chat.
#[utoipa::path(
    get,
    path = "/search",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        SearchMessagesQuery,
    ),
    responses(
        (status = 200, description = "Search results", body = SearchMessagesResponse),
        (status = 400, description = "Invalid search query"),
        (status = 503, description = "Message search unavailable"),
    ),
    security(("bearer_jwt" = [])),
)]
async fn search_messages(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Query(params): Query<SearchMessagesQuery>,
) -> Result<Json<SearchMessagesResponse>, AppError> {
    crate::services::api::chats::messages::search_messages(
        uid,
        chat_id,
        params,
        &mut conn,
        crate::services::api::chats::messages::SearchMessagesDeps {
            media: &state.media,
            avatars: &state.avatars,
            metrics: &state.metrics,
            message_search: &state.message_search,
        },
    )
    .await
    .map(Json)
}

/// GET /chats/:chat_id/messages/:message_id — Get a single message.
#[utoipa::path(
    get,
    path = "/{message_id}",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("message_id" = String, Path, description = "Message ID"),
    ),
    responses(
        (status = 200, description = "Single message", body = MessageResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_message(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(MessageIdPath {
        chat_id,
        message_id,
    }): Path<MessageIdPath>,
    mut conn: DbConn,
) -> Result<Json<MessageResponse>, AppError> {
    crate::services::api::chats::messages::get_message(
        uid,
        chat_id,
        message_id,
        &mut conn,
        &state.media,
        &state.avatars,
    )
    .await
    .map(Json)
}

/// POST /chats/:chat_id/messages — Send a message.
#[utoipa::path(
    post,
    path = "/",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth"),
    ),
    request_body = CreateMessageBody,
    responses((status = 201, description = "Message created", body = MessageResponse)),
    security(("bearer_jwt" = []), ("service_token_bearer" = [])),
)]
async fn post_message(
    principal: Principal,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Json(body): Json<CreateMessageBody>,
) -> Result<impl IntoResponse, AppError> {
    let response = crate::services::api::chats::messages::post_message(
        principal,
        chat_id,
        body,
        &mut conn,
        crate::services::api::chats::messages::PostMessageDeps {
            id_gen: &state.id_gen,
            media: &state.media,
            avatars: &state.avatars,
            link_previews: &state.link_previews,
            metrics: &state.metrics,
            authz_service: &state.authz_service,
            ws_registry: &state.ws_registry,
            push_service: &state.push_service,
            message_search: &state.message_search,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(response)))
}

/// POST /chats/:chat_id/messages/forward — Merge 2–100 distinct messages into a chat or thread.
#[utoipa::path(
    post,
    path = "/forward",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Destination Chat ID"),
    ),
    request_body = ForwardMessagesBody,
    responses(
        (status = CREATED, body = MessageResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn forward_messages(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath {
        chat_id: dest_chat_id,
    }): Path<ChatIdPath>,
    mut conn: DbConn,
    Json(body): Json<ForwardMessagesBody>,
) -> Result<impl IntoResponse, AppError> {
    let response = crate::services::api::chats::messages::forward_messages(
        uid,
        dest_chat_id,
        body,
        &mut conn,
        crate::services::api::chats::messages::ForwardMessagesDeps {
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

/// Single forwards retain the original message type, with flattened attribution.
#[utoipa::path(
    post,
    path = "/{message_id}/forward",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Destination Chat ID"),
        ("message_id" = String, Path, description = "Source Message ID"),
    ),
    request_body = ForwardMessageBody,
    responses((status = CREATED, body = MessageResponse)),
    security(("bearer_jwt" = [])),
)]
async fn forward_message(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(MessageIdPath {
        chat_id,
        message_id,
    }): Path<MessageIdPath>,
    mut conn: DbConn,
    Json(body): Json<ForwardMessageBody>,
) -> Result<impl IntoResponse, AppError> {
    let response = crate::services::api::chats::messages::forward_message(
        uid,
        chat_id,
        message_id,
        body,
        &mut conn,
        crate::services::api::chats::messages::ForwardMessageDeps {
            id_gen: &state.id_gen,
            media: &state.media,
            avatars: &state.avatars,
            metrics: &state.metrics,
            ws_registry: &state.ws_registry,
            push_service: &state.push_service,
            message_search: &state.message_search,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(response)))
}

/// GET /chats/:chat_id/messages/:message_id/forwarded-messages — List forwarded message details.
#[utoipa::path(
    get,
    path = "/{message_id}/forwarded-messages",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("message_id" = String, Path, description = "Forwarded message ID"),
    ),
    responses(
        (status = 200, description = "Forwarded message details", body = ForwardedMessagesResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_forwarded_messages(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(MessageIdPath {
        chat_id,
        message_id,
    }): Path<MessageIdPath>,
    mut conn: DbConn,
) -> Result<Json<ForwardedMessagesResponse>, AppError> {
    crate::services::api::chats::messages::get_forwarded_messages(
        uid,
        chat_id,
        message_id,
        &mut conn,
        &state.media,
        &state.avatars,
    )
    .map(Json)
}

/// GET /chats/:chat_id/messages/:message_id/forwarded-bundles/:bundle_id/messages — List forwarded message details by reachable bundle.
#[utoipa::path(
    get,
    path = "/{message_id}/forwarded-bundles/{bundle_id}/messages",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("message_id" = String, Path, description = "Root forwarded message ID"),
        ("bundle_id" = String, Path, description = "Reachable forwarded bundle ID"),
    ),
    responses(
        (status = 200, description = "Forwarded message details", body = ForwardedMessagesResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_forwarded_bundle_messages(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ForwardedBundleMessagesPath {
        chat_id,
        message_id,
        bundle_id,
    }): Path<ForwardedBundleMessagesPath>,
    mut conn: DbConn,
) -> Result<Json<ForwardedMessagesResponse>, AppError> {
    crate::services::api::chats::messages::get_forwarded_bundle_messages(
        uid,
        chat_id,
        message_id,
        bundle_id,
        &mut conn,
        &state.media,
        &state.avatars,
    )
    .map(Json)
}

/// POST /chats/:chat_id/threads/:thread_id/messages — Send a message in a thread.
#[utoipa::path(
    post,
    path = "/threads/{thread_id}/messages",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("thread_id" = String, Path, description = "Thread root message ID"),
    ),
    request_body = CreateMessageBody,
    responses(
        (status = 201, description = "Thread message created", body = MessageResponse),
    ),
    security(("bearer_jwt" = [])),
)]
pub(super) async fn post_thread_message(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ThreadIdPath { chat_id, thread_id }): Path<ThreadIdPath>,
    mut conn: DbConn,
    Json(body): Json<CreateMessageBody>,
) -> Result<impl IntoResponse, AppError> {
    let response = crate::services::api::chats::messages::post_thread_message(
        uid,
        chat_id,
        thread_id,
        body,
        &mut conn,
        crate::services::api::chats::messages::PostThreadMessageDeps {
            id_gen: &state.id_gen,
            media: &state.media,
            avatars: &state.avatars,
            link_previews: &state.link_previews,
            metrics: &state.metrics,
            ws_registry: &state.ws_registry,
            push_service: &state.push_service,
            message_search: &state.message_search,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(response)))
}

/// PATCH /chats/:chat_id/messages/:message_id — Edit a message.
#[utoipa::path(
    patch,
    path = "/{message_id}",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("message_id" = String, Path, description = "Message ID"),
    ),
    request_body = UpdateMessageBody,
    responses(
        (status = 200, description = "Updated message", body = MessageResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn patch_message(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(MessageIdPath {
        chat_id,
        message_id,
    }): Path<MessageIdPath>,
    mut conn: DbConn,
    Json(body): Json<UpdateMessageBody>,
) -> Result<Json<MessageResponse>, AppError> {
    crate::services::api::chats::messages::patch_message(
        uid,
        chat_id,
        message_id,
        body,
        &mut conn,
        crate::services::api::chats::messages::PatchMessageDeps {
            media: &state.media,
            avatars: &state.avatars,
            link_previews: &state.link_previews,
            ws_registry: &state.ws_registry,
            message_search: &state.message_search,
        },
    )
    .await
    .map(Json)
}

/// DELETE /chats/:chat_id/messages/:message_id — Delete a message (soft delete).
#[utoipa::path(
    delete,
    path = "/{message_id}",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("message_id" = String, Path, description = "Message ID"),
    ),
    responses(
        (status = 204, description = "Message deleted"),
        (status = 400, description = "System or unpublished message cannot be deleted"),
    ),
    security(("bearer_jwt" = [])),
)]
async fn delete_message(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(MessageIdPath {
        chat_id,
        message_id,
    }): Path<MessageIdPath>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    crate::services::api::chats::messages::delete_message(
        uid,
        chat_id,
        message_id,
        &mut conn,
        crate::services::api::chats::messages::DeleteMessageDeps {
            media: &state.media,
            avatars: &state.avatars,
            ws_registry: &state.ws_registry,
            message_search: &state.message_search,
        },
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Delete a selection atomically. Already deleted messages are accepted on retry.
#[utoipa::path(
    post,
    path = "/bulk-delete",
    tag = "chats",
    params(("chat_id" = String, Path, description = "Chat ID")),
    request_body = BulkDeleteMessagesBody,
    responses(
        (status = 200, description = "Selection deleted and metadata reconciled", body = BulkDeletedPayload),
        (status = 400, description = "Invalid selection size, system message or unpublished message"),
        (status = 403, description = "Chat is not writable or a message cannot be deleted by this user"),
        (status = 404, description = "A selected message does not belong to this chat"),
    ),
    security(("bearer_jwt" = [])),
)]
async fn bulk_delete_messages(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Json(body): Json<BulkDeleteMessagesBody>,
) -> Result<Json<BulkDeletedPayload>, AppError> {
    crate::services::api::chats::messages::bulk_delete_messages(
        uid,
        chat_id,
        body,
        &mut conn,
        crate::services::api::chats::messages::BulkDeleteMessagesDeps {
            media: &state.media,
            avatars: &state.avatars,
            ws_registry: &state.ws_registry,
            message_search: &state.message_search,
        },
    )
    .await
    .map(Json)
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(get_messages, post_message))
        .routes(utoipa_axum::routes!(forward_messages))
        .routes(utoipa_axum::routes!(bulk_delete_messages))
        .routes(utoipa_axum::routes!(forward_message))
        .routes(utoipa_axum::routes!(get_forwarded_messages))
        .routes(utoipa_axum::routes!(get_forwarded_bundle_messages))
        .routes(utoipa_axum::routes!(search_messages))
        .routes(utoipa_axum::routes!(
            get_message,
            patch_message,
            delete_message
        ))
}

#[cfg(test)]
mod tests {
    #[test]
    fn message_query_documentation_matches_runtime_names_and_preserves_id_precision() {
        let document = serde_json::to_value(super::router().into_openapi()).unwrap();
        let parameters = document["paths"]["/"]["get"]["parameters"]
            .as_array()
            .unwrap();
        let query: Vec<_> = parameters
            .iter()
            .filter(|parameter| parameter["in"] == "query")
            .collect();
        assert_eq!(query.len(), 5);
        assert!(!query
            .iter()
            .any(|parameter| parameter["name"] == "thread_id"));
        for name in ["before", "around", "after", "threadId"] {
            let parameter = query
                .iter()
                .find(|parameter| parameter["name"] == name)
                .unwrap();
            assert_eq!(parameter["schema"]["type"], "string", "{name}");
            assert_eq!(parameter["required"], false, "{name}");
        }
        let uri = "/?threadId=9223372036854775807&after=9007199254740993"
            .parse()
            .unwrap();
        let parsed = axum::extract::Query::<super::ListMessagesQuery>::try_from_uri(&uri).unwrap();
        assert_eq!(parsed.thread_id, Some(i64::MAX));
        assert_eq!(parsed.after, Some(9_007_199_254_740_993));
    }
}
