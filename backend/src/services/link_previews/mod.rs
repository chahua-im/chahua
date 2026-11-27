pub mod drafts;
pub mod fetch;
pub mod finalize;
pub mod image;
mod metadata;
mod sites;
mod worker;
pub use worker::{LinkPreviewJob, LinkPreviewService};

use std::{cell::Cell, collections::HashMap};

use chrono::{DateTime, Duration, Utc};
use linkify::{LinkFinder, LinkKind};
use serde::Deserialize;
use serde_json::Value;
use url::{Host, Url};

use crate::{
    dto::link_previews::{
        LinkPreviewImageResponse, LinkPreviewInputStatus, LinkPreviewResponse, LinkPreviewStatus,
        MessageMetadataInput, MessageMetadataResponse, StoredLinkPreview, StoredMessageMetadata,
    },
    errors::AppError,
    services::media::MediaStore,
};

const MAX_PREVIEWS: usize = 3;
const MAX_URL_BYTES: usize = 4096;
const MAX_TITLE_CHARS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkPreviewWork {
    FetchPage {
        url: String,
    },
    CacheImage {
        url: String,
        image_url: String,
    },
    CacheThumbnail {
        url: String,
        thumbnail: image::Thumbnail,
    },
}

#[derive(Debug)]
pub struct PreparedLinkPreviews {
    pub metadata: Option<Value>,
    pub work: Vec<LinkPreviewWork>,
    pub expires_at: DateTime<Utc>,
}

/// Validate the same URL syntax for page destinations and supplied image sources.
/// DNS resolution is deliberately deferred to the fetcher.
pub fn validate_url(raw: &str) -> Option<Url> {
    if raw.len() > MAX_URL_BYTES {
        return None;
    }
    // Observe parser violations before normalization can erase empty userinfo
    // or repair an invalid authority spelling.
    let invalid_syntax = Cell::new(false);
    let violation = |_| invalid_syntax.set(true);
    let url = Url::options()
        .syntax_violation_callback(Some(&violation))
        .parse(raw)
        .ok()?;
    if url.scheme() != "https"
        || !matches!(url.host(), Some(Host::Domain(_)))
        || invalid_syntax.get()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    Some(url)
}

pub fn select_urls(text: &str) -> Vec<String> {
    let mut finder = LinkFinder::new();
    finder.kinds(&[LinkKind::Url]);
    let mut selected = Vec::new();
    for token in finder.links(text) {
        if let Some(url) = validate_url(token.as_str()) {
            let url = url.to_string();
            if !selected.contains(&url) {
                selected.push(url);
            }
        }
    }
    selected
}

pub fn prepare(
    text: Option<&str>,
    input: Option<&MessageMetadataInput>,
    prepared_at: DateTime<Utc>,
) -> Result<PreparedLinkPreviews, AppError> {
    prepare_with_current(text.unwrap_or_default(), input, None, prepared_at)
}

fn prepare_with_current(
    text: &str,
    input: Option<&MessageMetadataInput>,
    current: Option<&StoredMessageMetadata>,
    prepared_at: DateTime<Utc>,
) -> Result<PreparedLinkPreviews, AppError> {
    let selected = select_urls(text);
    let mut supplied = HashMap::new();
    if let Some(input) = input {
        if input.link_previews.len() > selected.len() {
            return Err(AppError::BadRequest("Invalid link preview"));
        }
        for item in &input.link_previews {
            let invalid = || AppError::BadRequest("Invalid link preview");
            if item.url.len() > MAX_URL_BYTES
                || item
                    .title
                    .as_ref()
                    .is_some_and(|title| title.chars().count() > MAX_TITLE_CHARS)
            {
                return Err(invalid());
            }
            let url = validate_url(&item.url).ok_or_else(invalid)?.to_string();
            if !selected.contains(&url) || supplied.contains_key(&url) {
                return Err(invalid());
            }
            let image_url = item
                .image_url
                .as_ref()
                .map(|image| {
                    if image.len() > MAX_URL_BYTES {
                        return Err(invalid());
                    }
                    Ok(validate_url(image).ok_or_else(invalid)?.to_string())
                })
                .transpose()?;
            if item.status == Some(LinkPreviewInputStatus::Disabled)
                && (item.title.is_some() || image_url.is_some())
            {
                return Err(invalid());
            }
            supplied.insert(url, (item, image_url));
        }
    }

    let mut work = Vec::new();
    let mut previews = Vec::with_capacity(selected.len());
    let mut active_count = 0;
    for url in selected {
        let supplied = supplied.remove(&url);
        let previous = current.and_then(|current| {
            current
                .link_previews
                .iter()
                .find(|preview| preview.url == url)
        });
        let requested = supplied.as_ref().and_then(|(item, _)| item.status);
        let disabled = requested.map_or_else(
            || previous.is_some_and(|preview| preview.status == LinkPreviewStatus::Disabled),
            |status| status == LinkPreviewInputStatus::Disabled,
        );
        if disabled {
            previews.push(StoredLinkPreview {
                url,
                status: LinkPreviewStatus::Disabled,
                expires_at: None,
                title: None,
                description: None,
                image: None,
            });
            continue;
        }
        let automatic = supplied.as_ref().is_some_and(|(item, _)| {
            item.status == Some(LinkPreviewInputStatus::Enabled)
                && item.title.is_none()
                && item.image_url.is_none()
        });
        if active_count == MAX_PREVIEWS {
            if supplied.is_some() && !automatic {
                return Err(AppError::BadRequest("Invalid link preview"));
            }
            continue;
        }
        active_count += 1;
        if supplied.is_none()
            || (automatic
                && previous.is_some_and(|preview| preview.status == LinkPreviewStatus::Ready))
        {
            if let Some(previous) =
                previous.filter(|preview| preview.status != LinkPreviewStatus::Pending)
            {
                previews.push(previous.clone());
                continue;
            }
        }
        // An explicit enable without content asks the server to fetch, rather than creating a host-only card.
        let supplied = supplied.filter(|_| !automatic);
        if let Some((item, image_url)) = supplied {
            let title = item
                .title
                .as_deref()
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    Url::parse(&url)
                        .expect("selected URL is valid")
                        .host_str()
                        .expect("selected URL has a host")
                        .to_owned()
                });
            if let Some(image_url) = image_url {
                work.push(LinkPreviewWork::CacheImage {
                    url: url.clone(),
                    image_url,
                });
            }
            previews.push(StoredLinkPreview {
                url,
                status: LinkPreviewStatus::Ready,
                expires_at: None,
                title: Some(title),
                description: None,
                image: None,
            });
        } else {
            work.push(LinkPreviewWork::FetchPage { url: url.clone() });
            previews.push(StoredLinkPreview {
                url,
                status: LinkPreviewStatus::Pending,
                expires_at: Some(prepared_at + Duration::seconds(30)),
                title: None,
                description: None,
                image: None,
            });
        }
    }
    let metadata = if previews.is_empty() {
        None
    } else {
        Some(
            serde_json::to_value(StoredMessageMetadata {
                link_previews: previews,
            })
            .expect("link preview metadata is serializable"),
        )
    };
    Ok(PreparedLinkPreviews {
        metadata,
        work,
        expires_at: prepared_at + Duration::seconds(30),
    })
}

pub fn prepare_edit(
    text: &str,
    input: Option<&MessageMetadataInput>,
    current: Option<&Value>,
    prepared_at: DateTime<Utc>,
) -> Result<PreparedLinkPreviews, AppError> {
    let old = current
        .and_then(|value| serde_json::from_value::<StoredMessageMetadata>(value.clone()).ok());
    let mut prepared = prepare_with_current(text, input, old.as_ref(), prepared_at)?;
    let mut merged = current
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    merged.remove("linkPreviews");
    if let Some(metadata) = prepared.metadata {
        merged.insert("linkPreviews".into(), metadata["linkPreviews"].clone());
    }
    prepared.metadata = (!merged.is_empty()).then_some(Value::Object(merged));
    Ok(prepared)
}

/// Summary payloads retain URL matching and titles without thumbnails or descriptions.
pub fn summary_metadata(stored: StoredMessageMetadata) -> MessageMetadataResponse {
    MessageMetadataResponse {
        link_previews: stored
            .link_previews
            .into_iter()
            .map(|preview| LinkPreviewResponse {
                url: preview.url,
                status: preview.status,
                title: preview.title,
                expires_at: None,
                description: None,
                image: None,
            })
            .collect(),
    }
}

pub fn preview_metadata(metadata: &Value) -> Option<MessageMetadataResponse> {
    StoredMessageMetadata::deserialize(metadata)
        .ok()
        .map(summary_metadata)
}

pub fn project_metadata(
    metadata: &Value,
    media_store: &MediaStore,
    now: DateTime<Utc>,
) -> Result<MessageMetadataResponse, serde_json::Error> {
    Ok(project_stored_metadata(
        StoredMessageMetadata::deserialize(metadata)?,
        media_store,
        now,
    ))
}

pub fn project_stored_metadata(
    stored: StoredMessageMetadata,
    media_store: &MediaStore,
    now: DateTime<Utc>,
) -> MessageMetadataResponse {
    MessageMetadataResponse {
        link_previews: stored
            .link_previews
            .into_iter()
            .map(|preview| {
                let status = if preview.status == LinkPreviewStatus::Pending
                    && preview
                        .expires_at
                        .is_some_and(|expires_at| expires_at <= now)
                {
                    LinkPreviewStatus::Unavailable
                } else {
                    preview.status
                };
                LinkPreviewResponse {
                    url: preview.url,
                    status,
                    expires_at: preview.expires_at,
                    title: preview.title,
                    description: preview.description,
                    image: preview.image.map(|image| LinkPreviewImageResponse {
                        url: media_store.public_url(&image.storage_key),
                        width: image.width,
                        height: image.height,
                    }),
                }
            })
            .collect(),
    }
}

/// Snapshots retain ready content and explicit disabled choices, never pending work.
pub fn snapshot_metadata(metadata: &Value) -> Result<Option<Value>, serde_json::Error> {
    let mut stored = StoredMessageMetadata::deserialize(metadata)?;
    stored.link_previews.retain(|preview| {
        matches!(
            preview.status,
            LinkPreviewStatus::Ready | LinkPreviewStatus::Disabled
        )
    });
    for preview in &mut stored.link_previews {
        preview.expires_at = None;
    }
    if stored.link_previews.is_empty() {
        Ok(None)
    } else {
        serde_json::to_value(stored).map(Some)
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod summary_tests {
    use super::*;

    #[test]
    fn summary_retains_matching_data_without_image_or_description() {
        let metadata = serde_json::json!({"linkPreviews": [{
            "url": "https://example.com/", "status": "ready", "title": "Example",
            "description": "Long description",
            "image": {"storageKey": "private/key", "width": 100, "height": 100}
        }]});
        let summary = serde_json::to_value(preview_metadata(&metadata).unwrap()).unwrap();
        assert_eq!(
            summary,
            serde_json::json!({"linkPreviews": [{
                "url": "https://example.com/", "status": "ready", "title": "Example"
            }]})
        );
        assert!(preview_metadata(&Value::Null).is_none());
    }
}
