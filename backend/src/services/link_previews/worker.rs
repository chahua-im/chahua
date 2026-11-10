use std::{future::Future, sync::Arc};

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use tokio::{
    sync::mpsc,
    task::JoinSet,
    time::{timeout_at, Instant},
};
use url::Url;

use super::{
    fetch::{FetchedLinkPreview, PreviewFetchError, SecurePreviewFetcher},
    finalize::finalize_metadata,
    image, LinkPreviewWork,
};
use crate::{
    dto::{
        link_previews::{LinkPreviewStatus, StoredLinkPreview, StoredLinkPreviewImage},
        ws::ServerWsMessage,
    },
    models::Message,
    schema::group_membership,
    services::{
        avatars::AvatarService, media::MediaStore, messages::attach_metadata,
        ws_registry::ConnectionRegistry,
    },
    state::DbPool,
};

const CAPACITY: usize = 64;
const CONCURRENCY: usize = 4;

#[derive(Debug)]
pub struct LinkPreviewJob {
    pub message_id: i64,
    pub chat_id: i64,
    pub expected_updated_at: Option<DateTime<Utc>>,
    pub expires_at: DateTime<Utc>,
    pub work: Vec<LinkPreviewWork>,
}

impl LinkPreviewJob {
    pub fn new(message: &Message, expires_at: DateTime<Utc>, work: Vec<LinkPreviewWork>) -> Self {
        Self {
            message_id: message.id,
            chat_id: message.chat_id,
            expected_updated_at: message.updated_at,
            expires_at,
            work,
        }
    }
}

pub struct LinkPreviewService {
    sender: mpsc::Sender<LinkPreviewJob>,
}

impl LinkPreviewService {
    pub fn start(
        db: DbPool,
        media: MediaStore,
        avatars: Arc<AvatarService>,
        registry: Arc<ConnectionRegistry>,
    ) -> Arc<Self> {
        let (sender, receiver) = mpsc::channel(CAPACITY);
        let context = Arc::new(Context {
            db,
            media: media.clone(),
            avatars,
            registry,
            backend: ProductionBackend {
                media,
                fetcher: SecurePreviewFetcher::new(),
            },
        });
        tokio::spawn(dispatch(receiver, move |job| {
            let context = context.clone();
            async move { run_job(&context, job).await }
        }));
        Arc::new(Self { sender })
    }

    pub fn enqueue(&self, job: LinkPreviewJob) {
        let message_id = job.message_id;
        if self.sender.try_send(job).is_err() {
            tracing::warn!(message_id, "link preview queue unavailable; dropping job");
        }
    }
}

async fn dispatch<F, Fut>(mut receiver: mpsc::Receiver<LinkPreviewJob>, run: F)
where
    F: Fn(LinkPreviewJob) -> Fut,
    Fut: Future<Output = ()> + Send + 'static,
{
    let mut running = JoinSet::new();
    let mut closed = false;
    loop {
        if closed && running.is_empty() {
            break;
        }
        tokio::select! {
            job = receiver.recv(), if !closed && running.len() < CONCURRENCY => {
                match job {
                    Some(job) if job.expires_at > Utc::now() => { running.spawn(run(job)); }
                    Some(_) => {},
                    None => closed = true,
                }
            }
            result = running.join_next(), if !running.is_empty() => {
                if let Some(Err(_)) = result { tracing::error!("link preview job panicked"); }
            }
        }
    }
}

// These boundaries let deterministic tests exercise the real worker and commit
// without connecting to third-party pages or writing test objects to S3.
trait PreviewBackend: Send + Sync {
    fn page(
        &self,
        url: &Url,
    ) -> impl Future<Output = Result<FetchedLinkPreview, PreviewFetchError>> + Send;
    fn image(&self, url: &Url) -> impl Future<Output = Result<Vec<u8>, PreviewFetchError>> + Send;
    fn put(&self, key: &str, bytes: Vec<u8>) -> impl Future<Output = bool> + Send;
    fn delete(&self, key: &str) -> impl Future<Output = ()> + Send;
}

struct ProductionBackend {
    media: MediaStore,
    fetcher: SecurePreviewFetcher,
}
impl PreviewBackend for ProductionBackend {
    async fn page(&self, url: &Url) -> Result<FetchedLinkPreview, PreviewFetchError> {
        self.fetcher.fetch_page(url).await
    }
    async fn image(&self, url: &Url) -> Result<Vec<u8>, PreviewFetchError> {
        self.fetcher.fetch_thumbnail(url).await
    }
    async fn put(&self, key: &str, bytes: Vec<u8>) -> bool {
        self.media
            .put_preview_object(key, "image/webp", bytes.into())
            .await
            .is_ok()
    }
    async fn delete(&self, key: &str) {
        self.media.delete_preview_object(key).await
    }
}

struct Context<B> {
    db: DbPool,
    media: MediaStore,
    backend: B,
    avatars: Arc<AvatarService>,
    registry: Arc<ConnectionRegistry>,
}

async fn thumbnail<B: PreviewBackend>(
    backend: &B,
    source: &Url,
    deadline: Instant,
    keys: &mut Vec<String>,
) -> Option<StoredLinkPreviewImage> {
    let bytes = timeout_at(deadline, backend.image(source))
        .await
        .ok()?
        .ok()?;
    let decoded = timeout_at(
        deadline,
        tokio::task::spawn_blocking(move || image::thumbnail(&bytes)),
    )
    .await
    .ok()?
    .ok()?
    .ok()?;
    if Instant::now() >= deadline {
        return None;
    }
    let key = format!("link-previews/{}.webp", uuid::Uuid::new_v4());
    // Record ownership before starting an upload. On deadline, wait for the
    // existing bounded SDK operation to settle rather than losing its key.
    keys.push(key.clone());
    let upload = backend.put(&key, decoded.bytes);
    tokio::pin!(upload);
    let uploaded = tokio::select! {
        result = &mut upload => result,
        _ = tokio::time::sleep_until(deadline) => { let _ = upload.await; false }
    };
    uploaded.then_some(StoredLinkPreviewImage {
        storage_key: key.clone(),
        width: decoded.width,
        height: decoded.height,
    })
}

async fn external_work<B: PreviewBackend>(
    backend: &B,
    job: &LinkPreviewJob,
    deadline: Instant,
    keys: &mut Vec<String>,
) -> Option<Vec<StoredLinkPreview>> {
    let mut completed = Vec::with_capacity(job.work.len());
    for work in &job.work {
        if Instant::now() >= deadline {
            return None;
        }
        let (url, result) = match work {
            LinkPreviewWork::FetchPage { url } => {
                let parsed = Url::parse(url).expect("prepared preview URL");
                let fetched = timeout_at(deadline, backend.page(&parsed)).await;
                let result = match fetched {
                    Ok(Ok(page)) => {
                        let image = if let Some(source) = page.image_url {
                            thumbnail(backend, &source, deadline, keys).await
                        } else {
                            None
                        };
                        StoredLinkPreview {
                            url: url.clone(),
                            status: LinkPreviewStatus::Ready,
                            expires_at: None,
                            title: Some(page.title),
                            image,
                        }
                    }
                    Ok(Err(reason)) => {
                        tracing::debug!(
                            message_id = job.message_id,
                            ?reason,
                            "link preview page unavailable"
                        );
                        StoredLinkPreview {
                            url: url.clone(),
                            status: LinkPreviewStatus::Unavailable,
                            expires_at: None,
                            title: None,
                            image: None,
                        }
                    }
                    Err(_) => return None,
                };
                (url, result)
            }
            LinkPreviewWork::CacheImage { url, image_url } => {
                let source = Url::parse(image_url).expect("prepared thumbnail URL");
                let image = thumbnail(backend, &source, deadline, keys).await;
                (
                    url,
                    StoredLinkPreview {
                        url: url.clone(),
                        status: LinkPreviewStatus::Ready,
                        expires_at: None,
                        title: None,
                        image,
                    },
                )
            }
        };
        debug_assert_eq!(url, &result.url);
        completed.push(result);
    }
    (Instant::now() < deadline).then_some(completed)
}

async fn run_job<B: PreviewBackend>(context: &Context<B>, job: LinkPreviewJob) {
    let Ok(remaining) = (job.expires_at - Utc::now()).to_std() else {
        return;
    };
    let deadline = Instant::now() + remaining;
    let mut keys = Vec::new();
    let completed = external_work(&context.backend, &job, deadline, &mut keys).await;
    if let Some(completed) = completed.filter(|_| Utc::now() < job.expires_at) {
        let retained_keys: Vec<_> = completed
            .iter()
            .filter_map(|preview| {
                preview
                    .image
                    .as_ref()
                    .map(|image| image.storage_key.clone())
            })
            .collect();
        let db = context.db.clone();
        let media = context.media.clone();
        let media_avatars = context.avatars.clone();
        let registry = context.registry.clone();
        let runtime = tokio::runtime::Handle::current();
        // Diesel work and async hydration stay on the blocking pool. No DB
        // connection is acquired until all external work has completed.
        let committed = tokio::task::spawn_blocking(move || {
            let Ok(mut conn) = db.get() else {
                tracing::warn!(
                    message_id = job.message_id,
                    "link preview database unavailable"
                );
                return false;
            };
            let result = finalize_metadata(
                &mut conn,
                job.message_id,
                job.chat_id,
                job.expected_updated_at,
                job.expires_at,
                &completed,
            );
            let message = match result {
                Ok(Some(message)) => message,
                Ok(None) => return false,
                Err(_) => {
                    tracing::warn!(message_id = job.message_id, "link preview commit failed");
                    return false;
                }
            };
            if message.is_published {
                // The committed row, not the pre-fetch snapshot, is authoritative.
                let uid = message.sender_uid;
                let response = runtime.block_on(attach_metadata(
                    &mut conn,
                    vec![message],
                    &media,
                    &media_avatars,
                    uid,
                ));
                let recipients = group_membership::table
                    .filter(group_membership::chat_id.eq(job.chat_id))
                    .select(group_membership::uid)
                    .load::<i32>(&mut conn);
                if let (Some(response), Ok(recipients)) = (response.into_iter().next(), recipients)
                {
                    registry.broadcast_to_uids(
                        &recipients,
                        Arc::new(ServerWsMessage::MessageUpdated(response)),
                    );
                }
            }
            true
        })
        .await
        .unwrap_or(false);
        if committed {
            keys.retain(|key| !retained_keys.contains(key));
        }
    }
    // Never delete keys already committed by this or another job/snapshot.
    for key in keys {
        context.backend.delete(&key).await;
    }
}

#[cfg(test)]
#[path = "worker_tests.rs"]
mod tests;
