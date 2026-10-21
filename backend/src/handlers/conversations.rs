use axum::{extract::State, Json};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::{
    dto::conversations::{ConversationUnreadRequest, ConversationUnreadResponse},
    errors::AppError,
    extractors::DbConn,
    services::unread::validate_conversation_views,
    utils::auth::CurrentUid,
    AppState,
};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(unread_summary))
}

/// Batch unread summaries for authorized main chats and subscribed threads.
#[utoipa::path(
    post,
    path = "/unread-summary",
    tag = "conversations",
    request_body = ConversationUnreadRequest,
    responses((status = 200, body = ConversationUnreadResponse), (status = 400, description = "Invalid views")),
    security(("bearer_jwt" = [])),
)]
async fn unread_summary(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<ConversationUnreadRequest>,
) -> Result<Json<ConversationUnreadResponse>, AppError> {
    validate_conversation_views(&body.views)?;
    let summaries = state
        .unread_service
        .conversation_summaries(&mut conn, uid, &body.views)?;
    Ok(Json(ConversationUnreadResponse { summaries }))
}
