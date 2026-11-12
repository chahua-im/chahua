pub mod fetch;
pub mod finalize;
pub mod image;
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
        LinkPreviewImageResponse, LinkPreviewResponse, LinkPreviewStatus, MessageMetadataInput,
        MessageMetadataResponse, StoredLinkPreview, StoredMessageMetadata,
    },
    errors::AppError,
    services::media::MediaStore,
};

const MAX_PREVIEWS: usize = 3;
const MAX_URL_BYTES: usize = 4096;
const MAX_TITLE_CHARS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkPreviewWork {
    FetchPage { url: String },
    CacheImage { url: String, image_url: String },
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
                if selected.len() == MAX_PREVIEWS {
                    break;
                }
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
    let selected = select_urls(text.unwrap_or_default());
    let mut supplied = HashMap::new();
    if let Some(input) = input {
        if input.link_previews.len() > MAX_PREVIEWS {
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
            supplied.insert(url, (item.title.as_deref(), image_url));
        }
    }

    let mut work = Vec::new();
    let mut previews = Vec::with_capacity(selected.len());
    for url in selected {
        if let Some((title, image_url)) = supplied.remove(&url) {
            let title = title
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
    let mut prepared = prepare(Some(text), input, prepared_at)?;
    let old = current
        .and_then(|value| serde_json::from_value::<StoredMessageMetadata>(value.clone()).ok());
    if let (Some(metadata), Some(old)) = (prepared.metadata.as_mut(), old) {
        let mut selected: StoredMessageMetadata =
            serde_json::from_value(metadata.take()).expect("prepared metadata is typed");
        for preview in &mut selected.link_previews {
            let supplied = input.is_some_and(|input| {
                input.link_previews.iter().any(|entry| {
                    validate_url(&entry.url).is_some_and(|url| url.as_str() == preview.url)
                })
            });
            if !supplied {
                if let Some(previous) = old.link_previews.iter().find(|previous| {
                    previous.url == preview.url && previous.status != LinkPreviewStatus::Pending
                }) {
                    *preview = previous.clone();
                    prepared.work.retain(|work| !matches!(work, LinkPreviewWork::FetchPage { url } if url == &preview.url));
                }
            }
        }
        *metadata = serde_json::to_value(selected).expect("preview metadata is serializable");
    }
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

/// Snapshots share only already-cached, terminal ready previews.
pub fn ready_snapshot(metadata: &Value) -> Result<Option<Value>, serde_json::Error> {
    let mut stored = StoredMessageMetadata::deserialize(metadata)?;
    stored
        .link_previews
        .retain(|preview| preview.status == LinkPreviewStatus::Ready);
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
mod tests {
    use super::*;
    use crate::dto::link_previews::LinkPreviewInput;

    fn input(url: &str, title: Option<&str>, image_url: Option<&str>) -> LinkPreviewInput {
        LinkPreviewInput {
            url: url.to_owned(),
            title: title.map(str::to_owned),
            image_url: image_url.map(str::to_owned),
        }
    }

    #[test]
    fn link_preview_selection_is_ordered_distinct_and_bounded() {
        let selected = select_urls(
            "https://EXAMPLE.com/a#part https://example.com/a#part https://two.example/ \
             https://three.example/?a=1 https://four.example/",
        );
        assert_eq!(
            selected,
            [
                "https://example.com/a#part",
                "https://two.example/",
                "https://three.example/?a=1",
            ]
        );
    }

    #[test]
    fn link_preview_url_policy_rejects_unsafe_syntax() {
        for value in [
            "http://example.com/",
            "https://127.0.0.1/",
            "https://[::1]/",
            "https://example.com:444/",
            "https://user@example.com/",
            "https://@example.com/",
            "https:///@example.com/",
            "https:////@example.com/",
            "https:example.com/",
            "example.com",
        ] {
            assert!(validate_url(value).is_none(), "{value}");
        }
        assert!(validate_url("https://example.com:443/path#fragment").is_some());
    }

    #[test]
    fn link_preview_supplied_cards_keep_selected_order_and_only_cache_images() {
        let metadata = MessageMetadataInput {
            link_previews: vec![
                input(
                    "https://two.example",
                    Some("  Second  "),
                    Some("https://img.example/a"),
                ),
                input("https://one.example/", Some("  "), None),
            ],
        };
        let prepared = prepare(
            Some("https://one.example https://two.example https://three.example"),
            Some(&metadata),
            Utc::now(),
        )
        .unwrap();
        let stored: StoredMessageMetadata =
            serde_json::from_value(prepared.metadata.unwrap()).unwrap();
        assert_eq!(
            stored.link_previews[0].title.as_deref(),
            Some("one.example")
        );
        assert_eq!(stored.link_previews[1].title.as_deref(), Some("Second"));
        assert!(stored.link_previews[0].description.is_none());
        assert!(stored.link_previews[1].description.is_none());
        assert_eq!(stored.link_previews[2].status, LinkPreviewStatus::Pending);
        assert!(
            matches!(&prepared.work[0], LinkPreviewWork::CacheImage { url, .. } if url == "https://two.example/")
        );
        assert!(
            matches!(&prepared.work[1], LinkPreviewWork::FetchPage { url } if url == "https://three.example/")
        );
    }

    #[test]
    fn link_preview_invalid_supplied_entries_are_rejected() {
        let now = Utc::now();
        for entries in [
            vec![input("https://other.example/", None, None)],
            vec![
                input("https://one.example/", None, None),
                input("https://ONE.example", None, None),
            ],
            vec![input(
                "https://one.example/",
                None,
                Some("http://image.example/"),
            )],
            vec![input("https://one.example/", Some(&"a".repeat(513)), None)],
            vec![input("https://one.example/", None, None); 4],
        ] {
            let body = MessageMetadataInput {
                link_previews: entries,
            };
            assert!(matches!(
                prepare(Some("https://one.example/"), Some(&body), now),
                Err(AppError::BadRequest("Invalid link preview"))
            ));
        }
    }

    #[test]
    fn link_preview_request_rejects_server_owned_fields() {
        assert!(serde_json::from_str::<MessageMetadataInput>(
            r#"{"linkPreviews":[{"url":"https://one.example/","status":"ready"}]}"#
        )
        .is_err());
        assert!(serde_json::from_str::<MessageMetadataInput>(
            r#"{"linkPreviews":[{"url":"https://one.example/","description":"not accepted"}]}"#
        )
        .is_err());
        assert!(
            serde_json::from_str::<MessageMetadataInput>(r#"{"linkPreviews":[],"other":1}"#)
                .is_err()
        );
        assert!(serde_json::from_str::<MessageMetadataInput>(r#"{}"#)
            .unwrap()
            .link_previews
            .is_empty());
    }

    #[test]
    fn link_preview_snapshot_copies_only_ready_entries() {
        let prepared = prepare(
            Some("https://one.example/ https://two.example/"),
            Some(&MessageMetadataInput {
                link_previews: vec![input("https://one.example/", Some("Title"), None)],
            }),
            Utc::now(),
        )
        .unwrap();
        let mut metadata = prepared.metadata.unwrap();
        metadata["linkPreviews"][0]["description"] = serde_json::json!("A description");
        let snapshot = ready_snapshot(&metadata).unwrap().unwrap();
        let stored: StoredMessageMetadata = serde_json::from_value(snapshot).unwrap();
        assert_eq!(stored.link_previews.len(), 1);
        assert_eq!(stored.link_previews[0].title.as_deref(), Some("Title"));
        assert_eq!(
            stored.link_previews[0].description.as_deref(),
            Some("A description")
        );
    }

    #[test]
    fn link_preview_description_projects_and_old_metadata_remains_readable() {
        let media = MediaStore::new(
            aws_sdk_s3::Client::from_conf(
                aws_sdk_s3::Config::builder()
                    .behavior_version_latest()
                    .build(),
            ),
            std::sync::Arc::new(crate::config::MediaConfig {
                bucket: "media-bucket".into(),
                attachment_prefix: "attachments".into(),
                base_url: Some("https://media.example".into()),
                endpoint_url: None,
                upload_proxy_path: None,
                max_attachment_file_size_bytes: 1,
            }),
        );
        let metadata = serde_json::json!({
            "linkPreviews": [
                {"url":"https://one.example/","status":"ready","title":"Title","description":"Text"},
                {"url":"https://old.example/","status":"ready","title":"Old"}
            ]
        });
        let projected = project_metadata(&metadata, &media, Utc::now()).unwrap();
        assert_eq!(
            projected.link_previews[0].description.as_deref(),
            Some("Text")
        );
        assert!(projected.link_previews[1].description.is_none());
        let json = serde_json::to_value(projected).unwrap();
        assert_eq!(json["linkPreviews"][0]["description"], "Text");
        assert!(json["linkPreviews"][1].get("description").is_none());
    }

    #[test]
    fn link_preview_edits_preserve_terminal_entries_and_replace_pending_attempts() {
        let at = Utc::now();
        let current = serde_json::json!({
            "other": 42,
            "linkPreviews": [
                {"url":"https://ready.example/","status":"ready","title":"Original","description":"Original description"},
                {"url":"https://failed.example/","status":"unavailable"},
                {"url":"https://pending.example/","status":"pending","expiresAt": at}
            ]
        });
        let edited = prepare_edit(
            "https://failed.example/ https://ready.example/ https://pending.example/",
            None,
            Some(&current),
            at,
        )
        .unwrap();
        assert_eq!(
            edited.work,
            [LinkPreviewWork::FetchPage {
                url: "https://pending.example/".into()
            }]
        );
        let metadata = edited.metadata.unwrap();
        assert_eq!(metadata["other"], 42);
        let stored: StoredMessageMetadata = serde_json::from_value(metadata).unwrap();
        assert_eq!(
            stored.link_previews[0].status,
            LinkPreviewStatus::Unavailable
        );
        assert_eq!(stored.link_previews[1].title.as_deref(), Some("Original"));
        assert_eq!(
            stored.link_previews[1].description.as_deref(),
            Some("Original description")
        );
        assert_eq!(
            stored.link_previews[2].expires_at,
            Some(at + Duration::seconds(30))
        );
        let supplied = MessageMetadataInput {
            link_previews: vec![input("https://ready.example/", Some("Replacement"), None)],
        };
        let edited = prepare_edit(
            "https://ready.example/",
            Some(&supplied),
            Some(&current),
            at,
        )
        .unwrap();
        assert!(edited.work.is_empty());
        assert_eq!(
            edited.metadata.unwrap()["linkPreviews"][0]["title"],
            "Replacement"
        );
        assert_eq!(
            prepare_edit("removed", None, Some(&current), at)
                .unwrap()
                .metadata,
            Some(serde_json::json!({"other":42}))
        );
        let only_previews = serde_json::json!({"linkPreviews":current["linkPreviews"]});
        assert!(prepare_edit("removed", None, Some(&only_previews), at)
            .unwrap()
            .metadata
            .is_none());
    }
}

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
