use super::{ForwardMessagesBody, ListMessagesResponse};
use serde_json::json;

#[test]
fn list_messages_response_serializes_directional_cursor_aliases() {
    let response = ListMessagesResponse {
        membership_message_policy: crate::dto::groups::MembershipMessagePolicy {
            visibility: crate::models::MembershipMessageVisibility::Members,
            can_view: true,
        },
        chat_settings: crate::dto::users::ChatSettings {
            show_membership_messages: true,
            show_unread_message_count: false,
        },
        messages: vec![],
        next_cursor: Some(10),
        prev_cursor: Some(20),
        older_cursor: Some(10),
        newer_cursor: Some(20),
    };

    let value = serde_json::to_value(response).expect("serialize response");

    assert_eq!(
        value,
        json!({
            "chatSettings": {"showMembershipMessages": true, "showUnreadMessageCount": false},
            "membershipMessagePolicy": {"visibility": "members", "canView": true},
            "messages": [],
            "nextCursor": "10",
            "prevCursor": "20",
            "olderCursor": "10",
            "newerCursor": "20"
        })
    );
}

#[test]
fn forward_request_requires_the_client_generated_id() {
    let body = serde_json::from_value::<ForwardMessagesBody>(serde_json::json!({
        "sourceChatId": "42",
        "messageIds": ["10"],
        "clientGeneratedId": "forward-retry-42"
    }))
    .expect("forward request should retain the caller-generated id");

    assert_eq!(body.client_generated_id, "forward-retry-42");
    assert!(
        serde_json::from_value::<ForwardMessagesBody>(serde_json::json!({
            "sourceChatId": "42",
            "messageIds": ["10"]
        }))
        .is_err()
    );
}

#[test]
fn merged_forward_request_accepts_an_optional_string_thread_id() {
    let mut json = serde_json::json!({
        "sourceChatId": "42",
        "messageIds": ["10", "20"],
        "clientGeneratedId": "forward-thread-42"
    });
    let body: ForwardMessagesBody = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(body.thread_id, None);
    json["threadId"] = serde_json::Value::Null;
    let body: ForwardMessagesBody = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(body.thread_id, None);
    json["threadId"] = i64::MAX.to_string().into();
    let body: ForwardMessagesBody = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(body.thread_id, Some(i64::MAX));
    json["threadId"] = "invalid".into();
    assert!(serde_json::from_value::<ForwardMessagesBody>(json).is_err());
}
