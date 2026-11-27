use super::*;
use crate::dto::link_previews::LinkPreviewInput;

fn input(url: &str, title: Option<&str>, image_url: Option<&str>) -> LinkPreviewInput {
    LinkPreviewInput {
        status: None,
        url: url.to_owned(),
        title: title.map(str::to_owned),
        image_url: image_url.map(str::to_owned),
    }
}

fn intent(url: &str, status: LinkPreviewInputStatus) -> LinkPreviewInput {
    LinkPreviewInput {
        status: Some(status),
        ..input(url, None, None)
    }
}

#[test]
fn disabled_previews_survive_edits_and_do_not_consume_slots() {
    let text = "https://one.example/ https://two.example/ https://three.example/ https://four.example/ https://five.example/ https://six.example/";
    let body = MessageMetadataInput {
        link_previews: vec![
            intent("https://ONE.example", LinkPreviewInputStatus::Disabled),
            intent("https://five.example/", LinkPreviewInputStatus::Disabled),
            intent("https://six.example/", LinkPreviewInputStatus::Disabled),
        ],
    };
    let now = Utc::now();
    let prepared = prepare(Some(text), Some(&body), now).unwrap();
    assert_eq!(prepared.work.len(), 3);
    let current = prepared.metadata.unwrap();
    let entries = current["linkPreviews"].as_array().unwrap();
    assert_eq!(entries.len(), 6);
    for index in [0, 4, 5] {
        assert_eq!(
            entries[index],
            serde_json::json!({"url": select_urls(text)[index], "status": "disabled"})
        );
    }
    for input in [
        None,
        Some(MessageMetadataInput {
            link_previews: vec![],
        }),
    ] {
        let edited = prepare_edit(text, input.as_ref(), Some(&current), now).unwrap();
        assert_eq!(
            edited.metadata.as_ref().unwrap()["linkPreviews"],
            current["linkPreviews"]
        );
        assert_eq!(edited.work.len(), 3);
    }
    let supplied_without_enable = MessageMetadataInput {
        link_previews: vec![input(
            "https://one.example/",
            Some("Unrelated title update"),
            None,
        )],
    };
    let edited = prepare_edit(text, Some(&supplied_without_enable), Some(&current), now).unwrap();
    assert_eq!(
        edited.metadata.unwrap()["linkPreviews"][0]["status"],
        "disabled"
    );
    let enable_beyond_limit = MessageMetadataInput {
        link_previews: vec![intent(
            "https://five.example/",
            LinkPreviewInputStatus::Enabled,
        )],
    };
    let edited = prepare_edit(text, Some(&enable_beyond_limit), Some(&current), now).unwrap();
    assert_eq!(edited.work.len(), 3);
    assert!(!edited.metadata.unwrap()["linkPreviews"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["url"] == "https://five.example/"));
    let enabled = MessageMetadataInput {
        link_previews: vec![intent(
            "https://one.example/",
            LinkPreviewInputStatus::Enabled,
        )],
    };
    let edited = prepare_edit(text, Some(&enabled), Some(&current), now).unwrap();
    let metadata = edited.metadata.unwrap();
    assert_eq!(metadata["linkPreviews"][0]["status"], "pending");
    assert!(edited.work.contains(&LinkPreviewWork::FetchPage {
        url: "https://one.example/".into()
    }));
    assert_eq!(metadata["linkPreviews"].as_array().unwrap().len(), 5);
    assert!(prepare_edit("removed", None, Some(&current), now)
        .unwrap()
        .metadata
        .is_none());
    let snapshot = snapshot_metadata(&current).unwrap().unwrap();
    assert_eq!(snapshot["linkPreviews"].as_array().unwrap().len(), 3);
    assert!(snapshot["linkPreviews"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["status"] == "disabled"));
}

#[test]
fn disabling_ready_content_clears_it_and_accepts_more_than_three_disabled_urls() {
    let text =
        "https://one.example/ https://two.example/ https://three.example/ https://four.example/";
    let body = MessageMetadataInput {
        link_previews: select_urls(text)
            .iter()
            .map(|url| intent(url, LinkPreviewInputStatus::Disabled))
            .collect(),
    };
    let old = serde_json::json!({"linkPreviews":[{"url":"https://one.example/","status":"ready","title":"Title","description":"Description"}]});
    let prepared = prepare_edit(text, Some(&body), Some(&old), Utc::now()).unwrap();
    assert!(prepared.work.is_empty());
    let metadata = prepared.metadata.unwrap();
    assert_eq!(metadata["linkPreviews"].as_array().unwrap().len(), 4);
    assert!(metadata["linkPreviews"][0].get("title").is_none());
    assert!(metadata["linkPreviews"][0].get("description").is_none());
    let projected = preview_metadata(&metadata).unwrap();
    assert!(projected
        .link_previews
        .iter()
        .all(|p| p.status == LinkPreviewStatus::Disabled));
}

#[test]
fn user_intent_cannot_supply_server_states_or_disabled_content() {
    for status in ["ready", "pending", "unavailable"] {
        assert!(serde_json::from_value::<MessageMetadataInput>(
            serde_json::json!({"linkPreviews":[{"url":"https://one.example/","status":status}]})
        )
        .is_err());
    }
    for status in ["enabled", "disabled"] {
        assert!(serde_json::from_value::<MessageMetadataInput>(
            serde_json::json!({"linkPreviews":[{"url":"https://one.example/","status":status}]})
        )
        .is_ok());
    }
    let body = MessageMetadataInput {
        link_previews: vec![LinkPreviewInput {
            status: Some(LinkPreviewInputStatus::Disabled),
            ..input("https://one.example/", Some("Title"), None)
        }],
    };
    assert!(prepare(Some("https://one.example/"), Some(&body), Utc::now()).is_err());
    let body = MessageMetadataInput {
        link_previews: vec![intent(
            "https://other.example/",
            LinkPreviewInputStatus::Disabled,
        )],
    };
    assert!(prepare(Some("https://one.example/"), Some(&body), Utc::now()).is_err());
    let plain = prepare(Some("https://one.example/ https://two.example/ https://three.example/ https://four.example/"), None, Utc::now()).unwrap();
    assert_eq!(plain.work.len(), 3);
}

#[test]
fn link_preview_selection_is_ordered_and_distinct() {
    let selected = select_urls(
        "https://EXAMPLE.com/a#part https://example.com/a#part https://two.example/ \
             https://three.example/?a=1 https://four.example/",
    );
    assert_eq!(
        selected,
        [
            "https://example.com/a#part",
            "https://two.example/",
            "https://three.example/?a=1",
            "https://four.example/",
        ]
    );
}

#[test]
fn link_preview_url_policy_rejects_unsafe_syntax() {
    for value in [
        "http://example.com/",
        "https://127.0.0.1/",
        "https://[::1]/",
        "https://example.com:444/",
        "https://user@example.com/",
        "https://@example.com/",
        "https:///@example.com/",
        "https:////@example.com/",
        "https:example.com/",
        "example.com",
    ] {
        assert!(validate_url(value).is_none(), "{value}");
    }
    assert!(validate_url("https://example.com:443/path#fragment").is_some());
}

#[test]
fn link_preview_supplied_cards_keep_selected_order_and_only_cache_images() {
    let metadata = MessageMetadataInput {
        link_previews: vec![
            input(
                "https://two.example",
                Some("  Second  "),
                Some("https://img.example/a"),
            ),
            input("https://one.example/", Some("  "), None),
        ],
    };
    let prepared = prepare(
        Some("https://one.example https://two.example https://three.example"),
        Some(&metadata),
        Utc::now(),
    )
    .unwrap();
    let stored: StoredMessageMetadata = serde_json::from_value(prepared.metadata.unwrap()).unwrap();
    assert_eq!(
        stored.link_previews[0].title.as_deref(),
        Some("one.example")
    );
    assert_eq!(stored.link_previews[1].title.as_deref(), Some("Second"));
    assert!(stored.link_previews[0].description.is_none());
    assert!(stored.link_previews[1].description.is_none());
    assert_eq!(stored.link_previews[2].status, LinkPreviewStatus::Pending);
    assert!(
        matches!(&prepared.work[0], LinkPreviewWork::CacheImage { url, .. } if url == "https://two.example/")
    );
    assert!(
        matches!(&prepared.work[1], LinkPreviewWork::FetchPage { url } if url == "https://three.example/")
    );
}

#[test]
fn link_preview_invalid_supplied_entries_are_rejected() {
    let now = Utc::now();
    for entries in [
        vec![input("https://other.example/", None, None)],
        vec![
            input("https://one.example/", None, None),
            input("https://ONE.example", None, None),
        ],
        vec![input(
            "https://one.example/",
            None,
            Some("http://image.example/"),
        )],
        vec![input("https://one.example/", Some(&"a".repeat(513)), None)],
        vec![input("https://one.example/", None, None); 4],
    ] {
        let body = MessageMetadataInput {
            link_previews: entries,
        };
        assert!(matches!(
            prepare(Some("https://one.example/"), Some(&body), now),
            Err(AppError::BadRequest("Invalid link preview"))
        ));
    }
}

#[test]
fn link_preview_request_rejects_server_owned_fields() {
    assert!(serde_json::from_str::<MessageMetadataInput>(
        r#"{"linkPreviews":[{"url":"https://one.example/","status":"ready"}]}"#
    )
    .is_err());
    assert!(serde_json::from_str::<MessageMetadataInput>(
        r#"{"linkPreviews":[{"url":"https://one.example/","description":"not accepted"}]}"#
    )
    .is_err());
    assert!(
        serde_json::from_str::<MessageMetadataInput>(r#"{"linkPreviews":[],"other":1}"#).is_err()
    );
    assert!(serde_json::from_str::<MessageMetadataInput>(r#"{}"#)
        .unwrap()
        .link_previews
        .is_empty());
}

#[test]
fn link_preview_snapshot_copies_only_ready_entries() {
    let prepared = prepare(
        Some("https://one.example/ https://two.example/"),
        Some(&MessageMetadataInput {
            link_previews: vec![input("https://one.example/", Some("Title"), None)],
        }),
        Utc::now(),
    )
    .unwrap();
    let mut metadata = prepared.metadata.unwrap();
    metadata["linkPreviews"][0]["description"] = serde_json::json!("A description");
    let snapshot = snapshot_metadata(&metadata).unwrap().unwrap();
    let stored: StoredMessageMetadata = serde_json::from_value(snapshot).unwrap();
    assert_eq!(stored.link_previews.len(), 1);
    assert_eq!(stored.link_previews[0].title.as_deref(), Some("Title"));
    assert_eq!(
        stored.link_previews[0].description.as_deref(),
        Some("A description")
    );
}

#[test]
fn link_preview_description_projects_and_old_metadata_remains_readable() {
    let media = MediaStore::new(
        aws_sdk_s3::Client::from_conf(
            aws_sdk_s3::Config::builder()
                .behavior_version_latest()
                .build(),
        ),
        std::sync::Arc::new(crate::config::MediaConfig {
            bucket: "media-bucket".into(),
            attachment_prefix: "attachments".into(),
            base_url: Some("https://media.example".into()),
            endpoint_url: None,
            upload_proxy_path: None,
            max_attachment_file_size_bytes: 1,
        }),
    );
    let metadata = serde_json::json!({
        "linkPreviews": [
            {"url":"https://one.example/","status":"ready","title":"Title","description":"Text"},
            {"url":"https://old.example/","status":"ready","title":"Old"}
        ]
    });
    let projected = project_metadata(&metadata, &media, Utc::now()).unwrap();
    assert_eq!(
        projected.link_previews[0].description.as_deref(),
        Some("Text")
    );
    assert!(projected.link_previews[1].description.is_none());
    let json = serde_json::to_value(projected).unwrap();
    assert_eq!(json["linkPreviews"][0]["description"], "Text");
    assert!(json["linkPreviews"][1].get("description").is_none());
}

#[test]
fn link_preview_edits_preserve_terminal_entries_and_replace_pending_attempts() {
    let at = Utc::now();
    let current = serde_json::json!({
        "other": 42,
        "linkPreviews": [
            {"url":"https://ready.example/","status":"ready","title":"Original","description":"Original description"},
            {"url":"https://failed.example/","status":"unavailable"},
            {"url":"https://pending.example/","status":"pending","expiresAt": at}
        ]
    });
    let edited = prepare_edit(
        "https://failed.example/ https://ready.example/ https://pending.example/",
        None,
        Some(&current),
        at,
    )
    .unwrap();
    assert_eq!(
        edited.work,
        [LinkPreviewWork::FetchPage {
            url: "https://pending.example/".into()
        }]
    );
    let metadata = edited.metadata.unwrap();
    assert_eq!(metadata["other"], 42);
    let stored: StoredMessageMetadata = serde_json::from_value(metadata).unwrap();
    assert_eq!(
        stored.link_previews[0].status,
        LinkPreviewStatus::Unavailable
    );
    assert_eq!(stored.link_previews[1].title.as_deref(), Some("Original"));
    assert_eq!(
        stored.link_previews[1].description.as_deref(),
        Some("Original description")
    );
    assert_eq!(
        stored.link_previews[2].expires_at,
        Some(at + Duration::seconds(30))
    );
    let supplied = MessageMetadataInput {
        link_previews: vec![input("https://ready.example/", Some("Replacement"), None)],
    };
    let edited = prepare_edit(
        "https://ready.example/",
        Some(&supplied),
        Some(&current),
        at,
    )
    .unwrap();
    assert!(edited.work.is_empty());
    assert_eq!(
        edited.metadata.unwrap()["linkPreviews"][0]["title"],
        "Replacement"
    );
    assert_eq!(
        prepare_edit("removed", None, Some(&current), at)
            .unwrap()
            .metadata,
        Some(serde_json::json!({"other":42}))
    );
    let only_previews = serde_json::json!({"linkPreviews":current["linkPreviews"]});
    assert!(prepare_edit("removed", None, Some(&only_previews), at)
        .unwrap()
        .metadata
        .is_none());
}
