//! Persist link destinations alongside system text without changing legacy client text.
use serde::{Deserialize, Serialize};

use crate::{dto::messages::SystemMessageLinks, models::MessageType};

#[derive(Serialize, Deserialize)]
struct StoredSystemMessage {
    text: String,
    links: SystemMessageLinks,
}

pub fn with_user(text: String, uid: i32) -> String {
    serde_json::json!({ "text": text, "links": { "uid": uid } }).to_string()
}

pub fn with_message(text: &str, message_id: i64) -> String {
    serde_json::json!({ "text": text, "links": { "messageId": message_id.to_string() } })
        .to_string()
}

/// Legacy system strings and ordinary user text pass through unchanged.
pub fn decode(
    message_type: &MessageType,
    message: Option<String>,
) -> (Option<String>, Option<SystemMessageLinks>) {
    if *message_type == MessageType::System {
        if let Some(stored) = message
            .as_deref()
            .and_then(|text| serde_json::from_str::<StoredSystemMessage>(text).ok())
        {
            return (Some(stored.text), Some(stored.links));
        }
    }
    (message, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_user_names_and_stable_destinations() {
        let text = "accepted 小花 <b>O'Brien</b>'s friend request";
        let (decoded, links) = decode(&MessageType::System, Some(with_user(text.into(), 42)));
        assert_eq!(decoded.as_deref(), Some(text));
        assert_eq!(links.unwrap().uid, Some(42));
    }

    #[test]
    fn message_ids_round_trip_without_javascript_precision_loss() {
        let id = 9_007_199_254_740_993;
        let (text, links) = decode(
            &MessageType::System,
            Some(with_message("unpinned a message", id)),
        );
        assert_eq!(text.as_deref(), Some("unpinned a message"));
        let links = links.unwrap();
        assert_eq!(links.message_id, Some(id));
        assert_eq!(
            serde_json::to_value(links).unwrap()["messageId"],
            id.to_string()
        );
    }

    #[test]
    fn preserves_legacy_unknown_and_user_authored_text() {
        for text in ["joined the chat", "changed the theme", "{invalid json}"] {
            assert_eq!(
                decode(&MessageType::System, Some(text.into())),
                (Some(text.into()), None)
            );
        }
        let text = with_user("added Bob".into(), 42);
        assert_eq!(
            decode(&MessageType::Text, Some(text.clone())),
            (Some(text), None)
        );
    }
}
