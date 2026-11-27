use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use diesel::prelude::*;
use diesel::sql_types::{Array, BigInt, Bool, Nullable, Text, Timestamptz};

use crate::dto::stickers::{
    StickerMediaResponse, StickerPackDiscoveryQuery, StickerPackPreviewSticker, StickerPackSort,
};
use crate::errors::AppError;
use crate::models::{Media, Sticker};
use crate::schema::{media, stickers};
use crate::services::media::MediaStore;

pub const RECENT_WINDOW_DAYS: i64 = 30;

#[derive(Debug, QueryableByName)]
pub struct RankedStickerPack {
    #[diesel(sql_type = BigInt)]
    pub pack_id: i64,
    #[diesel(sql_type = BigInt)]
    pub subscriber_count: i64,
    #[diesel(sql_type = BigInt)]
    pub recent_subscriber_count: i64,
}

pub struct StickerPackRanking {
    pub rows: Vec<RankedStickerPack>,
    pub has_more: bool,
    pub stats_updated_at: DateTime<Utc>,
}

fn search_pattern(query: &StickerPackDiscoveryQuery) -> Result<Option<String>, AppError> {
    if !(1..=50).contains(&query.limit) {
        return Err(AppError::BadRequest("limit must be between 1 and 50"));
    }
    if query.offset < 0 {
        return Err(AppError::BadRequest("offset must not be negative"));
    }
    let Some(q) = query.q.as_deref().map(str::trim).filter(|q| !q.is_empty()) else {
        return Ok(None);
    };
    if q.chars().count() > 255 {
        return Err(AppError::BadRequest("q must not exceed 255 characters"));
    }
    let mut pattern = String::with_capacity(q.len() + 2);
    pattern.push('%');
    for ch in q.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(ch);
    }
    pattern.push('%');
    Ok(Some(pattern))
}

// A derived aggregate with FILTER keeps both counts in one scan and lets PostgreSQL
// sort and page the result. Diesel's typed DSL does not expose this derived-table
// shape directly. All input, including the sort selector, is bound as parameters.
const DISCOVERY_SQL: &str = r#"
    SELECT pack_id, subscriber_count, recent_subscriber_count
    FROM (
        SELECT p.id AS pack_id,
               count(s.uid) AS subscriber_count,
               count(s.uid) FILTER (
                   WHERE s.subscribed_at >= $2 AND s.subscribed_at <= $3
               ) AS recent_subscriber_count
        FROM sticker_packs p
        LEFT JOIN user_sticker_pack_subscriptions s
            ON s.pack_id = p.id AND s.uid <> p.owner_uid
        WHERE p.visibility = 'public'
          AND EXISTS (SELECT 1 FROM sticker_pack_stickers ps WHERE ps.pack_id = p.id)
          AND ($1::text IS NULL OR p.name ILIKE $1 OR p.description ILIKE $1)
        GROUP BY p.id
    ) ranked
    ORDER BY CASE WHEN $4 THEN recent_subscriber_count ELSE 0 END DESC,
             subscriber_count DESC, pack_id DESC
    LIMIT $5 OFFSET $6
"#;

pub fn discover_packs(
    conn: &mut PgConnection,
    query: &StickerPackDiscoveryQuery,
    as_of: DateTime<Utc>,
) -> Result<StickerPackRanking, AppError> {
    let pattern = search_pattern(query)?;
    let mut rows = diesel::sql_query(DISCOVERY_SQL)
        .bind::<Nullable<Text>, _>(pattern)
        .bind::<Timestamptz, _>(as_of - Duration::days(RECENT_WINDOW_DAYS))
        .bind::<Timestamptz, _>(as_of)
        .bind::<Bool, _>(matches!(query.sort, StickerPackSort::Trending))
        .bind::<BigInt, _>(query.limit + 1)
        .bind::<BigInt, _>(query.offset)
        .load::<RankedStickerPack>(conn)?;
    let has_more = rows.len() > query.limit as usize;
    rows.truncate(query.limit as usize);
    Ok(StickerPackRanking {
        rows,
        has_more,
        stats_updated_at: as_of,
    })
}

#[derive(QueryableByName)]
struct PreviewId {
    #[diesel(sql_type = BigInt)]
    pack_id: i64,
    #[diesel(sql_type = BigInt)]
    sticker_id: i64,
}

pub fn load_preview_stickers(
    conn: &mut PgConnection,
    media_store: &MediaStore,
    pack_ids: &[i64],
) -> QueryResult<HashMap<i64, Vec<StickerPackPreviewSticker>>> {
    if pack_ids.is_empty() {
        return Ok(HashMap::new());
    }
    // LATERAL's per-pack LIMIT uses the existing (pack_id, added_at, sticker_id)
    // index, fetching at most four rows per pack instead of loading entire packs.
    // The typed Diesel DSL does not expose a lateral join.
    let ids = diesel::sql_query(
        r#"
        SELECT requested.pack_id, preview.sticker_id
        FROM unnest($1::bigint[]) AS requested(pack_id)
        CROSS JOIN LATERAL (
            SELECT sticker_id, added_at
            FROM sticker_pack_stickers
            WHERE pack_id = requested.pack_id
            ORDER BY added_at, sticker_id
            LIMIT 4
        ) preview
        ORDER BY requested.pack_id, preview.added_at, preview.sticker_id
        "#,
    )
    .bind::<Array<BigInt>, _>(pack_ids)
    .load::<PreviewId>(conn)?;

    let rows = stickers::table
        .inner_join(media::table)
        .filter(stickers::id.eq_any(ids.iter().map(|row| row.sticker_id)))
        .select((Sticker::as_select(), Media::as_select()))
        .load::<(Sticker, Media)>(conn)?;
    let previews: HashMap<_, _> = rows
        .into_iter()
        .map(|(sticker, media)| {
            (
                sticker.id,
                StickerPackPreviewSticker {
                    id: sticker.id,
                    emoji: sticker.emoji,
                    media: StickerMediaResponse {
                        id: media.id,
                        url: media_store.public_url(&media.storage_key),
                        content_type: media.content_type,
                        size: media.size,
                        width: media.width,
                        height: media.height,
                    },
                },
            )
        })
        .collect();
    let mut result: HashMap<i64, Vec<StickerPackPreviewSticker>> = HashMap::new();
    for row in ids {
        if let Some(preview) = previews.get(&row.sticker_id) {
            result.entry(row.pack_id).or_default().push(preview.clone());
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
