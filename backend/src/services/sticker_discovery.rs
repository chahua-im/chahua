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
mod tests {
    use super::*;

    fn query(value: serde_json::Value) -> StickerPackDiscoveryQuery {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn search_defaults_and_literal_patterns() {
        let default = query(serde_json::json!({}));
        assert!(matches!(default.sort, StickerPackSort::Trending));
        assert_eq!(default.limit, 20);
        assert_eq!(default.offset, 0);
        assert_eq!(search_pattern(&default).unwrap(), None);
        assert_eq!(
            search_pattern(&query(serde_json::json!({"q": "  \t "}))).unwrap(),
            None
        );
        assert_eq!(
            search_pattern(&query(serde_json::json!({"q": "  猫%_\\  "}))).unwrap(),
            Some("%猫\\%\\_\\\\%".to_owned())
        );
    }

    #[test]
    fn search_validates_characters_and_pagination() {
        assert!(search_pattern(&query(serde_json::json!({"q": "猫".repeat(255)}))).is_ok());
        assert!(search_pattern(&query(serde_json::json!({"q": "猫".repeat(256)}))).is_err());
        for value in [
            serde_json::json!({"limit": 0}),
            serde_json::json!({"limit": 51}),
            serde_json::json!({"offset": -1}),
        ] {
            assert!(search_pattern(&query(value)).is_err());
        }
        assert!(serde_json::from_value::<StickerPackDiscoveryQuery>(
            serde_json::json!({"sort": "popular"})
        )
        .is_err());
    }

    #[test]
    fn discovery_parameters_are_optional_in_openapi_and_http_queries() {
        use utoipa::IntoParams;

        let parameters = StickerPackDiscoveryQuery::into_params(|| None);
        assert_eq!(parameters.len(), 4);
        for parameter in parameters {
            assert!(
                parameter.required == utoipa::openapi::Required::False,
                "{} must be optional",
                parameter.name
            );
        }
        let uri = "/stickers/packs".parse().unwrap();
        let axum::extract::Query(default) =
            axum::extract::Query::<StickerPackDiscoveryQuery>::try_from_uri(&uri).unwrap();
        assert_eq!(default.limit, 20);
        assert_eq!(default.offset, 0);
        assert!(matches!(default.sort, StickerPackSort::Trending));
        for query in ["sort=popular", "limit=abc", "offset=1.5"] {
            let uri = format!("/stickers/packs?{query}").parse().unwrap();
            assert!(axum::extract::Query::<StickerPackDiscoveryQuery>::try_from_uri(&uri).is_err());
        }
    }

    #[test]
    fn previews_are_limited_per_pack_and_preserve_shared_stickers_and_order() {
        use diesel::connection::SimpleConnection;
        use std::sync::Arc;

        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.batch_execute(
            "CREATE TEMP TABLE sticker_pack_stickers (LIKE public.sticker_pack_stickers INCLUDING ALL);
             CREATE TEMP TABLE stickers (LIKE public.stickers INCLUDING ALL);
             CREATE TEMP TABLE media (LIKE public.media INCLUDING ALL);
             INSERT INTO media (id, content_type, storage_key, size, purpose, created_at)
                 SELECT n, 'image/webp', 'stickers/' || n || '.webp', 100, 'sticker', '2026-01-01'::timestamptz
                 FROM generate_series(1, 8) n;
             INSERT INTO stickers (id, media_id, emoji)
                 SELECT n, n, '🙂' FROM generate_series(1, 8) n;
             INSERT INTO sticker_pack_stickers (pack_id, sticker_id, added_at) VALUES
                 (10, 6, '2026-01-01'), (10, 5, '2026-01-01'),
                 (10, 4, '2026-01-01'), (10, 3, '2026-01-01'),
                 (10, 2, '2026-01-01'), (10, 1, '2026-01-02'),
                 (20, 3, '2026-01-01'), (20, 8, '2025-12-31');",
        )
        .unwrap();
        let store = MediaStore::new(
            aws_sdk_s3::Client::from_conf(
                aws_sdk_s3::Config::builder()
                    .behavior_version_latest()
                    .build(),
            ),
            Arc::new(crate::config::MediaConfig {
                bucket: "test-media".to_owned(),
                attachment_prefix: "attachments".to_owned(),
                base_url: Some("https://media.invalid".to_owned()),
                endpoint_url: None,
                upload_proxy_path: None,
                max_attachment_file_size_bytes: 1,
            }),
        );
        let previews = load_preview_stickers(&mut conn, &store, &[10, 20, 30]).unwrap();
        assert_eq!(
            previews[&10].iter().map(|p| p.id).collect::<Vec<_>>(),
            vec![2, 3, 4, 5]
        );
        assert_eq!(
            previews[&20].iter().map(|p| p.id).collect::<Vec<_>>(),
            vec![8, 3]
        );
        assert!(!previews.contains_key(&30));
        assert_eq!(
            previews[&10][0].media.url,
            "https://media.invalid/stickers/2.webp"
        );
        assert!(load_preview_stickers(&mut conn, &store, &[])
            .unwrap()
            .is_empty());
    }
}
