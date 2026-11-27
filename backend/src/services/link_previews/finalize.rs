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
            if preview.status == LinkPreviewStatus::Disabled {
                continue;
            }
            if let Some(result) = completed.iter().find(|result| result.url == preview.url) {
                merge_completed(preview, result);
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

/// Queue the hydrated preview while a concurrent edit or recall is blocked.
/// Hydration must finish before taking this lock.
pub(super) fn with_current_preview(
    conn: &mut PgConnection,
    snapshot: &Message,
    publish: impl FnOnce(),
) -> QueryResult<()> {
    conn.transaction(|conn| {
        let current = dsl::messages
            .find(snapshot.id)
            .filter(dsl::deleted_at.is_null())
            .filter(dsl::is_published)
            .filter(dsl::updated_at.is_not_distinct_from(snapshot.updated_at))
            .filter(dsl::metadata.is_not_distinct_from(snapshot.metadata.as_ref()))
            .for_share()
            .select(dsl::id)
            .first::<i64>(conn)
            .optional()?;
        if current.is_some() {
            publish();
        }
        Ok(())
    })
}

// Image-only work completes the preview without replacing its already acquired text.
fn merge_completed(preview: &mut StoredLinkPreview, result: &StoredLinkPreview) {
    if preview.status == LinkPreviewStatus::Ready
        || (preview.title.is_some() && result.title.is_none())
    {
        if preview.status == LinkPreviewStatus::Pending {
            preview.status = result.status;
            preview.expires_at = result.expires_at;
        }
        if result.image.is_some() {
            preview.image = result.image.clone();
        }
    } else {
        *preview = result.clone();
    }
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
mod tests;
