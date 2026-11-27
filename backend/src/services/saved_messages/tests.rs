use super::{
    ensure_message_can_be_saved, saved_message_row_to_response, saved_messages_limit,
    split_saved_messages_page, DEFAULT_SAVED_MESSAGES_LIMIT, MAX_SAVED_MESSAGES_LIMIT,
};
use crate::{
    errors::AppError,
    models::{Message, MessageType, SavedMessage, TranscodeStatus},
};
use chrono::Utc;
use serde_json::json;
fn media_store(base_url: &str) -> crate::services::media::MediaStore {
    crate::services::media::MediaStore::new(
        aws_sdk_s3::Client::from_conf(
            aws_sdk_s3::Config::builder()
                .behavior_version_latest()
                .build(),
        ),
        std::sync::Arc::new(crate::config::MediaConfig {
            bucket: "test".into(),
            attachment_prefix: "attachments".into(),
            base_url: Some(base_url.into()),
            endpoint_url: None,
            upload_proxy_path: None,
            max_attachment_file_size_bytes: 1,
        }),
    )
}

fn message_for_save() -> Message {
    Message {
        system_kind: None,
        forwarded_from_message_id: None,
        id: 10,
        message: Some("hello".to_string()),
        metadata: None,
        message_type: MessageType::Text,
        reply_to_id: None,
        reply_root_id: None,
        client_generated_id: "client-id".to_string(),
        sender_uid: 7,
        chat_id: 100,
        created_at: Utc::now(),
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

fn saved_row() -> SavedMessage {
    SavedMessage {
        id: 500,
        uid: 7,
        original_chat_id: 100,
        original_thread_root_id: None,
        original_message_id: 10,
        original_reply_to_message_id: None,
        original_sender_uid: 7,
        original_created_at: Utc::now(),
        saved_at: Utc::now(),
        snapshot_message: Some("hello".to_string()),
        snapshot_message_type: MessageType::Text,
        snapshot_attachments: json!([]),
        snapshot_sticker: None,
        snapshot_mentions: json!([]),
        snapshot_sender: json!({
            "uid": 7,
            "name": "Alice",
            "avatarUrl": "https://example.com/avatar.jpg",
            "gender": 1
        }),
        snapshot_chat: json!({
            "id": "100",
            "name": "General",
            "avatarUrl": null
        }),
        forwarded_bundle_id: None,
    }
}

#[test]
fn ensure_message_can_be_saved_rejects_deleted_messages() {
    let mut message = message_for_save();
    message.deleted_at = Some(Utc::now());

    let err = ensure_message_can_be_saved(&message).expect_err("deleted message rejected");

    assert!(matches!(
        err,
        AppError::BadRequest("Cannot save deleted message")
    ));
}

#[test]
fn ensure_message_can_be_saved_rejects_unpublished_messages() {
    let mut message = message_for_save();
    message.is_published = false;

    let err = ensure_message_can_be_saved(&message).expect_err("unpublished message rejected");

    assert!(matches!(
        err,
        AppError::BadRequest("Cannot save unpublished message")
    ));
}

#[test]
fn ensure_message_can_be_saved_rejects_system_messages() {
    let mut message = message_for_save();
    message.message_type = MessageType::System;

    let err = ensure_message_can_be_saved(&message).expect_err("system message rejected");

    assert!(matches!(
        err,
        AppError::BadRequest("Cannot save system message")
    ));
}

#[test]
fn ensure_message_can_be_saved_allows_published_non_system_messages() {
    for message_type in [
        MessageType::Text,
        MessageType::Audio,
        MessageType::File,
        MessageType::Sticker,
        MessageType::Invite,
    ] {
        let mut message = message_for_save();
        message.message_type = message_type;

        ensure_message_can_be_saved(&message).expect("message can be saved");
    }
}

#[test]
fn saved_messages_limit_defaults_to_thirty_and_caps_to_max() {
    assert_eq!(saved_messages_limit(None), DEFAULT_SAVED_MESSAGES_LIMIT);
    assert_eq!(saved_messages_limit(Some(500)), MAX_SAVED_MESSAGES_LIMIT);
    assert_eq!(saved_messages_limit(Some(0)), 1);
}

#[test]
fn split_saved_messages_page_has_no_cursor_without_extra_row() {
    let (page, next_cursor) = split_saved_messages_page(vec![30, 20], 2, |id| *id);

    assert_eq!(page, vec![30, 20]);
    assert_eq!(next_cursor, None);
}

#[test]
fn split_saved_messages_page_uses_last_returned_id_when_extra_row_exists() {
    let (page, next_cursor) = split_saved_messages_page(vec![30, 20, 10], 2, |id| *id);

    assert_eq!(page, vec![30, 20]);
    assert_eq!(next_cursor, Some(20));
}
#[test]
fn link_preview_saved_snapshot_is_immutable_and_projects_current_media() {
    let mut source = message_for_save();
    source.metadata = Some(json!({"linkPreviews": [
        {"url":"https://ready.example/", "status":"ready", "title":"Original",
         "image":{"storageKey":"link-previews/image.webp","width":32,"height":24}},
        {"url":"https://pending.example/", "status":"pending", "expiresAt":"2030-01-01T00:00:00Z"}
    ]}));
    let old = saved_row();
    let parts = super::SavedMessageSnapshotParts {
        attachments: Vec::new(),
        sticker: None,
        mentions: Vec::new(),
        sender: serde_json::from_value(old.snapshot_sender.clone()).unwrap(),
        chat: serde_json::from_value(old.snapshot_chat.clone()).unwrap(),
    };
    let captured = super::build_new_saved_message(500, 7, &source, parts).unwrap();
    source.metadata = None;
    source.message = None;
    let mut row = old;
    row.snapshot_attachments = captured.snapshot_attachments;
    let response =
        saved_message_row_to_response(row, true, &media_store("https://new.example")).unwrap();
    let metadata = response.metadata.unwrap();
    assert_eq!(metadata.link_previews.len(), 1);
    assert_eq!(metadata.link_previews[0].title.as_deref(), Some("Original"));
    assert_eq!(
        metadata.link_previews[0].image.as_ref().unwrap().url,
        "https://new.example/link-previews/image.webp"
    );
    assert!(metadata.link_previews[0].expires_at.is_none());
    let legacy =
        saved_message_row_to_response(saved_row(), true, &media_store("https://new.example"))
            .unwrap();
    assert!(legacy.metadata.is_none());
    assert!(legacy.attachments.is_empty());
}

#[test]
fn saved_message_row_to_response_returns_internal_error_for_malformed_snapshot_json() {
    let mut row = saved_row();
    row.snapshot_attachments = json!({"not": "a list"});

    let err = saved_message_row_to_response(row, true, &media_store("https://media.example"))
        .expect_err("malformed JSON returns controlled error");

    assert!(matches!(
        err,
        AppError::Internal("Saved message snapshot is invalid")
    ));
}

#[test]
fn fit_saved_messages_page_truncates_prefix_and_updates_next_cursor() {
    let media = media_store("https://media.example");
    let saved = [500_i64, 400, 300, 200]
        .into_iter()
        .map(|id| {
            let mut row = saved_row();
            row.id = id;
            row.snapshot_message = Some("x".repeat(200));
            saved_message_row_to_response(row, true, &media).unwrap()
        })
        .collect::<Vec<_>>();
    let two_item_frame = super::PAGE_ENVELOPE_RESERVE
        + serde_json::to_vec(&super::ListSavedMessagesResponse {
            saved_messages: saved[..2].to_vec(),
            next_cursor: Some(i64::MAX),
        })
        .unwrap()
        .len()
        + 32;

    let mut response = super::ListSavedMessagesResponse {
        saved_messages: saved,
        next_cursor: None,
    };
    super::fit_saved_messages_page(&mut response, two_item_frame);
    let ids: Vec<i64> = response.saved_messages.iter().map(|m| m.id).collect();
    assert_eq!(ids, vec![500, 400]);
    assert_eq!(response.next_cursor, Some(400));
    assert!(
        super::PAGE_ENVELOPE_RESERVE + serde_json::to_vec(&response).unwrap().len()
            <= two_item_frame
    );
}
