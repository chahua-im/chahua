use axum::{
    extract::{Json, State},
    http::StatusCode,
    response::IntoResponse,
};
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::attachments::{AttachmentConfigResponse, UploadUrlRequest, UploadUrlResponse};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::services::api::attachments;
use crate::utils::auth::CurrentUid;
use crate::AppState;

#[utoipa::path(
    post,
    path = "/upload-url",
    tag = "attachments",
    request_body = UploadUrlRequest,
    responses(
        (status = 201, description = "Upload URL created", body = UploadUrlResponse),
        (status = 400, description = "Invalid attachment metadata"),
        (status = 413, description = "Attachment exceeds maximum file size")
    ),
    security(("bearer_jwt" = []))
)]
async fn post_upload_url(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    conn: DbConn,
    Json(payload): Json<UploadUrlRequest>,
) -> Result<impl IntoResponse, AppError> {
    conn.run(move |mut conn| async move {
        let response = attachments::post_upload_url(
            uid,
            payload,
            &mut conn,
            state.id_gen.as_ref(),
            &state.media,
            state.config.media.max_attachment_file_size_bytes,
        )
        .await?;
        Ok((StatusCode::CREATED, Json(response)))
    })
    .await
}

#[utoipa::path(
    get,
    path = "/config",
    tag = "attachments",
    responses((status = 200, body = AttachmentConfigResponse)),
    security(("bearer_jwt" = []))
)]
async fn get_config(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
) -> Json<AttachmentConfigResponse> {
    Json(attachments::get_config(
        uid,
        state.config.media.max_attachment_file_size_bytes,
    ))
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new().routes(routes!(post_upload_url, get_config))
}
