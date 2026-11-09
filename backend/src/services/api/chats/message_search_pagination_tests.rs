use super::*;
use crate::services::message_search::{project_message_document, MessageSearchConfig};
use diesel::connection::SimpleConnection;
use futures::FutureExt;

/// Opt-in integration test: uses an isolated database and a uniquely named Meilisearch index.
#[tokio::test]
async fn keyword_cursor_browses_all_hits_and_advances_past_stale_batches() {
    let (Ok(database), Ok(url), Ok(key)) = (
        std::env::var("WETTY_TEST_DATABASE_URL"),
        std::env::var("WETTY_TEST_MEILI_URL"),
        std::env::var("WETTY_TEST_MEILI_KEY"),
    ) else {
        return;
    };
    let mut conn = PgConnection::establish(&database).unwrap();
    conn.begin_test_transaction().unwrap();
    conn.batch_execute("INSERT INTO groups(id,name) VALUES (9876998000,'keyword-cursor');
        INSERT INTO group_membership(chat_id,uid) VALUES (9876998000,8001);
        INSERT INTO messages(id,chat_id,sender_uid,message_type,message,client_generated_id,created_at)
        SELECT 9007199254900000+n,9876998000,42,'text','cursor search needle','keyword-cursor-'||n,
               '2026-11-01'::timestamptz+(n%3)*interval '1 microsecond'
        FROM generate_series(1,1205) n;").unwrap();
    let rows = messages::table
        .filter(dsl::chat_id.eq(9876998000i64))
        .order((dsl::created_at.desc(), dsl::id.desc()))
        .select(Message::as_select())
        .load::<Message>(&mut conn)
        .unwrap();
    let documents = rows
        .iter()
        .map(|m| project_message_document(m).unwrap())
        .collect::<Vec<_>>();
    let index_uid = format!(
        "cursor_test_{}_{}",
        std::process::id(),
        Utc::now().timestamp_micros()
    );
    let metrics = Arc::new(MessageSearchMetrics::new(&prometheus::Registry::new()));
    let service = MessageSearchService::new(
        MessageSearchConfig {
            meili_url: url.clone(),
            meili_master_key: key.clone(),
            index_uid: index_uid.clone(),
        },
        metrics.clone(),
    )
    .unwrap();
    let client = meilisearch_sdk::client::Client::new(url, Some(key)).unwrap();
    let index = client.index(&index_uid);
    // Always remove our test index, including when an assertion fails.
    let result = std::panic::AssertUnwindSafe(async {
        service.ensure_ready().await.unwrap();
        let task = index.add_documents(&documents, Some("id")).await.unwrap();
        assert!(task
            .wait_for_completion(&client, None, None)
            .await
            .unwrap()
            .is_success());
        let filters = MessageSearchFilters {
            range: MessageSearchRange::All,
            sender_uid: None,
            created_from: None,
            created_before: None,
        };
        // A legacy document would sort last and then disappear behind a cursor
        // predicate. Reject the index until it is backfilled, rather than lose it.
        let legacy = serde_json::json!({"id":"legacy", "messageId":"123", "chatId":"9876998000",
            "text":"cursor search needle", "version":1, "createdAtMillis":0});
        let task = index.add_documents(&[legacy], Some("id")).await.unwrap();
        assert!(task
            .wait_for_completion(&client, None, None)
            .await
            .unwrap()
            .is_success());
        assert!(load_keyword_messages(
            &mut conn,
            8001,
            &[9876998000],
            KeywordSearch {
                query: "search needle",
                filters,
                sort: MessageSearchSort::Newest,
                limit: 20,
                continuation: None,
            },
            &service,
            &metrics
        )
        .await
        .is_err());
        let task = index.delete_document("legacy").await.unwrap();
        assert!(task
            .wait_for_completion(&client, None, None)
            .await
            .unwrap()
            .is_success());
        let mut continuation = None;
        let mut seen = Vec::new();
        for _ in 0..50 {
            let page = load_keyword_messages(
                &mut conn,
                8001,
                &[9876998000],
                KeywordSearch {
                    query: "search needle",
                    filters,
                    sort: MessageSearchSort::Newest,
                    limit: 37,
                    continuation,
                },
                &service,
                &metrics,
            )
            .await
            .unwrap();
            assert!(!page.truncated);
            seen.extend(page.messages.iter().map(|m| m.id));
            continuation = page.continuation;
            if continuation.is_none() {
                break;
            }
        }
        assert!(continuation.is_none());
        assert_eq!(seen, rows.iter().map(|m| m.id).collect::<Vec<_>>());

        // Relevance remains bounded, including a page size that does not divide 1,000.
        let mut continuation = None;
        let mut count = 0;
        let mut truncated = false;
        for _ in 0..35 {
            let page = load_keyword_messages(
                &mut conn,
                8001,
                &[9876998000],
                KeywordSearch {
                    query: "search needle",
                    filters,
                    sort: MessageSearchSort::Relevance,
                    limit: 37,
                    continuation,
                },
                &service,
                &metrics,
            )
            .await
            .unwrap();
            count += page.messages.len();
            continuation = page.continuation;
            truncated = page.truncated;
            if continuation.is_none() {
                break;
            }
        }
        assert_eq!(count, RELEVANCE_RESULT_WINDOW);
        assert!(truncated);
        assert!(continuation.is_none());

        // More invalid candidates than a single request's budget: return a usable
        // cursor even for an empty page, then continue into the live history.
        let stale = (0..600)
            .map(|n| {
                let mut message = rows[0].clone();
                message.id = 9007199254990000 + n;
                message.created_at += chrono::Duration::days(1);
                project_message_document(&message).unwrap()
            })
            .collect::<Vec<_>>();
        let task = index.add_documents(&stale, Some("id")).await.unwrap();
        assert!(task
            .wait_for_completion(&client, None, None)
            .await
            .unwrap()
            .is_success());
        let page = load_keyword_messages(
            &mut conn,
            8001,
            &[9876998000],
            KeywordSearch {
                query: "search needle",
                filters,
                sort: MessageSearchSort::Newest,
                limit: 20,
                continuation: None,
            },
            &service,
            &metrics,
        )
        .await
        .unwrap();
        assert!(page.messages.is_empty());
        assert!(page.continuation.is_some());
        assert!(!page.truncated);
        let next = load_keyword_messages(
            &mut conn,
            8001,
            &[9876998000],
            KeywordSearch {
                query: "search needle",
                filters,
                sort: MessageSearchSort::Newest,
                limit: 20,
                continuation: page.continuation,
            },
            &service,
            &metrics,
        )
        .await
        .unwrap();
        assert_eq!(
            next.messages.iter().map(|m| m.id).collect::<Vec<_>>(),
            rows[..20].iter().map(|m| m.id).collect::<Vec<_>>()
        );
        // Revalidate membership when continuing an already-issued cursor.
        conn.batch_execute("DELETE FROM group_membership WHERE uid=8001")
            .unwrap();
        let revoked = load_keyword_messages(
            &mut conn,
            8001,
            &[9876998000],
            KeywordSearch {
                query: "search needle",
                filters,
                sort: MessageSearchSort::Newest,
                limit: 20,
                continuation: next.continuation,
            },
            &service,
            &metrics,
        )
        .await
        .unwrap();
        assert!(revoked.messages.is_empty());
    })
    .catch_unwind()
    .await;
    let task = client.delete_index(&index_uid).await.unwrap();
    assert!(task
        .wait_for_completion(&client, None, None)
        .await
        .unwrap()
        .is_success());
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}
