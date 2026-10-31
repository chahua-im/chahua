use chrono::{Duration, Utc};
use diesel::prelude::*;
use diesel::PgConnection;

use crate::dto::attachments::{
    AttachmentConfigResponse, AttachmentUploadPurpose, UploadUrlRequest, UploadUrlResponse,
};
use crate::errors::AppError;
use crate::models::NewAttachment;
use crate::schema::attachments;
use crate::services::media::{attachment_content_disposition, MediaStore};
use crate::utils::ids::{self, IdGen};

pub async fn post_upload_url(
    uid: i32,
    payload: UploadUrlRequest,
    conn: &mut PgConnection,
    id_gen: &IdGen,
    media_store: &MediaStore,
    maximum_size: i64,
) -> Result<UploadUrlResponse, AppError> {
    let purpose = validate_upload_request(&payload, maximum_size)?;
    let content_type = payload
        .content_type
        .parse::<mime::Mime>()
        .map_err(|_| AppError::BadRequest("Attachment content type is invalid"))?
        .to_string();

    let id = ids::next_message_id(id_gen).await.map_err(|error| {
        tracing::error!(?error, "next_message_id for attachment");
        AppError::Internal("Failed to generate ID")
    })?;

    let s3_item_id = uuid::Uuid::new_v4().to_string();
    let key = media_store.attachment_key(&payload.filename, &s3_item_id);
    let content_disposition = (matches!(purpose, AttachmentUploadPurpose::File)
        && payload.purpose.is_some())
    .then(|| attachment_content_disposition(&payload.filename));
    let presigned_upload = media_store
        .presign_upload(
            &key,
            &content_type,
            payload.size,
            content_disposition.as_deref(),
            Duration::minutes(15),
        )
        .await?;

    let new_attachment = NewAttachment {
        id,
        message_id: None,
        uploader_uid: Some(uid),
        file_name: payload.filename,
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

    Ok(UploadUrlResponse {
        attachment_id: id.to_string(),
        upload_url: presigned_upload.upload_url,
        upload_headers: presigned_upload.upload_headers,
    })
}

pub fn get_config(_uid: i32, maximum_size: i64) -> AttachmentConfigResponse {
    AttachmentConfigResponse {
        max_file_size_bytes: maximum_size,
    }
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
        _ => Ok(purpose),
    }
}

#[cfg(test)]
mod tests {
    use super::validate_upload_request;
    use crate::dto::attachments::{AttachmentUploadPurpose, UploadUrlRequest};

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
            &request(1, Some(AttachmentUploadPurpose::File), "image/png"),
            52_428_800,
        )
        .is_ok());
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
