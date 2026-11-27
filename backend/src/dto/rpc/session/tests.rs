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
        serde_json::to_value(SessionOpenResult::authenticated(&session, None)).unwrap();
    let anonymous = serde_json::to_value(SessionOpenResult::anonymous()).unwrap();
    assert_eq!(
        serde_json::to_value(SessionOpenResult::authenticated(&session, Some(1))).unwrap(),
        json!({"protocolVersion": 1, "authenticated": true, "uid": 7, "clientId": "client-7", "messageSync": 1})
    );
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
        for key in wire.as_object().unwrap().keys() {
            assert!(declared.contains_key(key));
        }
        let required = variant["required"].as_array().unwrap();
        assert_eq!(required.len(), wire.as_object().unwrap().len());
        assert!(!required.iter().any(|key| key == "messageSync"));
        assert_eq!(
            declared["authenticated"]["enum"],
            Value::Array(vec![wire["authenticated"].clone()])
        );
    }
}
