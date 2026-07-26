use aws_sdk_s3::presigning::PresigningConfig;
use axum::{
    extract::{Json, State},
    http::StatusCode,
    response::IntoResponse,
};
use chrono::{Duration, Utc};
use diesel::prelude::*;
use serde::Deserialize;
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::attachments::UploadUrlResponse;
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::utils::auth::CurrentUid;
use crate::utils::ids;
use crate::{models::NewAttachment, schema::attachments, AppState};

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UploadUrlRequest {
    filename: String,
    content_type: String,
    size: i64,
    width: Option<i32>,
    height: Option<i32>,
    order: Option<i16>,
}

// Kept for potential future use or non-public buckets
#[allow(dead_code)]
pub async fn get_presigned_url(
    s3_client: &aws_sdk_s3::Client,
    bucket: &str,
    key: &str,
    expires_in: Duration,
) -> Result<String, AppError> {
    let presigning_config =
        PresigningConfig::expires_in(expires_in.to_std().unwrap()).map_err(|e| {
            tracing::error!("presigning config error: {:?}", e);
            AppError::Internal("Failed to configure presigned URL")
        })?;

    let presigned_request = s3_client
        .get_object()
        .bucket(bucket)
        .key(key)
        .presigned(presigning_config)
        .await
        .map_err(|e| {
            tracing::error!("Failed to generate presigned GET URL: {:?}", e);
            AppError::Internal("Failed to generate attachment URL")
        })?;

    Ok(presigned_request.uri().to_string())
}

#[utoipa::path(
    post,
    path = "/upload-url",
    tag = "attachments",
    request_body = UploadUrlRequest,
    responses(
        (status = 201, description = "Upload URL created", body = UploadUrlResponse)
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn post_upload_url(
    CurrentUid(_uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(payload): Json<UploadUrlRequest>,
) -> Result<impl IntoResponse, AppError> {
    let conn = &mut *conn;

    let id = ids::next_message_id(state.id_gen.as_ref())
        .await
        .map_err(|e| {
            tracing::error!("next_message_id for attachment: {:?}", e);
            AppError::Internal("Failed to generate ID")
        })?;

    let s3_item_id = uuid::Uuid::new_v4().to_string();

    let key = state.media.attachment_key(&payload.filename, &s3_item_id);
    let expires_in = Duration::minutes(15);
    let presigned_upload = state
        .media
        .presign_upload(&key, &payload.content_type, expires_in)
        .await?;

    let new_attachment = NewAttachment {
        id,
        message_id: None,
        file_name: payload.filename.clone(),
        kind: payload.content_type.clone(),
        external_reference: key.clone(),
        size: payload.size,
        created_at: Utc::now(),
        deleted_at: None,
        width: payload.width,
        height: payload.height,
        order: payload.order.unwrap_or(0),
    };

    diesel::insert_into(attachments::table)
        .values(&new_attachment)
        .execute(conn)?;

    let response = UploadUrlResponse {
        attachment_id: id.to_string(),
        upload_url: presigned_upload.upload_url,
        upload_headers: presigned_upload.upload_headers,
    };

    Ok((StatusCode::CREATED, Json(response)))
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new().routes(routes!(post_upload_url))
}
