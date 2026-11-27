use super::{
    build_forwarded_bundle_ref_snapshot, build_forwarded_message_snapshot,
    build_forwarded_preview_items, build_forwarded_preview_payload, build_message_preview,
    build_push_preview_bundle, collect_forwarded_bundle_item_uids, extract_mention_uids,
    forwarded_reply_response, forwarded_sticker_response, message_is_visible_in_thread_scope,
    parse_attachment_ids, redact_deleted_message_response, render_mentions_as_text,
    sticker_preview_text, validate_message, validate_message_shape, ForwardedBundlePayloadItem,
    ForwardedMessageSnapshot, ForwardedMessagesPreviewSnapshot, ForwardedReplyResponse,
    ForwardedReplySnapshot, ForwardedStickerSnapshot, MentionInfo, MessagePreview,
    MessagePreviewAttachment, MessagePreviewInput, MessageResponse, MessageSendAuthorizationError,
    MessageStickerResponse, PreparedMessageSend, ReactionSummary, StickerMediaResponse,
};
use crate::{
    config::MediaConfig,
    dto::{attachments::AttachmentResponse, users::User},
    errors::AppError,
    models::{Attachment, GroupKind, Message, MessageType, TranscodeStatus},
    services::{media::MediaStore, social::DmSendAuthorizationError},
};
use axum::{http::StatusCode, response::IntoResponse};
use chrono::{TimeZone, Utc};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

#[test]
fn reply_validation_accepts_recalled_targets_in_the_same_conversation() {
    use diesel::{connection::SimpleConnection, Connection};

    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return;
    };
    let mut conn = diesel::PgConnection::establish(&url).expect("connect to test database");
    conn.batch_execute(
            "CREATE TEMP TABLE messages (
                 id bigint PRIMARY KEY, chat_id bigint NOT NULL, reply_root_id bigint,
                 system_kind system_message_kind, is_published boolean NOT NULL, deleted_at timestamptz
             );
             INSERT INTO messages VALUES
                 (10, 1, NULL, NULL, TRUE, now()),
                 (11, 1, 10, NULL, TRUE, now()),
                 (12, 1, NULL, NULL, FALSE, NULL),
                 (13, 1, NULL, 'member_joined', TRUE, NULL);",
        )
        .unwrap();

    for (thread_id, target) in [(None, 10), (Some(10), 10), (Some(10), 11)] {
        super::validate_reply_target(&mut conn, 1, thread_id, target).unwrap();
    }
    for (chat_id, thread_id, target) in [
        (1, None, 11),
        (1, Some(20), 11),
        (2, None, 10),
        (1, None, 12),
    ] {
        assert!(matches!(
            super::validate_reply_target(&mut conn, chat_id, thread_id, target),
            Err(AppError::NotFound(_))
        ));
    }
    assert!(matches!(
        super::validate_reply_target(&mut conn, 1, None, 13),
        Err(AppError::BadRequest(_))
    ));
}

#[test]
fn reaction_details_bound_samples_preserve_counts_and_own_flags() {
    use diesel::{connection::SimpleConnection, Connection};

    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return;
    };
    let mut conn = diesel::PgConnection::establish(&url).expect("connect to test database");
    conn.batch_execute(
        "CREATE TEMP TABLE message_reactions (
                 message_id bigint NOT NULL, user_uid integer NOT NULL,
                 emoji varchar(32) NOT NULL, created_at timestamptz NOT NULL,
                 PRIMARY KEY (message_id, user_uid, emoji)
             );
             INSERT INTO message_reactions (message_id, user_uid, emoji, created_at)
             SELECT 1, n, 'alpha',
                    '2026-01-01 00:00:00+00'::timestamptz + ((n - 1) / 2) * interval '1 second'
             FROM generate_series(100, 1, -1) n;
             INSERT INTO message_reactions (message_id, user_uid, emoji, created_at) VALUES
                 (1, 99, 'beta', '2026-01-01 00:00:03+00'),
                 (1, 7, 'beta', '2026-01-01 00:00:01+00'),
                 (1, 3, 'beta', '2026-01-01 00:00:01+00'),
                 (2, 50, 'alpha', '2026-01-01 00:00:00+00'),
                 (3, 99, 'ignored', '2026-01-01 00:00:00+00');",
    )
    .unwrap();

    let details = super::load_reaction_details(&mut conn, &[1, 2], 99);
    assert_eq!(details.len(), 3);
    assert_eq!(
        (
            details[0].message_id,
            details[0].emoji.as_str(),
            details[0].count
        ),
        (1, "alpha", 100)
    );
    assert!(details[0].reacted_by_me);
    assert_eq!(details[0].reactor_uids, [1, 2, 3, 4, 5]);
    assert_eq!(
        (
            details[1].message_id,
            details[1].emoji.as_str(),
            details[1].count
        ),
        (1, "beta", 3)
    );
    assert!(details[1].reacted_by_me);
    assert_eq!(details[1].reactor_uids, [3, 7, 99]);
    assert_eq!(
        (
            details[2].message_id,
            details[2].emoji.as_str(),
            details[2].count
        ),
        (2, "alpha", 1)
    );
    assert!(!details[2].reacted_by_me);
    assert_eq!(details[2].reactor_uids, [50]);
    assert!(super::load_reaction_details(&mut conn, &[], 99).is_empty());
}

fn attachment(kind: &str) -> Attachment {
    Attachment {
        id: 1,
        message_id: None,
        uploader_uid: Some(7),
        file_name: "file.bin".to_string(),
        kind: kind.to_string(),
        external_reference: "attachments/file.bin".to_string(),
        size: 10,
        created_at: Utc
            .timestamp_millis_opt(1_700_000_000_000)
            .single()
            .unwrap(),
        deleted_at: None,
        width: None,
        height: None,
        order: 0,
    }
}

#[test]
fn validate_message_enforces_type_composition_rules() {
    // Text: needs content, and only visual attachments.
    assert!(validate_message(&MessageType::Text, Some("hi"), None, &[]).is_ok());
    assert!(validate_message(&MessageType::Text, Some("  "), None, &[]).is_err());
    assert!(validate_message(&MessageType::Text, None, None, &[attachment("image/png")]).is_ok());
    assert!(validate_message(
        &MessageType::Text,
        Some("hi"),
        None,
        &[attachment("application/pdf")]
    )
    .is_err());

    // File: needs at least one attachment and cannot carry a caption.
    assert!(validate_message(&MessageType::File, None, None, &[attachment("image/png")]).is_ok());
    assert!(validate_message(
        &MessageType::File,
        Some("caption"),
        None,
        &[attachment("application/pdf")]
    )
    .is_err());
    assert!(validate_message(&MessageType::File, None, None, &[]).is_err());

    // Audio: exactly one audio attachment and no text.
    assert!(validate_message(&MessageType::Audio, None, None, &[attachment("audio/ogg")]).is_ok());
    assert!(validate_message(
        &MessageType::Audio,
        Some("caption"),
        None,
        &[attachment("audio/ogg")]
    )
    .is_err());

    // Sticker: requires an ID, rejects text and attachments.
    assert!(validate_message(&MessageType::Sticker, None, Some(5), &[]).is_ok());
    assert!(validate_message(&MessageType::Sticker, None, None, &[]).is_err());
    assert!(validate_message(&MessageType::Sticker, Some("hi"), Some(5), &[]).is_err());
    assert!(validate_message(
        &MessageType::Sticker,
        None,
        Some(5),
        &[attachment("image/png")]
    )
    .is_err());

    // A sticker ID never belongs on another message type.
    assert!(validate_message(&MessageType::Text, Some("hi"), Some(5), &[]).is_err());
}

/// The pre-insert gate keeps a malformed sticker payload out of the database,
/// so it cannot surface as a foreign-key 500 or be accepted by an idempotent
/// retry that never reaches the row-aware rules.
#[test]
fn validate_message_shape_rejects_sticker_payloads_without_loading_rows() {
    assert!(validate_message_shape(&MessageType::Sticker, None, Some(5)).is_ok());
    assert!(validate_message_shape(&MessageType::Sticker, Some("caption"), Some(5)).is_err());
    assert!(validate_message_shape(&MessageType::Sticker, None, None).is_err());
    assert!(validate_message_shape(&MessageType::Text, Some("hi"), Some(5)).is_err());

    // Row-dependent rules stay out of the pre-insert gate.
    assert!(validate_message_shape(&MessageType::Text, None, None).is_ok());
    assert!(validate_message_shape(&MessageType::File, None, None).is_ok());
}

fn message(id: i64, patch: impl FnOnce(&mut Message)) -> Message {
    let mut message = Message {
        system_kind: None,
        forwarded_from_message_id: None,
        id,
        message: Some(format!("message {id}")),
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
    };
    patch(&mut message);
    message
}

fn sender() -> User {
    User {
        uid: 7,
        avatar_url: None,
        name: Some("Alice".to_string()),
        gender: 0,
        user_group: None,
    }
}

fn attachment_response() -> AttachmentResponse {
    AttachmentResponse {
        id: 1,
        url: "https://example.com/secret.png".to_string(),
        kind: "image/png".to_string(),
        size: 123,
        file_name: "secret.png".to_string(),
        width: Some(100),
        height: Some(100),
    }
}

fn sticker_response() -> MessageStickerResponse {
    MessageStickerResponse {
        id: 1,
        emoji: "🙂".to_string(),
        name: Some("smile".to_string()),
        description: None,
        created_at: Utc::now(),
        is_favorited: false,
        media: StickerMediaResponse {
            id: 2,
            url: "https://example.com/sticker.webp".to_string(),
            content_type: "image/webp".to_string(),
            size: 456,
            width: Some(128),
            height: Some(128),
        },
    }
}

fn forwarded_sticker_snapshot() -> ForwardedStickerSnapshot {
    ForwardedStickerSnapshot {
        id: 1,
        media_id: 2,
        media_storage_key: "stickers/private-smile.webp".to_string(),
        emoji: "🙂".to_string(),
        name: Some("smile".to_string()),
        description: None,
        created_at: Utc::now(),
        content_type: "image/webp".to_string(),
        size: 456,
        width: Some(128),
        height: Some(128),
    }
}

fn media_store(base_url: &str) -> MediaStore {
    MediaStore::new(
        aws_sdk_s3::Client::from_conf(
            aws_sdk_s3::Config::builder()
                .behavior_version_latest()
                .build(),
        ),
        Arc::new(MediaConfig {
            bucket: "media-bucket".to_string(),
            attachment_prefix: "attachments".to_string(),
            base_url: Some(base_url.to_string()),
            endpoint_url: None,
            upload_proxy_path: None,
            max_attachment_file_size_bytes: 1,
        }),
    )
}

#[test]
fn forwarded_sticker_snapshot_keeps_durable_media_data() {
    let source = message(10, |message| {
        message.message_type = MessageType::Sticker;
        message.message = None;
        message.sticker_id = Some(1);
    });
    let snapshot = build_forwarded_message_snapshot(
        &source,
        vec![crate::dto::attachments::AttachmentSnapshot {
            id: 3,
            external_reference: "attachments/private.png".to_string(),
            kind: "image/png".to_string(),
            size: 42,
            file_name: "private.png".to_string(),
            width: None,
            height: None,
        }],
        &HashMap::from([(1, forwarded_sticker_snapshot())]),
        &HashSet::from([10]),
    )
    .expect("sticker snapshot");

    let value = serde_json::to_value(&snapshot).expect("serialize durable sticker snapshot");
    assert_eq!(
        value["sticker"]["mediaStorageKey"],
        "stickers/private-smile.webp"
    );
    assert!(value["sticker"].get("url").is_none());
    assert!(value["sticker"].get("isFavorited").is_none());
    assert!(value["sticker"].get("media").is_none());
    assert!(value["reply"].is_null());
    assert_eq!(
        value["attachments"][0]["externalReference"],
        "attachments/private.png"
    );
}

#[test]
fn link_preview_forward_snapshot_is_immutable_and_projects_current_media() {
    let mut source = message(10, |message| {
        message.metadata = Some(json!({"linkPreviews": [
            {"url":"https://ready.example/", "status":"ready", "title":"Original",
             "image":{"storageKey":"link-previews/image.webp","width":32,"height":24}},
            {"url":"https://pending.example/", "status":"pending", "expiresAt":"2030-01-01T00:00:00Z"}
        ]}));
    });
    let snapshot = build_forwarded_message_snapshot(
        &source,
        Vec::new(),
        &HashMap::new(),
        &HashSet::from([10]),
    )
    .unwrap();
    source.metadata = None;
    source.message = None;
    let mut old = serde_json::to_value(&snapshot).unwrap();
    old.as_object_mut().unwrap().remove("metadata");
    let legacy: ForwardedMessageSnapshot = serde_json::from_value(old).unwrap();
    assert!(legacy.metadata.is_none());
    let item = ForwardedBundlePayloadItem::MessageSnapshot { snapshot };
    let response = super::forwarded_bundle_item_response(
        &media_store("https://new.example"),
        &item,
        &HashMap::new(),
        &HashSet::new(),
        &HashMap::new(),
        &HashMap::new(),
    );
    let metadata = response.metadata.unwrap();
    assert_eq!(metadata.link_previews.len(), 1);
    assert_eq!(metadata.link_previews[0].title.as_deref(), Some("Original"));
    assert_eq!(
        metadata.link_previews[0].image.as_ref().unwrap().url,
        "https://new.example/link-previews/image.webp"
    );
    assert!(metadata.link_previews[0].expires_at.is_none());
}

#[test]
fn forwarded_sticker_response_uses_request_user_state_and_current_media_config() {
    let media = media_store("https://current-media.example");
    let snapshot = forwarded_sticker_snapshot();

    let favorited = forwarded_sticker_response(&media, &snapshot, true);
    let not_favorited = forwarded_sticker_response(&media, &snapshot, false);

    assert_eq!(
        favorited.media.url,
        "https://current-media.example/stickers/private-smile.webp"
    );
    assert!(favorited.is_favorited);
    assert!(!not_favorited.is_favorited);
}

#[test]
fn forwarded_reply_to_nonselected_source_is_redacted() {
    let source = message(1, |message| message.reply_to_id = Some(99));
    let item = ForwardedBundlePayloadItem::MessageSnapshot {
        snapshot: build_forwarded_message_snapshot(
            &source,
            Vec::new(),
            &HashMap::new(),
            &HashSet::from([1]),
        )
        .expect("snapshot"),
    };

    let serialized = serde_json::to_string(&item).expect("serialize bundle item");
    assert!(!serialized.contains("\"99\""));
    assert_eq!(
        serde_json::to_value(&item).expect("item value")["reply"],
        json!({ "kind": "redacted" })
    );
    let round_trip: ForwardedBundlePayloadItem =
        serde_json::from_str(&serialized).expect("deserialize bundle item");
    assert!(matches!(
        round_trip,
        ForwardedBundlePayloadItem::MessageSnapshot {
            snapshot: ForwardedMessageSnapshot {
                reply: Some(ForwardedReplySnapshot::Redacted),
                ..
            }
        }
    ));
}

#[test]
fn forwarded_bundle_ref_reply_is_limited_to_the_immediate_selection() {
    let source = message(1, |message| {
        message.message_type = MessageType::Forwarded;
        message.forwarded_bundle_id = Some(100);
        message.reply_to_id = Some(2);
    });
    let previews = HashMap::from([(
        100,
        ForwardedMessagesPreviewSnapshot {
            total: 1,
            contains_forwarded_messages: false,
            messages: Vec::new(),
        },
    )]);

    let internal = build_forwarded_bundle_ref_snapshot(&source, &previews, &HashSet::from([1, 2]))
        .expect("forwarded bundle ref");
    let redacted = build_forwarded_bundle_ref_snapshot(&source, &previews, &HashSet::from([1]))
        .expect("forwarded bundle ref");

    assert!(matches!(
        internal.reply,
        Some(ForwardedReplySnapshot::Internal {
            original_message_id: 2
        })
    ));
    assert!(matches!(
        redacted.reply,
        Some(ForwardedReplySnapshot::Redacted)
    ));
}

#[test]
fn forwarded_bundle_ref_rejects_missing_source_bundle_preview() {
    let source = message(1, |message| {
        message.message_type = MessageType::Forwarded;
        message.forwarded_bundle_id = Some(100);
    });

    assert!(matches!(
        build_forwarded_bundle_ref_snapshot(&source, &HashMap::new(), &HashSet::from([1])),
        Err(AppError::BadRequest("Forwarded source bundle not found"))
    ));
}

#[test]
fn forwarded_internal_reply_preview_comes_from_selected_snapshot() {
    let source = ForwardedBundlePayloadItem::MessageSnapshot {
        snapshot: ForwardedMessageSnapshot {
            original_message_id: 1,
            original_chat_id: 20,
            message: Some("source".to_string()),
            message_type: MessageType::Text,
            sender_uid: 7,
            original_created_at: Utc::now(),
            sticker: None,
            reply: Some(ForwardedReplySnapshot::Internal {
                original_message_id: 2,
            }),
            attachments: Vec::new(),
            metadata: None,
            mention_uids: Vec::new(),
        },
    };
    let target = ForwardedBundlePayloadItem::MessageSnapshot {
        snapshot: ForwardedMessageSnapshot {
            original_message_id: 2,
            original_chat_id: 20,
            message: Some("captured target".to_string()),
            message_type: MessageType::Text,
            sender_uid: 8,
            original_created_at: Utc::now(),
            sticker: None,
            reply: None,
            attachments: Vec::new(),
            metadata: None,
            mention_uids: Vec::new(),
        },
    };
    let items = [source, target];
    let items_by_original_message_id = items
        .iter()
        .map(|item| (super::forwarded_bundle_item_original_message_id(item), item))
        .collect();
    let reply = match &items[0] {
        ForwardedBundlePayloadItem::MessageSnapshot { snapshot } => forwarded_reply_response(
            snapshot.reply.as_ref(),
            &items_by_original_message_id,
            &HashMap::new(),
            &HashMap::new(),
        ),
        ForwardedBundlePayloadItem::ForwardedBundleRef { .. } => unreachable!(),
    };

    assert!(matches!(
        reply,
        Some(ForwardedReplyResponse::Internal {
            original_message_id: 2,
            preview,
        }) if preview.message.as_deref() == Some("captured target")
    ));
}

#[test]
fn forwarded_preview_items_are_compact_and_limited() {
    let item = |id, sender_uid, mention_uids, reply| ForwardedBundlePayloadItem::MessageSnapshot {
        snapshot: ForwardedMessageSnapshot {
            original_message_id: id,
            original_chat_id: 20,
            message: Some(format!("message {id}")),
            message_type: MessageType::Text,
            sender_uid,
            original_created_at: Utc::now(),
            sticker: Some(forwarded_sticker_snapshot()),
            reply,
            attachments: vec![crate::dto::attachments::AttachmentSnapshot {
                id: id * 10,
                external_reference: "private/storage-key".to_string(),
                kind: "image/png".to_string(),
                size: 42,
                file_name: "private.png".to_string(),
                width: None,
                height: None,
            }],
            metadata: None,
            mention_uids,
        },
    };
    let items = vec![
        item(
            1,
            6,
            vec![7],
            Some(ForwardedReplySnapshot::Internal {
                original_message_id: 4,
            }),
        ),
        item(2, 10, Vec::new(), None),
        item(3, 11, Vec::new(), None),
        item(4, 12, Vec::new(), None),
    ];

    let preview_items = build_forwarded_preview_items(&items);
    let preview = build_forwarded_preview_payload(&preview_items).expect("preview serialization");
    assert_eq!(
        preview.as_array().map(Vec::len),
        Some(super::FORWARDED_PREVIEW_LIMIT)
    );
    assert_eq!(preview[0]["mentionUids"], json!([7]));
    assert_eq!(preview[0]["attachments"], json!([{ "kind": "image/png" }]));
    assert_eq!(preview[0]["sticker"], json!({ "emoji": "🙂" }));
    assert!(preview[0].get("reply").is_none());
    assert!(!preview.to_string().contains("private/storage-key"));
    assert!(!preview.to_string().contains("private.png"));

    let mut uids = HashSet::new();
    collect_forwarded_bundle_item_uids(&items, &mut uids);
    assert!(uids.is_superset(&HashSet::from([6, 7, 10, 11, 12])));
}

#[test]
fn parse_attachment_ids_preserves_request_order() {
    let raw = vec!["30".to_string(), "10".to_string(), "20".to_string()];

    assert_eq!(parse_attachment_ids(&raw).unwrap(), vec![30, 10, 20]);
}

#[test]
fn sticker_preview_text_includes_emoji_when_available() {
    assert_eq!(sticker_preview_text(Some("🙂")), "[Sticker] 🙂");
    assert_eq!(sticker_preview_text(None), "[Sticker]");
}

#[test]
fn render_mentions_as_text_preserves_cjk_text() {
    let text = "@[uid:7] 你好，世界";
    let mentions = vec![MentionInfo {
        uid: 7,
        username: Some("Alice".to_string()),
        avatar_url: None,
        gender: 0,
        user_group: None,
    }];

    assert_eq!(
        render_mentions_as_text(text, &mentions),
        "@Alice 你好，世界"
    );
}

#[test]
fn extract_mention_uids_keeps_scanning_after_cjk_text() {
    let text = "@[uid:7] 你好 @[uid:8]";
    assert_eq!(extract_mention_uids(text), vec![7, 8]);
}

#[test]
fn render_mentions_as_text_leaves_invalid_tokens_untouched() {
    let text = "@[user:7] 你好";
    let mentions = vec![MentionInfo {
        uid: 7,
        username: Some("Alice".to_string()),
        avatar_url: None,
        gender: 0,
        user_group: None,
    }];

    assert_eq!(render_mentions_as_text(text, &mentions), text);
    assert!(extract_mention_uids(text).is_empty());
}

#[test]
fn idempotent_message_payload_accepts_identical_top_level_message() {
    let existing = test_message();
    let prepared = test_prepared_message();

    assert!(super::validate_idempotent_message_payload(
        &existing,
        &prepared,
        Some("hello"),
        &[10, 11]
    )
    .is_ok());
}

#[test]
fn idempotent_system_message_payload_compares_event_identity() {
    use crate::models::SystemMessageKind;
    let existing = Message {
        message_type: MessageType::System,
        system_kind: Some(SystemMessageKind::MemberJoined),
        ..test_message()
    };
    let mut prepared = PreparedMessageSend {
        message_type: MessageType::System,
        system_kind: existing.system_kind,
        ..test_prepared_message()
    };
    assert!(super::validate_idempotent_message_payload(
        &existing,
        &prepared,
        Some("hello"),
        &[10, 11]
    )
    .is_ok());
    prepared.system_kind = Some(SystemMessageKind::MemberLeft);
    assert!(super::validate_idempotent_message_payload(
        &existing,
        &prepared,
        Some("hello"),
        &[10, 11]
    )
    .is_err());
}

#[test]
fn idempotent_message_payload_ignores_enriched_metadata() {
    let mut existing = test_message();
    existing.metadata = Some(serde_json::json!({"linkPreviews": []}));
    let prepared = test_prepared_message();

    assert!(super::validate_idempotent_message_payload(
        &existing,
        &prepared,
        Some("hello"),
        &[10, 11]
    )
    .is_ok());
}

#[test]
fn idempotent_message_payload_rejects_different_text() {
    let existing = test_message();
    let prepared = PreparedMessageSend {
        message: Some("different".to_string()),
        ..test_prepared_message()
    };

    assert!(matches!(
        super::validate_idempotent_message_payload(
            &existing,
            &prepared,
            Some("different"),
            &[10, 11]
        ),
        Err(super::AppError::Conflict(_))
    ));
}

#[test]
fn idempotent_message_payload_rejects_different_thread_context() {
    let existing = Message {
        reply_root_id: Some(99),
        ..test_message()
    };
    let prepared = test_prepared_message();

    assert!(matches!(
        super::validate_idempotent_message_payload(&existing, &prepared, Some("hello"), &[10, 11]),
        Err(super::AppError::Conflict(_))
    ));
}

#[test]
fn idempotent_message_payload_rejects_different_attachment_set() {
    let existing = test_message();
    let prepared = test_prepared_message();

    assert!(matches!(
        super::validate_idempotent_message_payload(&existing, &prepared, Some("hello"), &[10, 12]),
        Err(super::AppError::Conflict(_))
    ));
}

#[test]
fn idempotent_message_payload_rejects_different_attachment_order() {
    let existing = test_message();
    let prepared = test_prepared_message();

    assert!(matches!(
        super::validate_idempotent_message_payload(&existing, &prepared, Some("hello"), &[11, 10]),
        Err(super::AppError::Conflict(_))
    ));
}

#[test]
fn idempotent_message_payload_accepts_audio_with_original_attachment_id() {
    let existing = Message {
        message_type: MessageType::Audio,
        message: Some(String::new()),
        has_attachments: true,
        transcode_status: TranscodeStatus::Done,
        ..test_message()
    };
    let prepared = PreparedMessageSend {
        message_type: MessageType::Audio,
        message: Some(String::new()),
        attachment_ids: vec![55],
        publish_immediately: false,
        ..test_prepared_message()
    };

    assert!(
        super::validate_idempotent_message_payload(&existing, &prepared, Some(""), &[55]).is_ok()
    );
}

#[test]
fn outbox_conflict_scope_excludes_other_senders_and_private_records() {
    let mut existing = test_message();
    assert!(super::has_conflict_scope(&existing, 7, 42, None));
    assert!(!super::has_conflict_scope(&existing, 8, 42, None));
    assert!(!super::has_conflict_scope(&existing, 7, 43, None));
    assert!(!super::has_conflict_scope(&existing, 7, 42, Some(1)));
    existing.is_published = false;
    assert!(!super::has_conflict_scope(&existing, 7, 42, None));
    existing.is_published = true;
    existing.message_type = MessageType::System;
    assert!(!super::has_conflict_scope(&existing, 7, 42, None));
}

fn test_message() -> Message {
    Message {
        system_kind: None,
        forwarded_from_message_id: None,
        id: 1,
        message: Some("hello".to_string()),
        metadata: None,
        message_type: MessageType::Text,
        reply_to_id: Some(5),
        reply_root_id: None,
        client_generated_id: "client-1".to_string(),
        sender_uid: 7,
        chat_id: 42,
        created_at: Utc::now(),
        updated_at: None,
        deleted_at: None,
        has_attachments: true,
        has_thread: false,
        has_reactions: false,
        sticker_id: None,
        is_published: true,
        transcode_status: TranscodeStatus::None,
        forwarded_bundle_id: None,
    }
}

fn test_prepared_message() -> PreparedMessageSend {
    PreparedMessageSend {
        system_kind: None,
        forwarded_from_message_id: None,
        chat_id: 42,
        chat_kind: GroupKind::Group,
        forwarded_bundle_id: None,
        forwarded_preview_total: None,
        forwarded_preview_contains_forwarded_messages: None,
        forwarded_preview_items: None,
        sender_uid: 7,
        message: Some("hello".to_string()),
        metadata: None,
        message_type: MessageType::Text,
        sticker_id: None,
        reply_to_id: Some(5),
        reply_root_id: None,
        client_generated_id: "client-1".to_string(),
        attachment_ids: vec![10, 11],
        publish_immediately: true,
    }
}

#[test]
fn build_push_preview_bundle_uses_typed_invite_preview() {
    let response = super::MessageResponse {
        system_kind: None,
        system_links: None,
        forwarded_from: None,
        id: 1,
        message: Some("abc123".to_string()),
        metadata: None,
        message_type: MessageType::Invite,
        sticker: None,
        reply_root_id: None,
        client_generated_id: "cgid".to_string(),
        sender: User {
            uid: 7,
            avatar_url: None,
            name: Some("Alice".to_string()),
            gender: 0,
            user_group: None,
        },
        chat_id: 10,
        created_at: Utc::now(),
        is_edited: false,
        is_deleted: false,
        has_attachments: false,
        thread_info: None,
        reply_to_message: None,
        attachments: Vec::new(),
        reactions: Vec::new(),
        mentions: Vec::new(),
        forwarded_bundle_id: None,
        forwarded_preview: None,
    };

    let preview = build_push_preview_bundle(&response);
    assert_eq!(preview.body_preview, Some("sent an invite".to_string()));
    assert_eq!(preview.message_preview.message_type, MessageType::Invite);
    assert_eq!(preview.message_preview.message, None);
}

#[test]
fn serializes_reply_to_message_type_and_camel_case_keys() {
    let reply = MessagePreview {
        metadata: None,
        system_kind: None,
        system_links: None,
        forwarded_from_name: None,
        id: 42,
        client_generated_id: "cgid".to_string(),
        created_at: Utc::now(),
        sender: User {
            uid: 7,
            avatar_url: None,
            name: Some("Alice".to_string()),
            gender: 0,
            user_group: None,
        },
        message: Some("voice".to_string()),
        message_type: MessageType::Audio,
        sticker: None,
        attachments: vec![MessagePreviewAttachment {
            kind: "audio/webm".to_string(),
        }],
        is_deleted: false,
        mentions: Vec::new(),
    };

    let value = serde_json::to_value(reply).expect("serialize reply_to_message");
    assert_eq!(value["clientGeneratedId"], json!("cgid"));
    assert_eq!(value["messageType"], json!("audio"));
    assert_eq!(value["isDeleted"], json!(false));
    assert_eq!(value["attachments"], json!([{"kind": "audio/webm"}]));
    assert!(value.get("message_type").is_none());
}

#[test]
fn thread_scope_visibility_allows_only_deleted_root_shell_exception() {
    let root_id = 10;
    let deleted_root = message(root_id, |message| {
        message.deleted_at = Some(Utc::now());
        message.has_thread = true;
    });
    let deleted_reply = message(11, |message| {
        message.reply_root_id = Some(root_id);
        message.deleted_at = Some(Utc::now());
    });
    let deleted_non_root = message(12, |message| {
        message.deleted_at = Some(Utc::now());
    });
    let visible_reply = message(13, |message| {
        message.reply_root_id = Some(root_id);
    });

    assert!(message_is_visible_in_thread_scope(&deleted_root, root_id));
    assert!(!message_is_visible_in_thread_scope(&deleted_reply, root_id));
    assert!(!message_is_visible_in_thread_scope(
        &deleted_non_root,
        root_id
    ));
    assert!(message_is_visible_in_thread_scope(&visible_reply, root_id));
}

#[test]
fn deleted_message_response_redaction_preserves_metadata_only() {
    let mut response = MessageResponse {
        system_kind: None,
        system_links: Some(crate::dto::messages::SystemMessageLinks {
            uid: Some(42),
            message_id: Some(99),
        }),
        forwarded_from: None,
        id: 10,
        message: Some("secret root".to_string()),
        metadata: Some(crate::dto::link_previews::MessageMetadataResponse {
            link_previews: vec![crate::dto::link_previews::LinkPreviewResponse {
                url: "https://example.com/".to_string(),
                status: crate::dto::link_previews::LinkPreviewStatus::Ready,
                expires_at: None,
                title: Some("secret".to_string()),
                description: None,
                image: None,
            }],
        }),
        message_type: MessageType::Text,
        sticker: Some(sticker_response()),
        reply_root_id: None,
        client_generated_id: "client-10".to_string(),
        sender: sender(),
        chat_id: 1,
        created_at: Utc::now(),
        is_edited: true,
        is_deleted: true,
        has_attachments: true,
        thread_info: Some(super::ThreadInfo { reply_count: 2 }),
        reply_to_message: None,
        attachments: vec![attachment_response()],
        reactions: vec![ReactionSummary {
            emoji: "👍".to_string(),
            count: 1,
            reacted_by_me: Some(true),
            reactors: None,
        }],
        mentions: vec![MentionInfo {
            uid: 9,
            username: Some("Mentioned".to_string()),
            avatar_url: None,
            gender: 0,
            user_group: None,
        }],
        forwarded_bundle_id: None,
        forwarded_preview: None,
    };

    redact_deleted_message_response(&mut response);

    assert_eq!(response.id, 10);
    assert_eq!(response.client_generated_id, "client-10");
    assert_eq!(response.sender.uid, 7);
    assert!(response.is_edited);
    assert!(response.is_deleted);
    assert_eq!(
        response.thread_info.as_ref().map(|info| info.reply_count),
        Some(2)
    );
    assert_eq!(response.message, None);
    assert!(response.metadata.is_none());
    assert!(response.system_links.is_none());
    assert!(response.sticker.is_none());
    assert!(!response.has_attachments);
    assert!(response.attachments.is_empty());
    assert!(response.reactions.is_empty());
    assert!(response.mentions.is_empty());
}

#[test]
fn system_message_previews_decode_storage_and_redact_deleted_links() {
    for deleted_at in [None, Some(Utc::now())] {
        let preview = build_message_preview(
            MessagePreviewInput {
                metadata: None,
                system_kind: Some(crate::models::SystemMessageKind::MemberAdded),
                forwarded_from_name: None,
                id: 10,
                client_generated_id: "system-10".into(),
                created_at: Utc::now(),
                sender: sender(),
                message: Some(crate::services::system_messages::with_user(
                    "added 小花".into(),
                    42,
                )),
                message_type: MessageType::System,
                sticker_id: None,
                attachments: vec![],
                deleted_at,
                mention_source: None,
                mention_uids: None,
            },
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        );
        assert_eq!(
            preview.system_kind,
            Some(crate::models::SystemMessageKind::MemberAdded)
        );
        assert_eq!(
            serde_json::to_value(&preview).unwrap()["systemKind"],
            "member_added"
        );
        if deleted_at.is_some() {
            assert!(preview.message.is_none());
            assert!(preview.system_links.is_none());
        } else {
            assert_eq!(preview.message.as_deref(), Some("added 小花"));
            assert_eq!(preview.system_links.unwrap().uid, Some(42));
        }
    }
}

#[test]
fn build_message_preview_deleted_message_clears_sensitive_data() {
    let sticker_map = HashMap::from([(42, "🙂".to_string())]);
    let preview = build_message_preview(
        MessagePreviewInput {
            metadata: Some(crate::dto::link_previews::MessageMetadataResponse {
                link_previews: vec![],
            }),
            system_kind: None,
            forwarded_from_name: None,
            id: 10,
            client_generated_id: "client-10".to_string(),
            created_at: Utc::now(),
            sender: sender(),
            message: Some("secret root".to_string()),
            message_type: MessageType::Text,
            sticker_id: Some(42),
            attachments: vec![MessagePreviewAttachment {
                kind: "image/png".to_string(),
            }],
            deleted_at: Some(Utc::now()),
            mention_source: Some("@mention".to_string()),
            mention_uids: None,
        },
        &sticker_map,
        &HashMap::new(),
        &HashMap::new(),
    );

    assert_eq!(preview.id, 10);
    assert_eq!(preview.client_generated_id, "client-10");
    assert_eq!(preview.sender.uid, 7);
    assert!(preview.is_deleted);
    assert!(preview.metadata.is_none());
    assert_eq!(preview.message, None);
    assert!(preview.sticker.is_none());
    assert!(preview.attachments.is_empty());
    assert!(preview.mentions.is_empty());
}
#[test]
fn message_send_authorization_errors_preserve_http_statuses() {
    let status = |error| AppError::from(error).into_response().status();

    assert_eq!(
        status(MessageSendAuthorizationError::NotChatMember),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        status(MessageSendAuthorizationError::ThreadRootNotFound),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        status(MessageSendAuthorizationError::ThreadRootNotText),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        status(MessageSendAuthorizationError::DirectMessage(
            DmSendAuthorizationError::FriendshipRequired,
        )),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        status(MessageSendAuthorizationError::DirectMessage(
            DmSendAuthorizationError::Blocked,
        )),
        StatusCode::FORBIDDEN
    );
}

/// Edit-sync is kind-aware: dropping an @mention on the message's reply
/// target downgrades their row to kind='reply' instead of deleting it, an
/// unrelated dropped mention is still deleted, and adding an @mention over
/// an existing reply row upgrades it to kind='mention'. Requires a test
/// database (`WETTY_TEST_DATABASE_URL`); skipped otherwise.
#[test]
fn sync_edited_message_mentions_preserves_reply_rows() {
    use crate::models::MentionKind;
    use crate::schema::message_mentions;
    use crate::schema::messages as messages_schema;
    use diesel::prelude::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    let url = match std::env::var("WETTY_TEST_DATABASE_URL") {
        Ok(u) => u,
        Err(_) => {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        }
    };
    let mut conn = diesel::PgConnection::establish(&url).expect("connect to test database");

    static SEQ: AtomicI64 = AtomicI64::new(9_876_576_000);
    let chat_id = SEQ.fetch_add(1, Ordering::SeqCst);
    let target_msg = SEQ.fetch_add(1, Ordering::SeqCst);
    let reply_msg = SEQ.fetch_add(1, Ordering::SeqCst);
    let editor: i32 = 4245;
    let target_author: i32 = 4246;
    let other_mentioned: i32 = 4247;

    let result = conn.transaction::<(), AppError, _>(|conn| {
            diesel::sql_query("INSERT INTO groups (id, name) VALUES ($1, 'edit-sync-test')")
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            for uid in [editor, target_author, other_mentioned] {
                diesel::sql_query("INSERT INTO group_membership (chat_id, uid) VALUES ($1, $2)")
                    .bind::<diesel::sql_types::BigInt, _>(chat_id)
                    .bind::<diesel::sql_types::Integer, _>(uid)
                    .execute(conn)?;
            }
            // The reply target's author is `target_author`.
            diesel::sql_query(
                "INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at) \
                 VALUES ($1, 'text', $2, $3, $4, NOW())",
            )
            .bind::<diesel::sql_types::BigInt, _>(target_msg)
            .bind::<diesel::sql_types::Text, _>(format!("cg-{chat_id}-{target_msg}"))
            .bind::<diesel::sql_types::Integer, _>(target_author)
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .execute(conn)?;
            diesel::sql_query(
                "INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, reply_to_id, message, created_at) \
                 VALUES ($1, 'text', $2, $3, $4, $5, $6, NOW())",
            )
            .bind::<diesel::sql_types::BigInt, _>(reply_msg)
            .bind::<diesel::sql_types::Text, _>(format!("cg-{chat_id}-{reply_msg}"))
            .bind::<diesel::sql_types::Integer, _>(editor)
            .bind::<diesel::sql_types::BigInt, _>(chat_id)
            .bind::<diesel::sql_types::BigInt, _>(target_msg)
            .bind::<diesel::sql_types::Text, _>(
                format!("hello @[uid:{target_author}] @[uid:{other_mentioned}]"),
            )
            .execute(conn)?;
            for uid in [target_author, other_mentioned] {
                diesel::sql_query(
                    "INSERT INTO message_mentions (message_id, mentioned_uid, chat_id, thread_root_id, created_at, kind) \
                     VALUES ($1, $2, $3, NULL, NOW(), 'mention')",
                )
                .bind::<diesel::sql_types::BigInt, _>(reply_msg)
                .bind::<diesel::sql_types::Integer, _>(uid)
                .bind::<diesel::sql_types::BigInt, _>(chat_id)
                .execute(conn)?;
            }

            let mut message: Message = messages_schema::table
                .filter(messages_schema::id.eq(reply_msg))
                .first(conn)?;

            // Edit 1: drop both @mentions. The reply target keeps a downgraded
            // row; the unrelated mention is deleted.
            crate::services::messages::sync_edited_message_mentions(
                conn,
                &message,
                "hello there",
                editor,
                Utc::now(),
            )?;
            let kinds: Vec<MentionKind> = message_mentions::table
                .filter(message_mentions::message_id.eq(reply_msg))
                .select(message_mentions::kind)
                .load(conn)?;
            assert_eq!(kinds, vec![MentionKind::Reply]);

            // Edit 2: re-add the reply target as an @mention. The reply row is
            // upgraded to kind='mention' (mention wins).
            message.message = Some("hello there".to_string());
            let added = crate::services::messages::sync_edited_message_mentions(
                conn,
                &message,
                "hello there @[uid:4246]",
                editor,
                Utc::now(),
            )?;
            assert_eq!(added, vec![target_author]);
            let kinds: Vec<MentionKind> = message_mentions::table
                .filter(message_mentions::message_id.eq(reply_msg))
                .select(message_mentions::kind)
                .load(conn)?;
            assert_eq!(kinds, vec![MentionKind::Mention]);

            Err(AppError::Internal("rollback"))
        });

    assert!(result.is_err(), "transaction should roll back");
}
