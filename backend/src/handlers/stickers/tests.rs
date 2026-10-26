use super::*;
use diesel::connection::{InstrumentationEvent, SimpleConnection};
use std::sync::{Arc, Mutex};

#[test]
fn sticker_summaries_reuse_preloaded_previews_without_querying_media() {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    conn.batch_execute(
        "CREATE TEMP TABLE sticker_pack_stickers (LIKE public.sticker_pack_stickers INCLUDING ALL);
         CREATE TEMP TABLE user_sticker_pack_subscriptions (LIKE public.user_sticker_pack_subscriptions INCLUDING ALL);
         INSERT INTO sticker_pack_stickers (pack_id, sticker_id) VALUES
             (20, 201), (20, 202), (10, 101);
         INSERT INTO user_sticker_pack_subscriptions (uid, pack_id) VALUES (99, 20);",
    )
    .unwrap();

    let packs = [20, 10, 30]
        .into_iter()
        .map(|id| StickerPack {
            id,
            owner_uid: 1,
            name: format!("pack {id}"),
            description: None,
            visibility: crate::models::StickerPackVisibility::Public,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        })
        .collect();
    let previews: HashMap<_, _> = [(20, 201), (10, 101)]
        .into_iter()
        .map(|(pack_id, sticker_id)| {
            (
                pack_id,
                StickerPackPreviewSticker {
                    id: sticker_id,
                    emoji: "🙂".to_owned(),
                    media: StickerMediaResponse {
                        id: sticker_id + 1000,
                        url: format!("https://media.invalid/{sticker_id}.webp"),
                        content_type: "image/webp".to_owned(),
                        size: 123,
                        width: Some(64),
                        height: Some(64),
                    },
                },
            )
        })
        .collect();
    let expected_preview = serde_json::to_value(&previews[&20]).unwrap();
    let queries = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&queries);
    conn.set_instrumentation(move |event: InstrumentationEvent<'_>| {
        if let InstrumentationEvent::StartQuery { query, .. } = event {
            recorded.lock().unwrap().push(query.to_string());
        }
    });

    let summaries = build_pack_summaries_with_previews(&mut conn, 99, packs, previews).unwrap();
    assert_eq!(
        summaries.iter().map(|pack| pack.id).collect::<Vec<_>>(),
        [20, 10, 30]
    );
    assert_eq!(
        summaries
            .iter()
            .map(|pack| pack.sticker_count)
            .collect::<Vec<_>>(),
        [2, 1, 0]
    );
    assert!(summaries[0].is_subscribed);
    assert!(!summaries[1].is_subscribed);
    assert_eq!(
        serde_json::to_value(&summaries[0].preview_sticker).unwrap(),
        expected_preview
    );
    assert_eq!(summaries[1].preview_sticker.as_ref().unwrap().id, 101);
    assert!(summaries[2].preview_sticker.is_none());
    let queries = queries.lock().unwrap();
    assert!(!queries.is_empty());
    assert!(
        queries
            .iter()
            .all(|sql| !sql.contains("\"stickers\"") && !sql.contains("\"media\"")),
        "summary assembly queried preview media: {queries:?}"
    );
}
