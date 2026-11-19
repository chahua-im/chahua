use serde::{Deserialize, Deserializer, Serialize};
use utoipa::ToSchema;

use crate::dto::messages::{ListMessagesResponse, MessageResponse};

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageSyncChat {
    #[serde(
        deserialize_with = "decode_id",
        serialize_with = "crate::serde_i64_string::serialize"
    )]
    #[schema(value_type = String)]
    pub chat_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageSyncResumeParams {
    #[schema(max_items = 128)]
    pub chats: Vec<MessageSyncChat>,
    pub last: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "decode_optional_id",
        serialize_with = "crate::serde_i64_string::opt::serialize"
    )]
    #[schema(value_type = Option<String>)]
    pub priority_chat_id: Option<i64>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageSyncPageParams {
    pub request_id: u32,
    #[serde(deserialize_with = "decode_id")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    #[serde(default, deserialize_with = "decode_optional_id")]
    #[schema(value_type = Option<String>)]
    pub thread_id: Option<i64>,
    #[serde(default, deserialize_with = "decode_optional_id")]
    #[schema(value_type = Option<String>)]
    pub before: Option<i64>,
    #[serde(default, deserialize_with = "decode_optional_id")]
    #[schema(value_type = Option<String>)]
    pub after: Option<i64>,
    #[serde(default, deserialize_with = "decode_optional_id")]
    #[schema(value_type = Option<String>)]
    pub around: Option<i64>,
    pub max: Option<i64>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MessageSyncHello {
    pub version: u8,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MessageSyncChange {
    Upsert {
        appeared: bool,
        message: Box<MessageResponse>,
    },
    Delete {
        #[serde(rename = "messageId", with = "crate::serde_i64_string")]
        #[schema(value_type = String)]
        message_id: i64,
        #[serde(
            rename = "threadRootId",
            with = "crate::serde_i64_string::opt",
            skip_serializing_if = "Option::is_none"
        )]
        #[schema(value_type = Option<String>)]
        thread_root_id: Option<i64>,
    },
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageSyncBatch {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    pub from: String,
    pub to: String,
    pub changes: Vec<MessageSyncChange>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageSyncReady {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    pub cursor: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum MessageSyncResetReason {
    NoBaseline,
    InvalidCursor,
    EpochChanged,
    VisibilityChanged,
    Expired,
    TooLarge,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageSyncReset {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    pub cursor: String,
    pub reason: MessageSyncResetReason,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageSyncRevoked {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageSyncPageResult {
    pub request_id: u32,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    #[schema(required = true)]
    pub at: Option<String>,
    #[schema(required = true)]
    pub page: Option<ListMessagesResponse>,
}

fn decode_id<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    String::deserialize(deserializer)?
        .parse()
        .map_err(serde::de::Error::custom)
}

fn decode_optional_id<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
    Option::<String>::deserialize(deserializer)?
        .map(|value| value.parse().map_err(serde::de::Error::custom))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{dto::ws::ServerWsMessage, rpc::events::encode_event};
    use serde_json::{json, Value};

    #[test]
    fn message_sync_wire_preserves_snowflakes_and_opaque_cursors() {
        let id = i64::MAX;
        let id_string = id.to_string();
        let event = ServerWsMessage::MessageSyncBatch(MessageSyncBatch {
            chat_id: id,
            from: "cursor_a".into(),
            to: "cursor_b".into(),
            changes: vec![MessageSyncChange::Delete {
                message_id: id - 1,
                thread_root_id: Some(id - 2),
            }],
        });
        let payload = json!({
            "chatId": id_string, "from": "cursor_a", "to": "cursor_b",
            "changes": [{"kind": "delete", "messageId": (id-1).to_string(), "threadRootId": (id-2).to_string()}],
        });
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({"type": "messageSyncBatch", "payload": payload})
        );
        assert_eq!(
            serde_json::from_str::<Value>(&encode_event(&event).unwrap()).unwrap(),
            json!({"jsonrpc": "2.0", "method": "events.messageSyncBatch", "params": payload}),
        );
        let event = ServerWsMessage::MessageSyncPageResult(MessageSyncPageResult {
            request_id: 17,
            chat_id: id,
            at: None,
            page: None,
        });
        assert_eq!(
            serde_json::to_value(event).unwrap()["payload"],
            json!({"requestId": 17, "chatId": id_string, "at": null, "page": null}),
        );
        let params = serde_json::from_value::<MessageSyncPageParams>(json!({
            "requestId": 17, "chatId": id_string, "around": (id-1).to_string(),
        }))
        .unwrap();
        assert_eq!(params.request_id, 17);
        assert_eq!(params.chat_id, id);
        assert_eq!(params.around, Some(id - 1));
        assert!(serde_json::from_value::<MessageSyncPageParams>(
            json!({"requestId": 17, "chatId": id})
        )
        .is_err());
    }

    #[test]
    fn message_sync_schema_marks_ids_but_not_checkpoints_or_request_ids() {
        let openapi = serde_json::to_value(crate::openapi::document()).unwrap();
        let openrpc = crate::rpc::schema::openrpc_document();
        for document in [openapi, openrpc] {
            let schemas = &document["components"]["schemas"];
            let batch = &schemas["MessageSyncBatch"]["properties"];
            assert_eq!(batch["chatId"]["x-snowflake-id"], true);
            assert!(batch["from"]["x-snowflake-id"].is_null());
            assert!(batch["to"]["x-snowflake-id"].is_null());
            let variants = schemas["MessageSyncChange"]["oneOf"].as_array().unwrap();
            assert_eq!(
                variants[0]["properties"]["message"]["$ref"],
                "#/components/schemas/MessageResponse"
            );
            let delete = &variants[1]["properties"];
            assert_eq!(delete["messageId"]["x-snowflake-id"], true);
            assert_eq!(delete["threadRootId"]["x-snowflake-id"], true);
            let page = &schemas["MessageSyncPageResult"]["properties"];
            assert_eq!(page["chatId"]["x-snowflake-id"], true);
            assert_eq!(page["requestId"]["type"], "integer");
            assert!(page["requestId"]["x-snowflake-id"].is_null());
            assert!(page["at"]["x-snowflake-id"].is_null());
        }
    }
}
