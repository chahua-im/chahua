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
