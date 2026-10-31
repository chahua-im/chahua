use serde::Deserialize;
use utoipa::ToSchema;

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PresenceWatchParams {
    pub request_id: Option<u64>,
    pub user_ids: Option<Vec<i32>>,
    #[schema(schema_with = nullable_chat_ids_schema)]
    pub chat_ids: Option<Vec<String>>,
}

fn nullable_chat_ids_schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
    serde_json::from_value(serde_json::json!({
        "oneOf": [
            {"type": "array", "items": {"type": "string", "x-snowflake-id": true}},
            {"type": "null"},
        ],
    }))
    .expect("valid optional presence chat ID schema")
}
