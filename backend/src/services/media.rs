use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::primitives::ByteStream;
use axum::http::StatusCode;
use chrono::Duration;
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::config::MediaConfig;

pub(crate) const PUBLIC_MEDIA_CACHE_CONTROL: &str = "public,max-age=31536000,immutable";

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

        let presigned_request = self
            .client
            .put_object()
            .bucket(&self.config.bucket)
            .key(storage_key)
            .content_type(content_type)
            .cache_control(PUBLIC_MEDIA_CACHE_CONTROL)
            .acl(aws_sdk_s3::types::ObjectCannedAcl::PublicRead)
            .presigned(presigning_config)
            .await
            .map_err(|e| {
                tracing::error!("Failed to generate presigned URL: {:?}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to generate upload URL",
                )
            })?;

        Ok(PresignedUpload {
            upload_url: presigned_request.uri().to_string(),
            upload_headers: presigned_request
                .headers()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect(),
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

#[cfg(test)]
mod tests {
    use super::build_storage_key;

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
}
