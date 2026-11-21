use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::dto::{
    chats::ChatListItem,
    messages::MessageResponse,
    threads::ThreadListItem,
    users::{ChatSettings, NotificationSettingsResponse},
};

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListSyncQuery {
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ListSyncResetReason {
    NoBaseline,
    InvalidCursor,
    EpochChanged,
    Expired,
    AccountChanged,
    TooLarge,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListSyncRemoval {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    #[serde(
        with = "crate::serde_i64_string::opt",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(value_type = Option<String>)]
    pub thread_id: Option<i64>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListSyncResponse {
    pub cursor: String,
    pub complete: bool,
    pub reset: Option<ListSyncResetReason>,
    pub chat_settings: ChatSettings,
    pub notification_settings: NotificationSettingsResponse,
    pub chats: Vec<ChatListItem>,
    pub threads: Vec<ThreadListItem>,
    pub latest_messages: Vec<MessageResponse>,
    pub removed: Vec<ListSyncRemoval>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wire_shape_includes_arrays_and_omits_main_thread_id() {
        let response = ListSyncResponse {
            cursor: "token".into(),
            complete: false,
            reset: None,
            chat_settings: ChatSettings {
                show_membership_messages: true,
                show_unread_message_count: false,
            },
            notification_settings: NotificationSettingsResponse {
                mute_group_chats_by_default: false,
                mute_direct_chats_by_default: false,
            },
            chats: vec![],
            threads: vec![],
            latest_messages: vec![],
            removed: vec![
                ListSyncRemoval {
                    chat_id: i64::MAX,
                    thread_id: None,
                },
                ListSyncRemoval {
                    chat_id: 42,
                    thread_id: Some(i64::MAX),
                },
            ],
        };
        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["reset"], json!(null));
        for field in ["chats", "threads", "latestMessages"] {
            assert_eq!(value[field], json!([]));
        }
        assert_eq!(
            value["removed"],
            json!([{ "chatId": "9223372036854775807" }, { "chatId": "42", "threadId": "9223372036854775807" }])
        );
        assert_eq!(
            serde_json::to_value(ListSyncResetReason::NoBaseline).unwrap(),
            "noBaseline"
        );
        assert_eq!(
            serde_json::to_value(ListSyncResetReason::InvalidCursor).unwrap(),
            "invalidCursor"
        );
        assert_eq!(
            serde_json::to_value(ListSyncResetReason::EpochChanged).unwrap(),
            "epochChanged"
        );
        assert_eq!(
            serde_json::to_value(ListSyncResetReason::Expired).unwrap(),
            "expired"
        );
        assert_eq!(
            serde_json::to_value(ListSyncResetReason::AccountChanged).unwrap(),
            "accountChanged"
        );
        assert_eq!(
            serde_json::to_value(ListSyncResetReason::TooLarge).unwrap(),
            "tooLarge"
        );
    }
}
