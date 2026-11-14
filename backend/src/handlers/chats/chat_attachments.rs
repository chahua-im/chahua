use axum::{
    extract::{Path, Query, State},
    Json,
};
use utoipa_axum::router::OpenApiRouter;

use crate::dto::attachments::{
    ChatAttachmentKindFilter, ListChatAttachmentsQuery, ListChatAttachmentsResponse,
};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::handlers::chats::ChatIdPath;
use crate::services::api::chats::chat_attachments;
use crate::utils::auth::CurrentUid;
use crate::AppState;

/// GET /chats/:chat_id/attachments — List chat attachments by media kind.
#[utoipa::path(
    get,
    path = "/",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("kind" = ChatAttachmentKindFilter, Query, description = "Required attachment kind filter: image, video, other, or all"),
        ("limit" = Option<i64>, Query, description = "Target minimum number of attachments to return. The response can exceed this value so attachments from one message are not split across pages."),
        ("before" = Option<String>, Query, description = "Fetch older attachments before this message ID cursor. Use olderCursor from the previous response."),
        ("after" = Option<String>, Query, description = "Fetch newer attachments after this message ID cursor. Use newerCursor from the previous response."),
    ),
    responses(
        (status = 200, description = "List of chat attachments. olderCursor fetches older pages via before; newerCursor fetches newer pages via after. A null cursor means no more currently known results in that direction.", body = ListChatAttachmentsResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_chat_attachments(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    conn: DbConn,
    Query(query): Query<ListChatAttachmentsQuery>,
) -> Result<Json<ListChatAttachmentsResponse>, AppError> {
    conn.run(move |mut conn| async move {
        Ok(Json(chat_attachments::get_chat_attachments(
            uid,
            chat_id,
            query,
            &mut conn,
            &state.media,
            state.avatars.as_ref(),
        )?))
    })
    .await
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new().routes(utoipa_axum::routes!(get_chat_attachments))
}
