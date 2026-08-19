use axum::{
    extract::{Json, State},
    http::StatusCode,
};
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::dms::{CreateDmBody, DmResponse};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::handlers::users::build_member_summary_map;
use crate::services::social;
use crate::services::user::lookup_user_profiles;
use crate::utils::auth::CurrentUid;
use crate::AppState;

/// POST /dms - Find or create a 1:1 DM with `peerUid`.
#[utoipa::path(
    post,
    path = "/",
    tag = "dms",
    request_body = CreateDmBody,
    responses(
        (status = 200, description = "Existing or newly created DM", body = DmResponse),
        (status = 403, description = "Not mutual friends or blocked")
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn create_dm(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<CreateDmBody>,
) -> Result<(StatusCode, Json<DmResponse>), AppError> {
    let conn = &mut *conn;

    // Validate the peer exists before doing any DM work.
    let profiles = lookup_user_profiles(conn, &[body.peer_uid])?;
    if !profiles.contains_key(&body.peer_uid) {
        return Err(AppError::NotFound("User not found"));
    }

    // find_or_create_dm enforces mutual-friendship + not-blocked via
    // check_can_dm on creation; for an existing DM it returns the id directly.
    let chat_id = social::find_or_create_dm(conn, &state, uid, body.peer_uid).await?;

    let mut summaries = build_member_summary_map(conn, &state, &[body.peer_uid])?;
    let peer = summaries
        .remove(&body.peer_uid)
        .unwrap_or(crate::dto::users::MemberSummary {
            uid: body.peer_uid,
            username: None,
            avatar_url: None,
            gender: 0,
            user_group: None,
        });

    Ok((StatusCode::OK, Json(DmResponse { id: chat_id, peer })))
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(create_dm))
}
