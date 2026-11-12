use chrono::{DateTime, Utc};
use diesel::{prelude::*, PgConnection};

use crate::{
    dto::link_previews::{LinkPreviewStatus, StoredLinkPreview},
    models::Message,
    schema::messages::dsl,
};

/// Enrichment changes only metadata; nullable edit versions match with PostgreSQL
/// null-safe equality. The row lock keeps unrelated JSON keys intact.
pub fn finalize_metadata(
    conn: &mut PgConnection,
    message_id: i64,
    chat_id: i64,
    expected_updated_at: Option<DateTime<Utc>>,
    expires_at: DateTime<Utc>,
    completed: &[StoredLinkPreview],
) -> QueryResult<Option<Message>> {
    conn.transaction(|conn| {
        let current = dsl::messages
            .filter(dsl::id.eq(message_id))
            .filter(dsl::chat_id.eq(chat_id))
            .for_update()
            .select(Message::as_select())
            .first::<Message>(conn)
            .optional()?;
        let Some(current) = current else {
            return Ok(None);
        };
        if Utc::now() >= expires_at {
            return Ok(None);
        }
        let mut metadata = current.metadata.unwrap_or_else(|| serde_json::json!({}));
        let Some(object) = metadata.as_object_mut() else {
            return Ok(None);
        };
        let Some(previews) = object.get("linkPreviews") else {
            return Ok(None);
        };
        let Ok(mut previews) =
            <Vec<StoredLinkPreview> as serde::Deserialize>::deserialize(previews)
        else {
            return Ok(None);
        };
        for preview in &mut previews {
            if let Some(result) = completed.iter().find(|result| result.url == preview.url) {
                if preview.status == LinkPreviewStatus::Ready {
                    // Existing text is authoritative; image work only fills
                    // its cached thumbnail.
                    if result.image.is_some() {
                        preview.image = result.image.clone();
                    }
                } else {
                    *preview = result.clone();
                }
            }
        }
        let merged = serde_json::to_value(previews).expect("preview metadata is serializable");
        if object.get("linkPreviews") == Some(&merged) {
            return Ok(None);
        }
        object.insert("linkPreviews".into(), merged);
        diesel::update(
            dsl::messages
                .filter(dsl::id.eq(message_id))
                .filter(dsl::chat_id.eq(chat_id))
                .filter(dsl::deleted_at.is_null())
                .filter(dsl::updated_at.is_not_distinct_from(expected_updated_at)),
        )
        .set(dsl::metadata.eq(Some(metadata)))
        .returning(Message::as_returning())
        .get_result(conn)
        .optional()
    })
}

/// PostgreSQL stores microseconds; each edit must supersede even a regressed clock.
pub fn next_edit_timestamp(now: DateTime<Utc>, previous: Option<DateTime<Utc>>) -> DateTime<Utc> {
    let now =
        DateTime::from_timestamp_micros(now.timestamp_micros()).expect("UTC timestamp in range");
    previous.map_or(now, |previous| {
        now.max(previous + chrono::Duration::microseconds(1))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::link_previews::LinkPreviewStatus;
    use diesel::connection::SimpleConnection;
    use serde_json::Value;

    fn finalize_metadata(
        conn: &mut PgConnection,
        message_id: i64,
        chat_id: i64,
        expected: Option<DateTime<Utc>>,
        completed: &[StoredLinkPreview],
    ) -> QueryResult<Option<Message>> {
        super::finalize_metadata(
            conn,
            message_id,
            chat_id,
            expected,
            Utc::now() + chrono::Duration::seconds(30),
            completed,
        )
    }

    struct FixtureSchema {
        url: String,
        name: String,
    }
    impl Drop for FixtureSchema {
        fn drop(&mut self) {
            let mut conn = PgConnection::establish(&self.url).unwrap();
            conn.batch_execute(&format!("DROP SCHEMA IF EXISTS {} CASCADE", self.name))
                .unwrap();
        }
    }

    #[test]
    fn link_preview_edit_clock_is_microsecond_precise_and_monotonic() {
        let clock = DateTime::from_timestamp(1_700_000_000, 123_456_789).unwrap();
        let first = next_edit_timestamp(clock, None);
        assert_eq!(first.timestamp_subsec_nanos(), 123_456_000);
        let second = next_edit_timestamp(clock, Some(first));
        let third = next_edit_timestamp(clock - chrono::Duration::seconds(5), Some(second));
        assert_eq!(second - first, chrono::Duration::microseconds(1));
        assert_eq!(third - second, chrono::Duration::microseconds(1));
    }

    fn ready() -> Vec<StoredLinkPreview> {
        vec![StoredLinkPreview {
            url: "https://example.com/".into(),
            status: LinkPreviewStatus::Ready,
            expires_at: None,
            title: Some("Example".into()),
            description: Some("Description".into()),
            image: None,
        }]
    }

    fn pending_metadata() -> Value {
        serde_json::json!({
            "other": { "keep": true },
            "linkPreviews": [{"url": "https://example.com/", "status": "pending"}]
        })
    }

    #[test]
    fn link_preview_database_null_guard_and_metadata_merge() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.batch_execute("CREATE TEMP TABLE messages (LIKE messages INCLUDING DEFAULTS); INSERT INTO messages (id, chat_id, sender_uid, message, message_type, client_generated_id, created_at, metadata) VALUES (1, 2, 1, 'https://example.com/', 'text', 'preview-test', now(), '{\"other\": {\"keep\": true}}');").unwrap();
        diesel::update(dsl::messages.find(1))
            .set(dsl::metadata.eq(Some(pending_metadata())))
            .execute(&mut conn)
            .unwrap();
        let updated = finalize_metadata(&mut conn, 1, 2, None, &ready())
            .unwrap()
            .unwrap();
        assert!(updated.updated_at.is_none());
        assert_eq!(updated.metadata.as_ref().unwrap()["other"]["keep"], true);
        assert_eq!(
            updated.metadata.as_ref().unwrap()["linkPreviews"][0]["title"],
            "Example"
        );
        assert_eq!(
            updated.metadata.as_ref().unwrap()["linkPreviews"][0]["description"],
            "Description"
        );
        // Same terminal result is not rewritten or published.
        assert!(finalize_metadata(&mut conn, 1, 2, None, &ready())
            .unwrap()
            .is_none());
        let existing = serde_json::json!({
            "linkPreviews": [{
                "url": "https://example.com/", "status": "ready",
                "title": "Existing title", "description": "Existing description"
            }]
        });
        diesel::update(dsl::messages.find(1))
            .set(dsl::metadata.eq(Some(existing)))
            .execute(&mut conn)
            .unwrap();
        let mut image_result = ready();
        image_result[0].image = Some(crate::dto::link_previews::StoredLinkPreviewImage {
            storage_key: "preview.webp".into(),
            width: 10,
            height: 10,
        });
        let updated = finalize_metadata(&mut conn, 1, 2, None, &image_result)
            .unwrap()
            .unwrap();
        let preview = &updated.metadata.as_ref().unwrap()["linkPreviews"][0];
        assert_eq!(preview["title"], "Existing title");
        assert_eq!(preview["description"], "Existing description");
        assert_eq!(preview["image"]["storageKey"], "preview.webp");
        diesel::update(dsl::messages.find(1))
            .set((
                dsl::updated_at.eq(Some(Utc::now())),
                dsl::metadata.eq(Some(pending_metadata())),
            ))
            .execute(&mut conn)
            .unwrap();
        assert!(finalize_metadata(&mut conn, 1, 2, None, &ready())
            .unwrap()
            .is_none());
        let live: Message = dsl::messages
            .find(1)
            .select(Message::as_select())
            .first(&mut conn)
            .unwrap();
        assert_eq!(live.metadata, Some(pending_metadata()));
        diesel::update(dsl::messages.find(1))
            .set((
                dsl::updated_at.eq::<Option<DateTime<Utc>>>(None),
                dsl::deleted_at.eq(Some(Utc::now())),
            ))
            .execute(&mut conn)
            .unwrap();
        assert!(finalize_metadata(&mut conn, 1, 2, None, &ready())
            .unwrap()
            .is_none());
    }

    #[test]
    fn link_preview_database_competing_edit_delete_and_publication() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let schema = format!("preview_{}", uuid::Uuid::new_v4().simple());
        let _cleanup = FixtureSchema {
            url: url.clone(),
            name: schema.clone(),
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.batch_execute(&format!(
            "CREATE SCHEMA {schema}; CREATE TABLE {schema}.messages (LIKE messages INCLUDING DEFAULTS);
             SET search_path TO {schema}, wetty_chat, public;
             INSERT INTO messages (id, chat_id, sender_uid, message, message_type, client_generated_id, created_at, is_published)
             VALUES (1, 2, 1, 'original', 'text', 'preview-race', now(), false);"
        )).unwrap();
        // Each mutation holds the lock before the worker's independent connection
        // attempts finalization. There is no event-order assertion here.
        for deletion in [false, true] {
            diesel::update(dsl::messages.find(1))
                .set((
                    dsl::updated_at.eq::<Option<DateTime<Utc>>>(None),
                    dsl::deleted_at.eq::<Option<DateTime<Utc>>>(None),
                    dsl::metadata.eq(Some(pending_metadata())),
                ))
                .execute(&mut conn)
                .unwrap();
            conn.build_transaction()
                .read_write()
                .run::<_, diesel::result::Error, _>(|conn| {
                    let _: Message = dsl::messages
                        .find(1)
                        .for_update()
                        .select(Message::as_select())
                        .first(conn)?;
                    let (started, attempted) = std::sync::mpsc::channel();
                    let worker_url = url.clone();
                    let worker_schema = schema.clone();
                    let worker = std::thread::spawn(move || {
                        let mut worker = PgConnection::establish(&worker_url).unwrap();
                        worker
                            .batch_execute(&format!(
                                "SET search_path TO {worker_schema}, wetty_chat, public"
                            ))
                            .unwrap();
                        started.send(()).unwrap();
                        finalize_metadata(&mut worker, 1, 2, None, &ready()).unwrap()
                    });
                    attempted.recv().unwrap();
                    if deletion {
                        diesel::update(dsl::messages.find(1))
                            .set(dsl::deleted_at.eq(Some(Utc::now())))
                            .execute(conn)?;
                    } else {
                        diesel::update(dsl::messages.find(1))
                            .set((
                                dsl::message.eq("edited"),
                                dsl::updated_at.eq(Some(Utc::now())),
                            ))
                            .execute(conn)?;
                    }
                    // The transaction must commit before joining the lock waiter.
                    Ok(worker)
                })
                .map(|worker| assert!(worker.join().unwrap().is_none()))
                .unwrap();
            let live: Message = dsl::messages
                .find(1)
                .select(Message::as_select())
                .first(&mut conn)
                .unwrap();
            assert_eq!(live.metadata, Some(pending_metadata()));
            assert_eq!(live.deleted_at.is_some(), deletion);
        }
        diesel::update(dsl::messages.find(1))
            .set((
                dsl::updated_at.eq::<Option<DateTime<Utc>>>(None),
                dsl::deleted_at.eq::<Option<DateTime<Utc>>>(None),
            ))
            .execute(&mut conn)
            .unwrap();
        let enriched = finalize_metadata(&mut conn, 1, 2, None, &ready())
            .unwrap()
            .unwrap();
        // Audio publication updates unrelated columns and cannot overwrite cards.
        diesel::update(dsl::messages.find(1))
            .set(dsl::is_published.eq(true))
            .execute(&mut conn)
            .unwrap();
        let published: Message = dsl::messages
            .find(1)
            .select(Message::as_select())
            .first(&mut conn)
            .unwrap();
        assert_eq!(published.metadata, enriched.metadata);
        diesel::update(dsl::messages.find(1))
            .set((
                dsl::message.eq("later edit"),
                dsl::updated_at.eq(Some(Utc::now())),
            ))
            .execute(&mut conn)
            .unwrap();
        let live: Message = dsl::messages
            .find(1)
            .select(Message::as_select())
            .first(&mut conn)
            .unwrap();
        assert_eq!(live.message.as_deref(), Some("later edit"));
        diesel::update(dsl::messages.find(1))
            .set(dsl::deleted_at.eq(Some(Utc::now())))
            .execute(&mut conn)
            .unwrap();
        let live: Message = dsl::messages
            .find(1)
            .select(Message::as_select())
            .first(&mut conn)
            .unwrap();
        assert!(live.deleted_at.is_some());
    }
}
