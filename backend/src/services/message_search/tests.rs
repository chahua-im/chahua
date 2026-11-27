use chrono::{TimeZone, Utc};

use std::sync::Arc;

use crate::models::{Message, MessageType, TranscodeStatus};

use super::{
    filter_authoritative_hits_with_counts, normalize_search_text, project_message_document,
    validate_search_query, MessageSearchConfig, MessageSearchMetrics, MessageSearchService,
    SearchHitCandidate, RANKING_RULES, SETUP_TASK_WAIT_TIMEOUT, TASK_WAIT_TIMEOUT,
};

fn message(id: i64, text: Option<&str>) -> Message {
    Message {
        system_kind: None,
        forwarded_from_message_id: None,
        id,
        message: text.map(str::to_owned),
        metadata: None,
        message_type: MessageType::Text,
        reply_to_id: None,
        reply_root_id: None,
        client_generated_id: format!("client-{id}"),
        sender_uid: 7,
        chat_id: 10,
        created_at: Utc
            .timestamp_millis_opt(1_700_000_000_000 + id)
            .single()
            .unwrap(),
        updated_at: None,
        deleted_at: None,
        has_attachments: false,
        has_thread: false,
        has_reactions: false,
        sticker_id: None,
        is_published: true,
        transcode_status: TranscodeStatus::None,
        forwarded_bundle_id: None,
    }
}

#[test]
fn normalization_strips_mentions_and_preserves_cjk_text() {
    assert_eq!(
        normalize_search_text(" @[uid:7] 你好，世界 \n  hello\t@[uid:8] "),
        Some("你好，世界 hello".to_string())
    );
}

#[test]
fn query_validation_rejects_one_character_and_accepts_two_cjk_characters() {
    assert!(validate_search_query("你").is_err());
    assert_eq!(validate_search_query("你好").unwrap(), "你好");
}

#[test]
fn ranking_rules_support_newest_sort_and_relevance_recency_tiebreaker() {
    assert_eq!(RANKING_RULES.first().copied(), Some("sort"));
    assert_eq!(RANKING_RULES.last().copied(), Some("createdAtMillis:desc"));
    assert!(RANKING_RULES.contains(&"words"));
    assert!(RANKING_RULES.contains(&"attributeRank"));
    assert!(RANKING_RULES.contains(&"wordPosition"));
}

#[test]
fn setup_task_timeout_is_longer_than_live_index_timeout() {
    assert!(SETUP_TASK_WAIT_TIMEOUT > TASK_WAIT_TIMEOUT);
}

#[test]
fn service_starts_not_ready_until_index_setup_completes() {
    let service = MessageSearchService::new(
        MessageSearchConfig {
            meili_url: "http://localhost:7700".to_string(),
            meili_master_key: "master-key".to_string(),
            index_uid: "messages_test".to_string(),
        },
        Arc::new(MessageSearchMetrics::new(&prometheus::Registry::new())),
    )
    .unwrap();

    assert!(!service.is_setup_ready());
    service.mark_setup_ready();
    assert!(service.is_setup_ready());
}

#[test]
fn projection_indexes_only_visible_text_messages() {
    let visible = message(1, Some("hello 你好"));
    assert_eq!(
        project_message_document(&visible).unwrap().text,
        "hello 你好"
    );

    let mut deleted = message(2, Some("deleted"));
    deleted.deleted_at = Some(Utc::now());
    assert!(project_message_document(&deleted).is_none());

    let mut unpublished = message(3, Some("draft"));
    unpublished.is_published = false;
    assert!(project_message_document(&unpublished).is_none());

    let mut non_text = message(4, Some("audio"));
    non_text.message_type = MessageType::Audio;
    assert!(project_message_document(&non_text).is_none());

    assert!(project_message_document(&message(5, Some("@[uid:7]"))).is_none());
}

#[test]
fn authoritative_filter_preserves_candidate_order_and_drops_stale_rows() {
    let fresh = message(1, Some("fresh"));
    let wrong_chat = message(2, Some("wrong chat"));
    let mut deleted = message(3, Some("deleted"));
    let edited = {
        let mut msg = message(4, Some("edited"));
        msg.updated_at = Some(
            Utc.timestamp_millis_opt(1_700_000_100_000)
                .single()
                .unwrap(),
        );
        msg
    };
    deleted.deleted_at = Some(Utc::now());

    let rows = vec![fresh.clone(), wrong_chat, deleted, edited.clone()];
    let candidates = vec![
        SearchHitCandidate {
            message_id: edited.id,
            version: 1,
        },
        SearchHitCandidate {
            message_id: fresh.id,
            version: project_message_document(&fresh).unwrap().version,
        },
        SearchHitCandidate {
            message_id: 2,
            version: 1,
        },
        SearchHitCandidate {
            message_id: 3,
            version: 1,
        },
    ];

    let filtered = filter_authoritative_hits_with_counts(10, &candidates, rows).messages;

    assert_eq!(
        filtered
            .iter()
            .map(|message| message.id)
            .collect::<Vec<_>>(),
        vec![1]
    );
}

#[test]
fn authoritative_filter_counts_drop_reasons() {
    let fresh = message(1, Some("fresh"));
    let mut wrong_chat = message(2, Some("wrong chat"));
    wrong_chat.chat_id = 11;
    let mut deleted = message(3, Some("deleted"));
    deleted.deleted_at = Some(Utc::now());
    let edited = {
        let mut msg = message(4, Some("edited"));
        msg.updated_at = Some(
            Utc.timestamp_millis_opt(1_700_000_100_000)
                .single()
                .unwrap(),
        );
        msg
    };

    let rows = vec![fresh.clone(), wrong_chat.clone(), deleted, edited.clone()];
    let candidates = vec![
        SearchHitCandidate {
            message_id: 99,
            version: 1,
        },
        SearchHitCandidate {
            message_id: wrong_chat.id,
            version: project_message_document(&wrong_chat).unwrap().version,
        },
        SearchHitCandidate {
            message_id: 3,
            version: 1,
        },
        SearchHitCandidate {
            message_id: edited.id,
            version: 1,
        },
        SearchHitCandidate {
            message_id: fresh.id,
            version: project_message_document(&fresh).unwrap().version,
        },
    ];

    let result = filter_authoritative_hits_with_counts(10, &candidates, rows);

    assert_eq!(
        result
            .messages
            .iter()
            .map(|message| message.id)
            .collect::<Vec<_>>(),
        vec![fresh.id]
    );
    assert_eq!(result.drops.missing_db_row, 1);
    assert_eq!(result.drops.wrong_chat, 1);
    assert_eq!(result.drops.not_searchable, 1);
    assert_eq!(result.drops.stale_version, 1);
}
