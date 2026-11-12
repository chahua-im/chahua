use crate::{
    dto::messages::{SearchMessagesQuery, SearchMessagesResponse},
    errors::AppError,
    extractors::DbConn,
    utils::auth::CurrentUid,
    AppState,
};
use axum::{
    extract::{Query, State},
    Json,
};
use utoipa_axum::router::OpenApiRouter;
#[utoipa::path(get, path = "/messages/search", tag = "chats", params(SearchMessagesQuery),
responses((status = 200, body = SearchMessagesResponse), (status = 400, description = "Invalid query"), (status = 503, description = "Search unavailable")),
security(("bearer_jwt" = [])))]
async fn search(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(query): Query<SearchMessagesQuery>,
) -> Result<Json<SearchMessagesResponse>, AppError> {
    crate::services::api::chats::messages::search_messages_in_scope(
        uid,
        None,
        query,
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
pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(utoipa_axum::routes!(search))
}
