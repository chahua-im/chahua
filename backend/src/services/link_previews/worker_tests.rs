use super::*;
use crate::{
    dto::link_previews::{LinkPreviewInput, MessageMetadataInput, StoredMessageMetadata},
    schema::messages::dsl,
};
use std::{
    io::Cursor,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};
use tokio::sync::{Notify, Semaphore};

#[derive(Default)]
struct FakeBackend {
    pages: Mutex<Vec<String>>,
    images: Mutex<Vec<String>>,
    uploaded: Mutex<Vec<String>>,
    deleted: Mutex<Vec<String>>,
    hold_upload: bool,
    uploading: Notify,
    release: Notify,
}
impl PreviewBackend for FakeBackend {
    async fn page(&self, url: &Url) -> Result<FetchedLinkPreview, PreviewFetchError> {
        self.pages.lock().unwrap().push(url.to_string());
        if url.host_str() == Some("fail.example") {
            return Err(PreviewFetchError::MissingTitle);
        }
        Ok(FetchedLinkPreview {
            title: "Fetched title".into(),
            description: Some("Fetched description".into()),
            image_url: Some(Url::parse("https://image.example/a.png").unwrap()),
        })
    }
    async fn image(&self, url: &Url) -> Result<Vec<u8>, PreviewFetchError> {
        self.images.lock().unwrap().push(url.to_string());
        let mut bytes = Cursor::new(Vec::new());
        ::image::RgbaImage::new(200, 100)
            .write_to(&mut bytes, ::image::ImageFormat::Png)
            .unwrap();
        Ok(bytes.into_inner())
    }
    async fn put(&self, key: &str, bytes: Vec<u8>) -> bool {
        assert_eq!(
            ::image::guess_format(&bytes).unwrap(),
            ::image::ImageFormat::WebP
        );
        assert!(key.starts_with("link-previews/"));
        self.uploaded.lock().unwrap().push(key.into());
        self.uploading.notify_one();
        if self.hold_upload {
            self.release.notified().await;
        }
        true
    }
    async fn delete(&self, key: &str) {
        self.deleted.lock().unwrap().push(key.into());
    }
}

fn job(work: Vec<LinkPreviewWork>) -> LinkPreviewJob {
    LinkPreviewJob {
        message_id: -991,
        chat_id: -992,
        expected_updated_at: None,
        expires_at: Utc::now() + chrono::Duration::seconds(30),
        work,
    }
}

#[tokio::test]
async fn link_preview_queue_drops_overflow_and_bounds_active_jobs_without_retries() {
    let (sender, receiver) = mpsc::channel(CAPACITY);
    let service = LinkPreviewService {
        sender,
        drafts: Default::default(),
    };
    for n in 0..65 {
        let mut job = job(Vec::new());
        if n >= 4 {
            job.expires_at = Utc::now() - chrono::Duration::seconds(1);
        }
        service.enqueue(job);
    }
    assert_eq!(service.sender.capacity(), 0);
    let entered = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let runner = {
        let entered = entered.clone();
        let started = started.clone();
        let release = release.clone();
        tokio::spawn(dispatch(receiver, move |_| {
            let entered = entered.clone();
            let started = started.clone();
            let release = release.clone();
            async move {
                if entered.fetch_add(1, Ordering::SeqCst) + 1 == CONCURRENCY {
                    started.notify_one();
                }
                release.acquire().await.unwrap().forget();
            }
        }))
    };
    started.notified().await;
    assert_eq!(entered.load(Ordering::SeqCst), 4);
    drop(service);
    release.add_permits(4);
    runner.await.unwrap();
    assert_eq!(entered.load(Ordering::SeqCst), 4);
    let (sender, receiver) = mpsc::channel(CAPACITY);
    drop(sender);
    dispatch(receiver, |_| async {
        panic!("a recreated queue must not replay lost work")
    })
    .await;
}

#[tokio::test]
async fn link_preview_worker_partial_failure_and_supplied_text_without_page_fetch() {
    let backend = FakeBackend::default();
    let prepared = super::super::prepare(
        Some("https://supplied.example/ https://auto.example/ https://fail.example/"),
        Some(&MessageMetadataInput {
            link_previews: vec![LinkPreviewInput {
                status: None,
                url: "https://supplied.example/".into(),
                title: Some("Supplied".into()),
                image_url: None,
            }],
        }),
        Utc::now(),
    )
    .unwrap();
    let work = job(prepared.work);
    let mut keys = Vec::new();
    let completed = external_work(
        &backend,
        &work,
        Instant::now() + std::time::Duration::from_secs(30),
        &mut keys,
    )
    .await
    .unwrap();
    assert_eq!(
        *backend.pages.lock().unwrap(),
        ["https://auto.example/", "https://fail.example/"]
    );
    assert_eq!(completed[0].title.as_deref(), Some("Fetched title"));
    assert_eq!(
        completed[0].description.as_deref(),
        Some("Fetched description")
    );
    let serialized = serde_json::to_value(&completed[0]).unwrap();
    assert_eq!(serialized["description"], "Fetched description");
    assert_eq!(
        completed[0]
            .image
            .as_ref()
            .map(|image| (image.width, image.height)),
        Some((128, 64))
    );
    assert_eq!(completed[1].status, LinkPreviewStatus::Unavailable);
    assert_eq!(
        *backend.images.lock().unwrap(),
        ["https://image.example/a.png"]
    );
}

#[tokio::test]
async fn link_preview_worker_supplied_image_only_and_expiry_awaits_upload_ownership() {
    let backend = Arc::new(FakeBackend {
        hold_upload: true,
        ..Default::default()
    });
    let prepared = super::super::prepare(
        Some("https://supplied.example/"),
        Some(&MessageMetadataInput {
            link_previews: vec![LinkPreviewInput {
                status: None,
                url: "https://supplied.example/".into(),
                title: Some("Supplied".into()),
                image_url: Some("https://image.example/a.png".into()),
            }],
        }),
        Utc::now(),
    )
    .unwrap();
    let task = {
        let backend = backend.clone();
        tokio::spawn(async move {
            let mut keys = Vec::new();
            let result = external_work(
                backend.as_ref(),
                &job(prepared.work),
                Instant::now() + std::time::Duration::from_secs(30),
                &mut keys,
            )
            .await;
            (result, keys)
        })
    };
    backend.uploading.notified().await;
    assert!(backend.pages.lock().unwrap().is_empty());
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(31)).await;
    assert!(!task.is_finished());
    backend.release.notify_one();
    let (result, keys) = task.await.unwrap();
    assert!(result.is_none());
    assert_eq!(keys, *backend.uploaded.lock().unwrap());
    assert_eq!(keys.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn link_preview_worker_stale_upload_is_cleaned_and_unpublished_metadata_is_stored() {
    use diesel::{
        connection::SimpleConnection,
        r2d2::{ConnectionManager, CustomizeConnection},
    };
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return;
    };
    #[derive(Debug)]
    struct IsolatedMessages;
    impl CustomizeConnection<diesel::PgConnection, diesel::r2d2::Error> for IsolatedMessages {
        fn on_acquire(&self, conn: &mut diesel::PgConnection) -> Result<(), diesel::r2d2::Error> {
            conn.batch_execute("CREATE TEMP TABLE messages (LIKE messages INCLUDING DEFAULTS)")
                .map_err(diesel::r2d2::Error::QueryError)
        }
    }
    let db = DbPool::builder()
        .max_size(1)
        .connection_customizer(Box::new(IsolatedMessages))
        .build(ConnectionManager::<diesel::PgConnection>::new(url))
        .unwrap();
    let config = crate::config::AppConfig::from_env(crate::config::ConfigFile::from_env());
    let metrics = crate::metrics::Metrics::new();
    let services = Context {
        db,
        media: crate::build_media_store(&config).await,
        avatars: Arc::new(AvatarService::new(
            config.avatars.clone(),
            metrics.avatars.clone(),
        )),
        registry: Arc::new(ConnectionRegistry::new(metrics.ws.clone())),
        backend: FakeBackend::default(),
    };
    let prepared = super::super::prepare(Some("https://auto.example/"), None, Utc::now()).unwrap();
    let original = prepared.metadata.clone();
    {
        let mut conn = services.db.get().unwrap();
        conn.batch_execute("INSERT INTO messages (id,chat_id,sender_uid,message,message_type,client_generated_id,created_at,is_published) VALUES (-991,-992,1,'https://auto.example/','audio','preview-worker',now(),false)").unwrap();
        diesel::update(dsl::messages.find(-991))
            .set(dsl::metadata.eq(&original))
            .execute(&mut conn)
            .unwrap();
    }
    let context = Context {
        db: services.db.clone(),
        media: services.media.clone(),
        avatars: services.avatars.clone(),
        registry: services.registry.clone(),
        backend: FakeBackend::default(),
    };
    run_job(&context, job(prepared.work)).await;
    let current: Message = dsl::messages
        .find(-991)
        .select(Message::as_select())
        .first(&mut services.db.get().unwrap())
        .unwrap();
    let stored: StoredMessageMetadata =
        serde_json::from_value(current.metadata.clone().unwrap()).unwrap();
    assert_eq!(
        stored.link_previews[0].title.as_deref(),
        Some("Fetched title")
    );
    assert_eq!(
        stored.link_previews[0].description.as_deref(),
        Some("Fetched description")
    );
    assert!(stored.link_previews[0].image.is_some());
    assert!(current.updated_at.is_none());
    assert!(!current.is_published);
    assert!(context.backend.deleted.lock().unwrap().is_empty());
    for deleted in [false, true] {
        {
            let mut conn = services.db.get().unwrap();
            diesel::update(dsl::messages.find(-991))
                .set((
                    dsl::metadata.eq(&original),
                    dsl::updated_at.eq::<Option<DateTime<Utc>>>(None),
                    dsl::deleted_at.eq::<Option<DateTime<Utc>>>(None),
                ))
                .execute(&mut conn)
                .unwrap();
        }
        let context = Arc::new(Context {
            db: services.db.clone(),
            media: services.media.clone(),
            avatars: services.avatars.clone(),
            registry: services.registry.clone(),
            backend: FakeBackend {
                hold_upload: true,
                ..Default::default()
            },
        });
        let task = {
            let context = context.clone();
            tokio::spawn(async move {
                run_job(
                    &context,
                    job(vec![LinkPreviewWork::FetchPage {
                        url: "https://auto.example/".into(),
                    }]),
                )
                .await
            })
        };
        context.backend.uploading.notified().await;
        {
            let mut conn = services.db.get().unwrap();
            if deleted {
                diesel::update(dsl::messages.find(-991))
                    .set(dsl::deleted_at.eq(Some(Utc::now())))
                    .execute(&mut conn)
                    .unwrap();
            } else {
                diesel::update(dsl::messages.find(-991))
                    .set(dsl::updated_at.eq(Some(Utc::now())))
                    .execute(&mut conn)
                    .unwrap();
            }
        }
        context.backend.release.notify_one();
        task.await.unwrap();
        let current: Message = dsl::messages
            .find(-991)
            .select(Message::as_select())
            .first(&mut services.db.get().unwrap())
            .unwrap();
        assert_eq!(current.metadata, original);
        assert_eq!(
            *context.backend.deleted.lock().unwrap(),
            *context.backend.uploaded.lock().unwrap()
        );
    }
}

#[tokio::test]
async fn draft_thumbnail_publication_does_not_fetch_page_or_image_again() {
    let backend = FakeBackend::default();
    let mut source = Cursor::new(Vec::new());
    ::image::RgbaImage::new(100, 50)
        .write_to(&mut source, ::image::ImageFormat::Png)
        .unwrap();
    let thumbnail = image::thumbnail(&source.into_inner()).unwrap();
    let work = job(vec![LinkPreviewWork::CacheThumbnail {
        url: "https://example.com/".into(),
        thumbnail,
    }]);
    let mut keys = Vec::new();
    let result = external_work(
        &backend,
        &work,
        Instant::now() + std::time::Duration::from_secs(30),
        &mut keys,
    )
    .await
    .unwrap();
    assert!(backend.pages.lock().unwrap().is_empty());
    assert!(backend.images.lock().unwrap().is_empty());
    assert_eq!(backend.uploaded.lock().unwrap().len(), 1);
    assert_eq!(result[0].image.as_ref().unwrap().width, 100);
    assert_eq!(keys.len(), 1);
}
