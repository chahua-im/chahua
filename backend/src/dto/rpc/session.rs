use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::dto::ws::OnlineClientStatus;
use crate::services::auth_token::VerifiedSession;

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpenParams {
    pub protocol_version: u8,
    pub token: Option<String>,
    pub app_version: Option<String>,
    #[serde(default)]
    pub message_sync: Option<u8>,
}

#[derive(Deserialize, ToSchema)]
pub struct SessionPingParams {
    pub state: Option<OnlineClientStatus>,
}

#[derive(Deserialize, ToSchema)]
pub struct SessionSetAppStateParams {
    pub state: Option<OnlineClientStatus>,
}

#[derive(Serialize, ToSchema)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum SessionOpenResult {
    Authenticated {
        #[serde(rename = "protocolVersion")]
        protocol_version: u8,
        #[schema(schema_with = authenticated_schema)]
        authenticated: bool,
        uid: i32,
        #[serde(rename = "clientId")]
        client_id: String,
        #[serde(rename = "messageSync", skip_serializing_if = "Option::is_none")]
        message_sync: Option<u8>,
    },
    Anonymous {
        #[serde(rename = "protocolVersion")]
        protocol_version: u8,
        #[schema(schema_with = anonymous_schema)]
        authenticated: bool,
    },
}

impl SessionOpenResult {
    pub fn authenticated(session: &VerifiedSession, message_sync: Option<u8>) -> Self {
        Self::Authenticated {
            protocol_version: 1,
            authenticated: true,
            uid: session.uid,
            client_id: session.client_id.clone(),
            message_sync,
        }
    }

    pub fn anonymous() -> Self {
        Self::Anonymous {
            protocol_version: 1,
            authenticated: false,
        }
    }
}

fn authenticated_schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
    serde_json::from_value(serde_json::json!({"type": "boolean", "enum": [true]}))
        .expect("valid authenticated result schema")
}

fn anonymous_schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
    serde_json::from_value(serde_json::json!({"type": "boolean", "enum": [false]}))
        .expect("valid anonymous result schema")
}

#[cfg(test)]
mod tests;

#[derive(Serialize, ToSchema)]
pub struct EmptyResult {}
