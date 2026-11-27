use super::{FriendRequestStatus, MessageType, TranscodeStatus};

#[test]
fn message_type_serializes_as_snake_case() {
    let json = serde_json::to_string(&MessageType::Invite).expect("serialize message type");
    assert_eq!(json, "\"invite\"");
}

#[test]
fn message_type_deserializes_system_variant() {
    let value: MessageType = serde_json::from_str("\"system\"").expect("deserialize message type");
    assert_eq!(value, MessageType::System);
}

#[test]
fn message_type_deserializes_invite_variant() {
    let value: MessageType = serde_json::from_str("\"invite\"").expect("deserialize message type");
    assert_eq!(value, MessageType::Invite);
}

#[test]
fn message_type_deserializes_sticker_variant() {
    let value: MessageType = serde_json::from_str("\"sticker\"").expect("deserialize message type");
    assert_eq!(value, MessageType::Sticker);
}

#[test]
fn transcode_status_serializes_as_snake_case() {
    let json =
        serde_json::to_string(&TranscodeStatus::Pending).expect("serialize transcode status");
    assert_eq!(json, "\"pending\"");
}

#[test]
fn friend_request_status_serializes_archived_variant() {
    let json = serde_json::to_string(&FriendRequestStatus::Archived)
        .expect("serialize friend request status");
    assert_eq!(json, "\"archived\"");
}
