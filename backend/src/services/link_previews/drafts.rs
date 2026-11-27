use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
#[cfg(test)]
use chrono::Utc;
use tokio::sync::{OnceCell, Semaphore};

use super::{
    fetch::SecurePreviewFetcher,
    image::{self, Thumbnail},
    validate_url, LinkPreviewWork, PreparedLinkPreviews,
};
use crate::{
    dto::link_previews::{
        LinkPreviewImageResponse, LinkPreviewResponse, LinkPreviewStatus, StoredMessageMetadata,
    },
    errors::AppError,
};

const TTL: Duration = Duration::from_secs(600);
const CAPACITY: usize = 128;
const CONCURRENCY: usize = 8;
type Cache = HashMap<(i32, String), (Instant, Arc<OnceCell<DraftPreview>>)>;

pub struct DraftPreviews {
    entries: Mutex<Cache>,
    slots: Semaphore,
    fetcher: SecurePreviewFetcher,
}

struct DraftPreview {
    preview: LinkPreviewResponse,
    thumbnail: Option<Thumbnail>,
}

#[cfg(test)]
impl Default for DraftPreviews {
    fn default() -> Self {
        Self::new(Arc::new(crate::config::LinkPreviewConfig::default()))
    }
}

impl DraftPreviews {
    pub(super) fn new(config: Arc<crate::config::LinkPreviewConfig>) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            slots: Semaphore::new(CONCURRENCY),
            fetcher: SecurePreviewFetcher::new(config),
        }
    }
}

impl DraftPreviews {
    pub async fn fetch(
        &self,
        uid: i32,
        urls: Vec<String>,
    ) -> Result<Vec<LinkPreviewResponse>, AppError> {
        if urls.is_empty() || urls.len() > super::MAX_PREVIEWS {
            return Err(AppError::BadRequest("Invalid link preview"));
        }
        let urls = urls
            .into_iter()
            .map(|url| {
                validate_url(&url)
                    .map(|url| url.to_string())
                    .ok_or(AppError::BadRequest("Invalid link preview"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let result = futures::future::join_all(urls.into_iter().map(|url| async move {
            let cell = {
                let mut cache = self.entries.lock().expect("draft preview cache");
                cache.retain(|_, (at, _)| at.elapsed() < TTL);
                let key = (uid, url.clone());
                if !cache.contains_key(&key) && cache.len() >= CAPACITY {
                    if let Some(oldest) = cache
                        .iter()
                        .min_by_key(|(_, (at, _))| *at)
                        .map(|(key, _)| key.clone())
                    {
                        cache.remove(&oldest);
                    }
                }
                cache
                    .entry(key)
                    .or_insert_with(|| (Instant::now(), Arc::new(OnceCell::new())))
                    .1
                    .clone()
            };
            let entry = cell
                .get_or_init(|| async {
                    let fetched = tokio::time::timeout(Duration::from_secs(20), async {
                        let _slot = self.slots.acquire().await.ok()?;
                        let page = self
                            .fetcher
                            .fetch_page(&url::Url::parse(&url).ok()?)
                            .await
                            .ok()?;
                        let thumbnail = if let Some(image_url) = page.image_url {
                            match self.fetcher.fetch_thumbnail(&image_url).await {
                                Ok(bytes) => {
                                    tokio::task::spawn_blocking(move || image::thumbnail(&bytes))
                                        .await
                                        .ok()
                                        .and_then(Result::ok)
                                }
                                Err(_) => None,
                            }
                        } else {
                            None
                        };
                        Some((page.title, page.description, thumbnail))
                    })
                    .await
                    .ok()
                    .flatten();
                    let (status, title, description, thumbnail) = match fetched {
                        Some((title, description, thumbnail)) => (
                            LinkPreviewStatus::Ready,
                            Some(title),
                            description,
                            thumbnail,
                        ),
                        None => (LinkPreviewStatus::Unavailable, None, None, None),
                    };
                    let image = thumbnail.as_ref().map(|image| LinkPreviewImageResponse {
                        url: format!("data:image/webp;base64,{}", STANDARD.encode(&image.bytes)),
                        width: image.width,
                        height: image.height,
                    });
                    DraftPreview {
                        preview: LinkPreviewResponse {
                            url: url.clone(),
                            status,
                            title,
                            description,
                            image,
                            expires_at: None,
                        },
                        thumbnail,
                    }
                })
                .await;
            entry.preview.clone()
        }))
        .await;
        Ok(result)
    }

    /// Reuse server-owned data only; thumbnail bytes enter permanent storage only after sending.
    pub fn apply(&self, uid: i32, prepared: &mut PreparedLinkPreviews) {
        let Some(metadata) = prepared.metadata.as_mut() else {
            return;
        };
        let mut stored: StoredMessageMetadata =
            serde_json::from_value(metadata.clone()).expect("prepared preview metadata");
        let cache = self.entries.lock().expect("draft preview cache");
        for preview in &mut stored.link_previews {
            if preview.status != LinkPreviewStatus::Pending {
                continue;
            }
            let Some((at, cell)) = cache.get(&(uid, preview.url.clone())) else {
                continue;
            };
            let Some(entry) = cell.get().filter(|_| at.elapsed() < TTL) else {
                continue;
            };
            preview.status = if entry.thumbnail.is_some() {
                LinkPreviewStatus::Pending
            } else {
                entry.preview.status
            };
            preview.title = entry.preview.title.clone();
            preview.description = entry.preview.description.clone();
            preview.expires_at = entry.thumbnail.as_ref().map(|_| prepared.expires_at);
            prepared.work.retain(
                |work| !matches!(work, LinkPreviewWork::FetchPage { url } if url == &preview.url),
            );
            if let Some(thumbnail) = &entry.thumbnail {
                prepared.work.push(LinkPreviewWork::CacheThumbnail {
                    url: preview.url.clone(),
                    thumbnail: thumbnail.clone(),
                });
            }
        }
        metadata["linkPreviews"] =
            serde_json::to_value(stored.link_previews).expect("prepared preview metadata");
    }
}

#[cfg(test)]
mod tests;
