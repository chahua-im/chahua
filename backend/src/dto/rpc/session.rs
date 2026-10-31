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
    },
    Anonymous {
        #[serde(rename = "protocolVersion")]
        protocol_version: u8,
        #[schema(schema_with = anonymous_schema)]
        authenticated: bool,
    },
}

impl SessionOpenResult {
    pub fn authenticated(session: &VerifiedSession) -> Self {
        Self::Authenticated {
            protocol_version: 1,
            authenticated: true,
            uid: session.uid,
            client_id: session.client_id.clone(),
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
mod tests {
    use super::*;
    use crate::services::auth_token::TokenVersion;
    use serde_json::{json, Value};

    #[test]
    fn handshake_union_schema_matches_both_wire_shapes() {
        let session = VerifiedSession {
            uid: 7,
            client_id: "client-7".into(),
            generation: 0,
            version: TokenVersion::V2,
        };
        let authenticated =
            serde_json::to_value(SessionOpenResult::authenticated(&session)).unwrap();
        let anonymous = serde_json::to_value(SessionOpenResult::anonymous()).unwrap();
        assert_eq!(
            authenticated,
            json!({"protocolVersion": 1, "authenticated": true, "uid": 7, "clientId": "client-7"})
        );
        assert_eq!(
            anonymous,
            json!({"protocolVersion": 1, "authenticated": false})
        );
        let schema =
            serde_json::to_value(<SessionOpenResult as utoipa::PartialSchema>::schema()).unwrap();
        for (index, wire) in [authenticated, anonymous].into_iter().enumerate() {
            let variant = &schema["oneOf"][index];
            let declared = variant["properties"].as_object().unwrap();
            assert_eq!(
                wire.as_object().unwrap().keys().collect::<Vec<_>>(),
                declared.keys().collect::<Vec<_>>()
            );
            assert_eq!(
                variant["required"].as_array().unwrap().len(),
                declared.len()
            );
            assert_eq!(
                declared["authenticated"]["enum"],
                Value::Array(vec![wire["authenticated"].clone()])
            );
        }
    }
}
