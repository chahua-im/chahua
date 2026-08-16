use aws_sdk_s3::presigning::PresigningConfig;
use axum::{
    extract::{Json, State},
    http::StatusCode,
    response::IntoResponse,
};
use chrono::{Duration, Utc};
use diesel::prelude::*;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::attachments::{AttachmentConfigResponse, UploadUrlResponse};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::utils::auth::CurrentUid;
use crate::utils::ids;
use crate::{models::NewAttachment, schema::attachments, AppState};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentUploadPurpose {
    Media,
    Voice,
    File,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UploadUrlRequest {
    filename: String,
    content_type: String,
    size: i64,
    purpose: Option<AttachmentUploadPurpose>,
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
        (status = 201, description = "Upload URL created", body = UploadUrlResponse),
        (status = 400, description = "Invalid attachment metadata"),
        (status = 413, description = "Attachment exceeds maximum file size")
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn post_upload_url(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(payload): Json<UploadUrlRequest>,
) -> Result<impl IntoResponse, AppError> {
    let conn = &mut *conn;
    let purpose =
        validate_upload_request(&payload, state.config.media.max_attachment_file_size_bytes)?;
    let content_type = payload
        .content_type
        .parse::<mime::Mime>()
        .map_err(|_| AppError::BadRequest("Attachment content type is invalid"))?
        .to_string();

    let id = ids::next_message_id(state.id_gen.as_ref())
        .await
        .map_err(|e| {
            tracing::error!("next_message_id for attachment: {:?}", e);
            AppError::Internal("Failed to generate ID")
        })?;

    let s3_item_id = uuid::Uuid::new_v4().to_string();
    let key = state.media.attachment_key(&payload.filename, &s3_item_id);
    let expires_in = Duration::minutes(15);

    let content_disposition = (matches!(purpose, AttachmentUploadPurpose::File)
        && payload.purpose.is_some())
    .then(|| crate::services::media::attachment_content_disposition(&payload.filename));
    let presigned_upload = state
        .media
        .presign_upload(
            &key,
            &content_type,
            payload.size,
            content_disposition.as_deref(),
            expires_in,
        )
        .await?;

    let new_attachment = NewAttachment {
        id,
        message_id: None,
        uploader_uid: Some(uid),
        file_name: payload.filename.clone(),
        kind: content_type,
        external_reference: key,
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

#[utoipa::path(
    get,
    path = "/config",
    tag = "attachments",
    responses((status = 200, body = AttachmentConfigResponse)),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn get_config(
    CurrentUid(_uid): CurrentUid,
    State(state): State<AppState>,
) -> Json<AttachmentConfigResponse> {
    Json(AttachmentConfigResponse {
        max_file_size_bytes: state.config.media.max_attachment_file_size_bytes,
    })
}

fn legacy_upload_purpose(mime: &mime::Mime) -> AttachmentUploadPurpose {
    if mime.type_() == mime::IMAGE || mime.type_() == mime::VIDEO {
        AttachmentUploadPurpose::Media
    } else if mime.type_() == mime::AUDIO {
        AttachmentUploadPurpose::Voice
    } else {
        AttachmentUploadPurpose::File
    }
}

fn validate_upload_request(
    payload: &UploadUrlRequest,
    maximum_size: i64,
) -> Result<AttachmentUploadPurpose, AppError> {
    if payload.filename.trim().is_empty() {
        return Err(AppError::BadRequest("Attachment filename is required"));
    }
    if payload.filename.chars().count() > 255 {
        return Err(AppError::BadRequest("Attachment filename is too long"));
    }
    let mime = payload
        .content_type
        .parse::<mime::Mime>()
        .map_err(|_| AppError::BadRequest("Attachment content type is invalid"))?;
    if payload.size <= 0 {
        return Err(AppError::BadRequest("Attachment size must be positive"));
    }
    if payload.size > maximum_size {
        return Err(AppError::PayloadTooLarge(
            "Attachment exceeds maximum file size",
        ));
    }
    let purpose = payload
        .purpose
        .unwrap_or_else(|| legacy_upload_purpose(&mime));
    match purpose {
        AttachmentUploadPurpose::Media
            if mime.type_() != mime::IMAGE && mime.type_() != mime::VIDEO =>
        {
            Err(AppError::BadRequest(
                "Media uploads must be images or videos",
            ))
        }
        AttachmentUploadPurpose::Voice if mime.type_() != mime::AUDIO => {
            Err(AppError::BadRequest("Voice uploads must be audio"))
        }
        AttachmentUploadPurpose::File
            if mime.type_() == mime::IMAGE || mime.type_() == mime::VIDEO =>
        {
            Err(AppError::BadRequest(
                "Image and video uploads must use media purpose",
            ))
        }
        _ => Ok(purpose),
    }
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new().routes(routes!(post_upload_url, get_config))
}
#[cfg(test)]
mod tests {
    use super::{validate_upload_request, AttachmentUploadPurpose, UploadUrlRequest};

    fn request(
        size: i64,
        purpose: Option<AttachmentUploadPurpose>,
        content_type: &str,
    ) -> UploadUrlRequest {
        UploadUrlRequest {
            filename: "file.bin".to_string(),
            content_type: content_type.to_string(),
            size,
            purpose,
            width: None,
            height: None,
            order: None,
        }
    }

    #[test]
    fn validates_size_boundaries_and_purpose_mime_pairs() {
        assert!(validate_upload_request(
            &request(
                52_428_800,
                Some(AttachmentUploadPurpose::File),
                "application/pdf"
            ),
            52_428_800,
        )
        .is_ok());
        assert!(validate_upload_request(
            &request(0, Some(AttachmentUploadPurpose::File), "application/pdf"),
            52_428_800,
        )
        .is_err());
        assert!(matches!(
            validate_upload_request(
                &request(
                    52_428_801,
                    Some(AttachmentUploadPurpose::File),
                    "application/pdf"
                ),
                52_428_800,
            ),
            Err(crate::errors::AppError::PayloadTooLarge(_))
        ));
        assert!(validate_upload_request(
            &request(1, Some(AttachmentUploadPurpose::Media), "application/pdf"),
            52_428_800,
        )
        .is_err());
        assert!(validate_upload_request(
            &request(1, Some(AttachmentUploadPurpose::Voice), "audio/ogg"),
            52_428_800,
        )
        .is_ok());

        assert!(matches!(
            validate_upload_request(&request(1, None, "image/png"), 52_428_800),
            Ok(AttachmentUploadPurpose::Media)
        ));
        assert!(matches!(
            validate_upload_request(&request(1, None, "audio/ogg"), 52_428_800),
            Ok(AttachmentUploadPurpose::Voice)
        ));
        assert!(matches!(
            validate_upload_request(&request(1, None, "application/pdf"), 52_428_800),
            Ok(AttachmentUploadPurpose::File)
        ));
    }

    #[test]
    fn legacy_upload_url_request_without_purpose_is_accepted() {
        let request: UploadUrlRequest = serde_json::from_value(serde_json::json!({
            "filename": "photo.jpg",
            "contentType": "image/jpeg",
            "size": 1,
        }))
        .expect("legacy upload request should deserialize");

        assert!(matches!(
            validate_upload_request(&request, 52_428_800),
            Ok(AttachmentUploadPurpose::Media)
        ));
    }
}
