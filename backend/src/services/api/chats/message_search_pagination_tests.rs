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
        assert_cross_chat_sender_filter(&mut conn, &service, &client, &index).await;
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

async fn assert_cross_chat_sender_filter(
    conn: &mut PgConnection,
    service: &MessageSearchService,
    client: &meilisearch_sdk::client::Client,
    index: &meilisearch_sdk::indexes::Index,
) {
    use aws_sdk_s3::config::Region;

    // The sender has no current group membership. Requester access, not sender
    // membership, determines which chats can contribute to cross-chat results.
    conn.batch_execute(
        "INSERT INTO groups(id,name) VALUES (9876998010,'sender-visible'),(9876998011,'sender-hidden');
         INSERT INTO groups(id,name,kind,dm_uid1,dm_uid2) VALUES (9876998012,'sender-dm','dm',42,8001);
         INSERT INTO group_membership(chat_id,uid,archived) VALUES (9876998010,8001,TRUE),(9876998012,8001,FALSE);
         INSERT INTO messages(id,chat_id,sender_uid,message_type,message,client_generated_id,created_at,has_thread)
         VALUES (9007199254950000,9876998010,43,'text','thread root','cross-sender-root','2026-10-01',TRUE);
         INSERT INTO messages(id,chat_id,sender_uid,message_type,message,client_generated_id,created_at,reply_root_id)
         VALUES (9007199254950001,9876998010,42,'text','crosschat sender needle','cross-sender-main','2026-11-02',NULL),
                (9007199254950002,9876998012,42,'text','crosschat sender needle','cross-sender-dm','2026-11-02 01:00Z',NULL),
                (9007199254950003,9876998010,42,'text','crosschat sender needle','cross-sender-reply','2026-11-02 02:00Z',9007199254950000),
                (9007199254950004,9876998010,43,'text','crosschat sender needle','cross-sender-other','2026-11-02 03:00Z',NULL),
                (9007199254950005,9876998011,42,'text','crosschat sender needle','cross-sender-hidden','2026-11-02 04:00Z',NULL),
                (9007199254950006,9876998010,42,'text','crosschat sender needle','cross-sender-outside-date','2026-11-03',NULL),
                (9007199254950007,9876998010,43,'text','crosschat sender needle','cross-sender-stale','2026-11-02 05:00Z',NULL);",
    )
    .unwrap();
    let mut documents = messages::table
        .filter(dsl::chat_id.eq_any([9876998010i64, 9876998011, 9876998012]))
        .select(Message::as_select())
        .load::<Message>(conn)
        .unwrap()
        .iter()
        .filter_map(project_message_document)
        .collect::<Vec<_>>();
    // A wrong indexed sender must also be rejected by database authority checks.
    documents
        .iter_mut()
        .find(|d| d.id == "9007199254950007")
        .unwrap()
        .sender_uid = 42;
    assert!(index
        .add_documents(&documents, Some("id"))
        .await
        .unwrap()
        .wait_for_completion(client, None, None)
        .await
        .unwrap()
        .is_success());

    let metrics = Arc::new(Metrics::new());
    let avatars = Arc::new(AvatarService::new(None, metrics.avatars.clone()));
    let media = MediaStore::new(
        aws_sdk_s3::Client::from_conf(
            aws_sdk_s3::Config::builder()
                .behavior_version_latest()
                .region(Region::new("us-east-1"))
                .build(),
        ),
        Arc::new(crate::config::MediaConfig {
            bucket: "test".into(),
            attachment_prefix: "attachments".into(),
            base_url: None,
            upload_proxy_path: None,
            endpoint_url: None,
            max_attachment_file_size_bytes: 1024,
        }),
    );
    let search = Some(Arc::new(service.clone()));
    let deps = || SearchMessagesDeps {
        media: &media,
        avatars: &avatars,
        metrics: &metrics,
        message_search: &search,
    };
    let request = |sort: &str, sender_uid: i32, cursor: Option<String>| {
        serde_json::from_value::<SearchMessagesQuery>(serde_json::json!({
            "q": "crosschat sender needle", "senderUid": sender_uid,
            "createdFrom": "2026-11-01T00:00:00Z", "createdBefore": "2026-11-03T00:00:00Z",
            "sort": sort, "limit": 1, "cursor": cursor
        }))
        .unwrap()
    };
    for sort in ["newest", "relevance"] {
        let mut cursor = None;
        let mut seen = Vec::new();
        for _ in 0..10 {
            let page =
                search_messages_in_scope(8001, None, request(sort, 42, cursor), conn, deps())
                    .await
                    .unwrap();
            assert!(!page.truncated);
            assert!(page.messages.iter().all(|m| m.message.sender.uid == 42));
            seen.extend(page.messages.into_iter().map(|m| m.message.id));
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
            assert!(matches!(
                search_messages_in_scope(
                    8001,
                    None,
                    request(sort, 43, cursor.clone()),
                    conn,
                    deps()
                )
                .await,
                Err(AppError::BadRequest(_))
            ));
        }
        assert!(cursor.is_none());
        seen.sort_unstable();
        assert_eq!(
            seen,
            vec![9007199254950001, 9007199254950002, 9007199254950003]
        );
    }
    let absent =
        search_messages_in_scope(8001, None, request("newest", 999999, None), conn, deps())
            .await
            .unwrap();
    assert!(absent.messages.is_empty() && absent.next_cursor.is_none());
    for q in [None, Some("  ".to_owned())] {
        let mut params = request("newest", 42, None);
        params.q = q;
        assert!(matches!(
            search_messages_in_scope(8001, None, params, conn, deps()).await,
            Err(AppError::BadRequest("Cross-chat search requires a query"))
        ));
    }
}
