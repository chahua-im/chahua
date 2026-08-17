use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::primitives::ByteStream;
use axum::http::StatusCode;
use chrono::Duration;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use std::collections::BTreeMap;

use std::sync::Arc;

use crate::config::MediaConfig;

pub const PUBLIC_MEDIA_CACHE_CONTROL: &str = "public,max-age=31536000,immutable";
/// RFC 5987 allows only `attr-char` unescaped in an extended parameter value,
/// so everything outside that set is percent-encoded.
const CONTENT_DISPOSITION_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'!')
    .remove(b'#')
    .remove(b'$')
    .remove(b'&')
    .remove(b'+')
    .remove(b'-')
    .remove(b'.')
    .remove(b'^')
    .remove(b'_')
    .remove(b'`')
    .remove(b'|')
    .remove(b'~');

pub struct PresignedUpload {
    pub upload_url: String,
    pub upload_headers: BTreeMap<String, String>,
}

/// Object storage for user media: attachments, avatars and stickers.
///
/// Owns the S3 client together with the bucket it addresses, so callers never
/// have to thread `(client, bucket, prefix)` triples around. Cloning is two
/// refcount bumps — the AWS client is internally reference counted.
#[derive(Clone)]
pub struct MediaStore {
    client: aws_sdk_s3::Client,
    config: Arc<MediaConfig>,
}

impl MediaStore {
    pub fn new(client: aws_sdk_s3::Client, config: Arc<MediaConfig>) -> Self {
        Self { client, config }
    }

    /// Storage key for an attachment, under the configured attachment prefix.
    pub fn attachment_key(&self, filename: &str, object_id: &str) -> String {
        build_storage_key(&self.config.attachment_prefix, filename, object_id)
    }

    /// Publicly reachable URL for an already-uploaded object.
    pub fn public_url(&self, storage_key: &str) -> String {
        match self.config.base_url.as_deref() {
            Some(base_url) => format!("{}/{}", base_url, storage_key),
            None => format!(
                "https://{}.s3.amazonaws.com/{}",
                self.config.bucket, storage_key
            ),
        }
    }

    /// Presigned `PUT` URL letting a client upload directly to the bucket.
    pub async fn presign_upload(
        &self,
        storage_key: &str,
        content_type: &str,
        content_length: i64,
        content_disposition: Option<&str>,
        expires_in: Duration,
    ) -> Result<PresignedUpload, (StatusCode, &'static str)> {
        let presigning_config = PresigningConfig::expires_in(
            expires_in
                .to_std()
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Invalid URL expiry"))?,
        )
        .map_err(|e| {
            tracing::error!("presigning config error: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to configure presigned URL",
            )
        })?;

        let mut request = self
            .client
            .put_object()
            .bucket(&self.config.bucket)
            .key(storage_key)
            .content_type(content_type)
            .cache_control(PUBLIC_MEDIA_CACHE_CONTROL)
            .content_length(content_length)
            .acl(aws_sdk_s3::types::ObjectCannedAcl::PublicRead);
        if let Some(content_disposition) = content_disposition {
            request = request.content_disposition(content_disposition);
        }
        let presigned_request = request.presigned(presigning_config).await.map_err(|e| {
            tracing::error!("Failed to generate presigned URL: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to generate upload URL",
            )
        })?;

        let mut upload_headers: BTreeMap<String, String> = presigned_request
            .headers()
            .filter(|(name, _)| !name.eq_ignore_ascii_case("content-length"))
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect();
        if content_disposition.is_none() {
            upload_headers.remove("content-disposition");
        }
        Ok(PresignedUpload {
            upload_url: presigned_request.uri().to_string(),
            upload_headers,
        })
    }

    /// Upload an object the server already holds in memory.
    pub async fn put_object(
        &self,
        storage_key: &str,
        content_type: &str,
        body: ByteStream,
    ) -> Result<(), (StatusCode, &'static str)> {
        self.client
            .put_object()
            .bucket(&self.config.bucket)
            .key(storage_key)
            .content_type(content_type)
            .cache_control(PUBLIC_MEDIA_CACHE_CONTROL)
            .acl(aws_sdk_s3::types::ObjectCannedAcl::PublicRead)
            .body(body)
            .send()
            .await
            .map_err(|e| {
                tracing::error!("Failed to upload object: {:?}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, "Failed to upload media")
            })?;

        Ok(())
    }

    /// Download an object in full.
    pub async fn get_object(
        &self,
        storage_key: &str,
    ) -> Result<Vec<u8>, (StatusCode, &'static str)> {
        let object = self
            .client
            .get_object()
            .bucket(&self.config.bucket)
            .key(storage_key)
            .send()
            .await
            .map_err(|e| {
                tracing::error!("Failed to download object {}: {:?}", storage_key, e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to download media",
                )
            })?;

        let bytes = object.body.collect().await.map_err(|e| {
            tracing::error!("Failed to read object body {}: {:?}", storage_key, e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to read media")
        })?;

        Ok(bytes.into_bytes().to_vec())
    }

    /// Best-effort delete, used to roll back an upload whose database write
    /// failed. A leaked object is preferable to failing the rollback path.
    pub async fn delete_object(&self, storage_key: &str) {
        if let Err(e) = self
            .client
            .delete_object()
            .bucket(&self.config.bucket)
            .key(storage_key)
            .send()
            .await
        {
            tracing::error!("Failed to delete object {}: {:?}", storage_key, e);
        }
    }
}

/// Storage key for an object under an explicit prefix. Prefer
/// [`MediaStore::attachment_key`] unless the caller owns a different prefix
/// (stickers, for instance).
pub fn build_storage_key(prefix: &str, filename: &str, object_id: &str) -> String {
    let extension = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    format!("{}/{}.{}", prefix, object_id, extension)
}

/// Builds a safe RFC 5987 attachment disposition without trusting filename syntax.
pub fn attachment_content_disposition(filename: &str) -> String {
    let fallback: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii() && !c.is_control() && c != '"' && c != '\\' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let fallback = if fallback.is_empty() {
        "attachment"
    } else {
        &fallback
    };
    format!(
        "attachment; filename=\"{fallback}\"; filename*=UTF-8''{}",
        utf8_percent_encode(filename, CONTENT_DISPOSITION_ENCODE_SET)
    )
}
#[cfg(test)]
mod tests {
    use super::{attachment_content_disposition, build_storage_key};

    #[test]
    fn storage_key_uses_file_extension() {
        assert_eq!(
            build_storage_key("attachments", "clip.OGG", "abc"),
            "attachments/abc.OGG"
        );
    }

    #[test]
    fn storage_key_falls_back_to_bin_without_extension() {
        assert_eq!(
            build_storage_key("stickers", "noextension", "abc"),
            "stickers/abc.bin"
        );
    }

    #[test]
    fn attachment_disposition_uses_safe_fallback_and_utf8_filename() {
        assert_eq!(
            attachment_content_disposition("résumé \"draft\".pdf"),
            "attachment; filename=\"r_sum_ _draft_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22draft%22.pdf"
        );
    }
}
