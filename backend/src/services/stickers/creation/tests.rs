use super::*;
use crate::schema::group_membership;
use diesel::connection::SimpleConnection;
use std::sync::{Arc, Mutex};

struct FakeStorage {
    store: MediaStore,
    requests: Arc<Mutex<Vec<(String, String)>>>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for FakeStorage {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[derive(Clone)]
struct StoragePause {
    started: tokio::sync::mpsc::UnboundedSender<String>,
    release: Arc<tokio::sync::Semaphore>,
}

async fn fake_storage() -> FakeStorage {
    fake_storage_with_content(b"123456".to_vec(), None).await
}

async fn fake_storage_with_content(content: Vec<u8>, pause: Option<StoragePause>) -> FakeStorage {
    use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
    use axum::{body::Body, http::Request, routing::any, Router};
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let app = Router::new().fallback(any(move |request: Request<Body>| {
        let recorded = recorded.clone();
        let content = content.clone();
        let pause = pause.clone();
        async move {
            let method = request.method().to_string();
            recorded.lock().unwrap().push((
                request.method().to_string(),
                request.uri().path().to_owned(),
            ));
            let _ = axum::body::to_bytes(request.into_body(), 1024 * 1024)
                .await
                .unwrap();
            if let Some(pause) = pause.filter(|_| method == "GET" || method == "PUT") {
                pause.started.send(method).unwrap();
                pause.release.acquire().await.unwrap().forget();
            }
            // Chunked body deliberately omits Content-Length to exercise the streaming bound.
            let middle = content.len() / 2;
            Body::from_stream(futures::stream::iter([
                Ok::<_, std::io::Error>(content[..middle].to_vec()),
                Ok(content[middle..].to_vec()),
            ]))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = aws_sdk_s3::Client::from_conf(
        aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("us-east-1"))
            .credentials_provider(Credentials::new("test", "test", None, None, "test"))
            .endpoint_url(&endpoint)
            .force_path_style(true)
            .build(),
    );
    FakeStorage {
        store: MediaStore::new(
            client,
            Arc::new(crate::config::MediaConfig {
                bucket: "test".into(),
                attachment_prefix: "attachments".into(),
                base_url: None,
                upload_proxy_path: None,
                endpoint_url: Some(endpoint),
                max_attachment_file_size_bytes: 50 * 1024 * 1024,
            }),
        ),
        requests,
        server,
    }
}

#[tokio::test]
async fn sticker_download_enforces_actual_size() {
    let storage = fake_storage().await;
    assert_eq!(
        storage.store.get_object_limited("source", 6).await.unwrap(),
        b"123456"
    );
    assert_eq!(
        storage.store.get_object_limited("source", 5).await,
        Err((
            axum::http::StatusCode::PAYLOAD_TOO_LARGE,
            "Media file too large"
        ))
    );
    assert_eq!(storage.store.get_object("source").await.unwrap(), b"123456");
}

#[tokio::test]
async fn failed_sticker_creation_removes_only_new_object() {
    let Some(pool) = pooled_fixture() else { return };
    let mut conn = pool.get().unwrap();
    let storage = fake_storage().await;
    let source = load_message_image(&mut conn, 1, 10, 100).unwrap();
    conn.batch_execute("UPDATE messages SET deleted_at = NOW()")
        .unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::RgbaImage::new(2, 2)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    drop(conn);
    let result = create_sticker(
        &pool,
        &storage.store,
        &ids::new_generator(),
        1,
        20,
        StickerInput {
            bytes: png.into_inner(),
            content_type: "image/png".into(),
            file_name: "source.png".into(),
            emoji: "😀".into(),
            name: None,
            description: None,
        },
        Some(source),
    )
    .await;
    assert!(matches!(result, Err(AppError::NotFound(_))));
    let requests = storage.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].0, "PUT");
    assert_eq!(requests[1].0, "DELETE");
    assert_eq!(requests[0].1, requests[1].1);
    assert!(requests[0].1.starts_with("/test/stickers/"));
    assert_eq!(
        media::table
            .count()
            .get_result::<i64>(&mut pool.get().unwrap())
            .unwrap(),
        0
    );
}

fn fixture() -> Option<PgConnection> {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return None;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    setup_fixture(&mut conn);
    Some(conn)
}

fn pooled_fixture() -> Option<DbPool> {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return None;
    };
    let pool = DbPool::builder()
        .max_size(1)
        .connection_timeout(std::time::Duration::from_millis(200))
        .build(diesel::r2d2::ConnectionManager::<PgConnection>::new(url))
        .unwrap();
    setup_fixture(&mut pool.get().unwrap());
    Some(pool)
}

fn setup_fixture(conn: &mut PgConnection) {
    conn.batch_execute(
        "CREATE TEMP TABLE group_membership (LIKE public.group_membership INCLUDING ALL);
         CREATE TEMP TABLE messages (LIKE public.messages INCLUDING ALL);
         CREATE TEMP TABLE attachments (LIKE public.attachments INCLUDING ALL);
         CREATE TEMP TABLE sticker_packs (LIKE public.sticker_packs INCLUDING ALL);
         CREATE TEMP TABLE stickers (LIKE public.stickers INCLUDING ALL);
         CREATE TEMP TABLE media (LIKE public.media INCLUDING ALL);
         CREATE TEMP TABLE sticker_pack_stickers (LIKE public.sticker_pack_stickers INCLUDING ALL);
         INSERT INTO group_membership(chat_id, uid) VALUES (10, 1), (10, 2);
         INSERT INTO sticker_packs(id, owner_uid, name) VALUES (20, 1, 'owned');
         INSERT INTO messages(id, chat_id, sender_uid, message_type, client_generated_id,
                              created_at, is_published, has_attachments)
         VALUES (100, 10, 2, 'text', 'sticker-source', NOW(), true, true);
         INSERT INTO attachments(id, message_id, uploader_uid, kind, external_reference, size, created_at)
         VALUES (200, 100, 2, 'image/png', 'attachments/source.png', 10, NOW());",
    ).unwrap();
}

#[tokio::test]
async fn media_io_releases_connections_and_commit_failures_cleanup() {
    #[derive(Clone, Copy, Debug)]
    enum CommitOutcome {
        Success,
        SourceDeleted,
        PoolExhausted,
    }

    for outcome in [
        CommitOutcome::Success,
        CommitOutcome::SourceDeleted,
        CommitOutcome::PoolExhausted,
    ] {
        let Some(pool) = pooled_fixture() else { return };
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbaImage::new(2, 2)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let (started, mut requests_started) = tokio::sync::mpsc::unbounded_channel();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let storage = fake_storage_with_content(
            png.into_inner(),
            Some(StoragePause {
                started,
                release: release.clone(),
            }),
        )
        .await;
        let request_pool = pool.clone();
        let store = storage.store.clone();
        let request = tokio::spawn(async move {
            create_sticker_from_message(
                &request_pool,
                &store,
                &ids::new_generator(),
                1,
                20,
                CreateStickerFromMessageBody {
                    chat_id: 10,
                    message_id: 100,
                    emoji: "😀".into(),
                    name: None,
                    description: None,
                },
            )
            .await
        });
        let mut held_connection = None;
        for method in ["GET", "PUT"] {
            let observed =
                tokio::time::timeout(std::time::Duration::from_secs(5), requests_started.recv())
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(observed, method);
            // There is only one connection: it must be free during both downloads and uploads.
            let mut conn = pool
                .try_get()
                .expect("sticker media I/O held the database connection");
            assert_eq!(
                media::table.count().get_result::<i64>(&mut conn).unwrap(),
                0
            );
            if method == "PUT" {
                match outcome {
                    CommitOutcome::SourceDeleted => {
                        diesel::update(messages::table.find(100_i64))
                            .set(messages::deleted_at.eq(Utc::now()))
                            .execute(&mut conn)
                            .unwrap();
                    }
                    CommitOutcome::PoolExhausted => held_connection = Some(conn),
                    CommitOutcome::Success => {}
                }
            }
            // Any non-retained connection drops before the spawned request can resume.
            release.add_permits(1);
        }
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), request)
            .await
            .unwrap()
            .unwrap();
        drop(held_connection);
        let requests = storage.requests.lock().unwrap();
        let mut conn = pool.get().unwrap();
        match outcome {
            CommitOutcome::Success => {
                let (sticker, media_row) = result.unwrap();
                assert_eq!(media_row.content_type, "image/webp");
                assert_eq!(requests.len(), 2);
                assert_eq!(
                    sticker_pack_stickers::table
                        .find((20_i64, sticker.id))
                        .count()
                        .get_result::<i64>(&mut conn)
                        .unwrap(),
                    1
                );
                assert_eq!(
                    attachments::table
                        .find(200_i64)
                        .select(attachments::message_id)
                        .first::<Option<i64>>(&mut conn)
                        .unwrap(),
                    Some(100)
                );
            }
            CommitOutcome::SourceDeleted | CommitOutcome::PoolExhausted => {
                assert!(match outcome {
                    CommitOutcome::SourceDeleted => matches!(result, Err(AppError::NotFound(_))),
                    CommitOutcome::PoolExhausted => matches!(result, Err(AppError::DbPool(_))),
                    CommitOutcome::Success => unreachable!(),
                });
                assert_eq!(requests.len(), 3);
                assert_eq!(requests[2].0, "DELETE");
                assert_eq!(requests[1].1, requests[2].1);
                assert_eq!(
                    media::table.count().get_result::<i64>(&mut conn).unwrap(),
                    0
                );
                assert_eq!(
                    stickers::table
                        .count()
                        .get_result::<i64>(&mut conn)
                        .unwrap(),
                    0
                );
            }
        }
    }
}

fn rows() -> (NewMedia, NewSticker) {
    let now = Utc::now();
    (
        NewMedia {
            id: 300,
            content_type: "image/webp".into(),
            storage_key: "stickers/copy.webp".into(),
            size: 10,
            created_at: now,
            deleted_at: None,
            file_name: "source.png".into(),
            width: Some(1),
            height: Some(1),
            purpose: MediaPurpose::Sticker,
            reference: None,
        },
        NewSticker {
            id: 400,
            media_id: 300,
            emoji: "😀".into(),
            name: None,
            description: None,
            created_at: now,
        },
    )
}

#[test]
fn source_read_does_not_block_read_pointer_updates_or_membership_removal() {
    let Some(mut conn) = fixture() else { return };
    let url = std::env::var("WETTY_TEST_DATABASE_URL").unwrap();
    let mut other = PgConnection::establish(&url).unwrap();
    // Only membership is shared between connections. Source messages and media
    // stay in the fixture's session-local tables; no application rows are touched.
    let schema = format!("sticker_membership_test_{}", uuid::Uuid::new_v4().simple());
    other
        .batch_execute(&format!(
            "CREATE SCHEMA {schema};
         CREATE TABLE {schema}.group_membership (LIKE public.group_membership INCLUDING ALL);
         INSERT INTO {schema}.group_membership(chat_id, uid) VALUES (10, 1);
         SET search_path TO {schema}, public;
         SET lock_timeout = '500ms';"
        ))
        .unwrap();
    conn.batch_execute(&format!(
        "DROP TABLE pg_temp.group_membership;
         SET search_path TO pg_temp, {schema}, public;"
    ))
    .unwrap();

    let result = conn.transaction::<_, AppError, _>(|conn| {
        let source = load_message_image(conn, 1, 10, 100)?;
        other.transaction::<_, AppError, _>(|other| {
            // An exclusive membership-management lock must also remain available.
            crate::services::speaking::lock_chat(other, 10, true)?;
            diesel::update(group_membership::table.find((10_i64, 1)))
                .set(group_membership::last_read_message_id.eq(100_i64))
                .execute(other)?;
            diesel::delete(group_membership::table.find((10_i64, 1))).execute(other)?;
            Ok(())
        })?;
        Ok(source.attachment.id)
    });
    other
        .batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
        .unwrap();
    assert_eq!(result.unwrap(), 200);
}

#[test]
fn source_requires_membership_and_one_published_image_without_text() {
    let Some(mut conn) = fixture() else { return };
    // Both sender and another chat member may copy the image.
    for uid in [1, 2] {
        assert_eq!(
            load_message_image(&mut conn, uid, 10, 100)
                .unwrap()
                .attachment
                .id,
            200
        );
    }
    assert!(matches!(
        load_message_image(&mut conn, 3, 10, 100),
        Err(AppError::Forbidden(_))
    ));
    assert!(matches!(
        load_message_image(&mut conn, 1, 10, 999),
        Err(AppError::NotFound(_))
    ));
    conn.batch_execute("INSERT INTO group_membership(chat_id, uid) VALUES (11, 1)")
        .unwrap();
    assert!(matches!(
        load_message_image(&mut conn, 1, 11, 100),
        Err(AppError::NotFound(_))
    ));
    for mutation in [
        "UPDATE messages SET message = 'caption'",
        "UPDATE messages SET message_type = 'file'",
        "UPDATE attachments SET kind = 'video/webm'",
        "UPDATE attachments SET deleted_at = NOW()",
        "UPDATE attachments SET message_id = NULL",
        "UPDATE attachments SET size = 10485761",
        "INSERT INTO attachments(id, message_id, kind, external_reference, size, created_at)
         VALUES (201, 100, 'image/png', 'second.png', 10, NOW())",
    ] {
        conn.test_transaction::<(), AppError, _>(|conn| {
            conn.batch_execute(mutation).unwrap();
            assert!(
                matches!(
                    load_message_image(conn, 1, 10, 100),
                    Err(AppError::BadRequest(_))
                ),
                "{mutation}"
            );
            Ok(())
        });
    }
    for mutation in [
        "UPDATE messages SET deleted_at = NOW()",
        "UPDATE messages SET is_published = false",
    ] {
        conn.test_transaction::<(), AppError, _>(|conn| {
            conn.batch_execute(mutation).unwrap();
            assert!(matches!(
                load_message_image(conn, 1, 10, 100),
                Err(AppError::NotFound(_))
            ));
            Ok(())
        });
    }
}

#[test]
fn insertion_rechecks_source_and_owner_and_preserves_message() {
    let Some(mut conn) = fixture() else { return };
    let source = load_message_image(&mut conn, 1, 10, 100).unwrap();
    let (new_media, new_sticker) = rows();
    assert!(matches!(
        insert_sticker(&mut conn, 2, 20, &new_media, &new_sticker, Some(&source)),
        Err(AppError::Forbidden(_))
    ));
    assert!(matches!(
        insert_sticker(&mut conn, 1, 99, &new_media, &new_sticker, Some(&source)),
        Err(AppError::NotFound(_))
    ));
    for mutation in [
        "UPDATE messages SET message = 'edited'",
        "UPDATE messages SET deleted_at = NOW()",
        "DELETE FROM group_membership WHERE uid = 1",
        "UPDATE attachments SET external_reference = 'replacement.png'",
        "UPDATE sticker_packs SET owner_uid = 2",
    ] {
        conn.test_transaction::<(), AppError, _>(|conn| {
            conn.batch_execute(mutation).unwrap();
            assert!(
                insert_sticker(conn, 1, 20, &new_media, &new_sticker, Some(&source)).is_err(),
                "{mutation}"
            );
            assert_eq!(media::table.count().get_result::<i64>(conn).unwrap(), 0);
            Ok(())
        });
    }
    let before = messages::table
        .find(100_i64)
        .select(Message::as_select())
        .first::<Message>(&mut conn)
        .unwrap();
    insert_sticker(&mut conn, 1, 20, &new_media, &new_sticker, Some(&source)).unwrap();
    let after = messages::table
        .find(100_i64)
        .select(Message::as_select())
        .first::<Message>(&mut conn)
        .unwrap();
    assert_eq!(
        serde_json::to_value(before).unwrap(),
        serde_json::to_value(after).unwrap()
    );
    assert_eq!(
        attachments::table
            .find(200_i64)
            .select(attachments::message_id)
            .first::<Option<i64>>(&mut conn)
            .unwrap(),
        Some(100)
    );
    assert_eq!(
        sticker_pack_stickers::table
            .find((20_i64, 400_i64))
            .count()
            .get_result::<i64>(&mut conn)
            .unwrap(),
        1
    );
}

#[test]
fn failed_pack_link_rolls_back_media_and_sticker() {
    let Some(mut conn) = fixture() else { return };
    conn.batch_execute(
        "ALTER TABLE sticker_pack_stickers ADD CONSTRAINT reject_link CHECK (sticker_id <> 400)",
    )
    .unwrap();
    let (new_media, new_sticker) = rows();
    assert!(insert_sticker(&mut conn, 1, 20, &new_media, &new_sticker, None).is_err());
    assert_eq!(
        media::table.count().get_result::<i64>(&mut conn).unwrap(),
        0
    );
    assert_eq!(
        stickers::table
            .count()
            .get_result::<i64>(&mut conn)
            .unwrap(),
        0
    );
}

#[test]
fn shared_processing_preserves_alpha_and_limits_dimensions() {
    let image = image::RgbaImage::from_pixel(1024, 512, image::Rgba([100, 50, 20, 0]));
    let mut png = std::io::Cursor::new(Vec::new());
    image.write_to(&mut png, image::ImageFormat::Png).unwrap();
    let mut input = StickerInput {
        bytes: png.into_inner(),
        content_type: "image/png".into(),
        file_name: "source.png".into(),
        emoji: "😀".into(),
        name: None,
        description: None,
    };
    let processed = prepare(&input).unwrap();
    assert_eq!((processed.width, processed.height), (Some(512), Some(256)));
    assert_eq!(processed.content_type, "image/webp");
    assert_eq!(
        image::load_from_memory(&processed.data)
            .unwrap()
            .to_rgba8()
            .get_pixel(0, 0)[3],
        0
    );
    input.bytes = b"not an image".to_vec();
    assert!(prepare(&input).is_err());
    input.bytes = vec![0; MAX_STICKER_UPLOAD_BYTES + 1];
    assert!(matches!(
        prepare(&input),
        Err(AppError::BadRequest("Sticker file too large"))
    ));
    for emoji in ["", "abc", "😀😀😀😀😀"] {
        assert!(validate_sticker_emoji(emoji).is_err());
    }
    assert_eq!(validate_sticker_emoji("👨‍👩‍👧‍👦").unwrap(), "👨‍👩‍👧‍👦");
}

#[test]
fn shared_processing_preserves_animated_gif() {
    let mut bytes = Vec::new();
    {
        let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
        for color in [[255, 0, 0, 255], [0, 255, 0, 255]] {
            encoder
                .encode_frame(image::Frame::new(image::RgbaImage::from_pixel(
                    2,
                    2,
                    image::Rgba(color),
                )))
                .unwrap();
        }
    }
    let input = StickerInput {
        bytes,
        content_type: "image/gif".into(),
        file_name: "animation.gif".into(),
        emoji: "😀".into(),
        name: None,
        description: None,
    };
    let processed = prepare(&input).unwrap();
    assert_eq!(processed.content_type, "image/gif");
    assert_eq!(processed.data, input.bytes);
}
