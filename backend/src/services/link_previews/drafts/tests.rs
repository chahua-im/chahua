use super::*;
use crate::dto::link_previews::{LinkPreviewInput, LinkPreviewInputStatus, MessageMetadataInput};
use crate::services::link_previews::prepare;

fn seed(cache: &DraftPreviews, uid: i32, at: Instant) {
    let cell = OnceCell::new();
    assert!(cell
        .set(DraftPreview {
            preview: LinkPreviewResponse {
                url: "https://example.com/".into(),
                status: LinkPreviewStatus::Ready,
                title: Some("Cached".into()),
                description: Some("Description".into()),
                image: None,
                expires_at: None
            },
            thumbnail: Some(Thumbnail {
                bytes: vec![1, 2, 3],
                width: 10,
                height: 12
            }),
        })
        .is_ok());
    cache
        .entries
        .lock()
        .unwrap()
        .insert((uid, "https://example.com/".into()), (at, Arc::new(cell)));
}

#[tokio::test]
async fn draft_cache_reuses_server_metadata_and_thumbnail_without_external_io() {
    let cache = DraftPreviews::default();
    seed(&cache, 7, Instant::now());
    let result = cache
        .fetch(7, vec!["https://EXAMPLE.com".into()])
        .await
        .unwrap();
    assert_eq!(result[0].title.as_deref(), Some("Cached"));
    let mut prepared = prepare(Some("https://example.com/"), None, Utc::now()).unwrap();
    prepared.metadata.as_mut().unwrap()["other"] = serde_json::json!(42);
    cache.apply(7, &mut prepared);
    assert_eq!(prepared.metadata.as_ref().unwrap()["other"], 42);
    assert_eq!(
        prepared.metadata.unwrap()["linkPreviews"][0]["description"],
        "Description"
    );
    assert!(
        matches!(&prepared.work[..], [LinkPreviewWork::CacheThumbnail { thumbnail, .. }] if thumbnail.bytes == [1, 2, 3])
    );
}

#[test]
fn editing_before_thumbnail_publication_requeues_pending_work() {
    let cache = DraftPreviews::default();
    seed(&cache, 7, Instant::now());
    let mut sent = prepare(Some("https://example.com/"), None, Utc::now()).unwrap();
    cache.apply(7, &mut sent);
    assert_eq!(
        sent.metadata.as_ref().unwrap()["linkPreviews"][0]["status"],
        "pending"
    );
    assert!(sent.metadata.as_ref().unwrap()["linkPreviews"][0]["expiresAt"].is_string());
    let mut edited = super::super::prepare_edit(
        "https://example.com/ edited",
        None,
        sent.metadata.as_ref(),
        Utc::now(),
    )
    .unwrap();
    cache.apply(7, &mut edited);
    assert!(matches!(
        &edited.work[..],
        [LinkPreviewWork::CacheThumbnail { .. }]
    ));
    assert_eq!(
        edited.metadata.as_ref().unwrap()["linkPreviews"][0]["title"],
        "Cached"
    );
    assert_eq!(
        edited.metadata.as_ref().unwrap()["linkPreviews"][0]["status"],
        "pending"
    );
    cache.entries.lock().unwrap().clear();
    let mut uncached = super::super::prepare_edit(
        "https://example.com/ edited again",
        None,
        edited.metadata.as_ref(),
        Utc::now(),
    )
    .unwrap();
    cache.apply(7, &mut uncached);
    assert!(matches!(
        &uncached.work[..],
        [LinkPreviewWork::FetchPage { .. }]
    ));
}

#[test]
fn draft_cache_is_account_scoped_expires_and_cannot_enable_disabled_entries() {
    let cache = DraftPreviews::default();
    seed(&cache, 7, Instant::now());
    let mut prepared = prepare(Some("https://example.com/"), None, Utc::now()).unwrap();
    cache.apply(8, &mut prepared);
    assert!(matches!(
        &prepared.work[..],
        [LinkPreviewWork::FetchPage { .. }]
    ));
    let input = MessageMetadataInput {
        link_previews: vec![LinkPreviewInput {
            url: "https://example.com/".into(),
            status: Some(LinkPreviewInputStatus::Disabled),
            title: None,
            image_url: None,
        }],
    };
    let mut prepared = prepare(Some("https://example.com/"), Some(&input), Utc::now()).unwrap();
    cache.apply(7, &mut prepared);
    assert!(prepared.work.is_empty());
    assert_eq!(
        prepared.metadata.unwrap()["linkPreviews"][0]["status"],
        "disabled"
    );
    seed(&cache, 7, Instant::now() - TTL);
    let mut prepared = prepare(Some("https://example.com/"), None, Utc::now()).unwrap();
    cache.apply(7, &mut prepared);
    assert!(matches!(
        &prepared.work[..],
        [LinkPreviewWork::FetchPage { .. }]
    ));
}

#[tokio::test]
async fn draft_fetch_rejects_unsafe_or_oversized_requests_before_io() {
    let cache = DraftPreviews::default();
    for urls in [
        vec![],
        vec!["https://example.com/".into(); 4],
        vec!["http://example.com/".into()],
        vec!["https://127.0.0.1/".into()],
    ] {
        assert!(cache.fetch(7, urls).await.is_err());
    }
}
