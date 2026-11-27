use super::*;

#[test]
fn projection_flattens_objects_and_preserves_explicit_null() {
    let components = BTreeMap::from([(
        "Base".to_owned(),
        json!({"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}),
    )]);
    let schema = json!({
        "allOf": [{"$ref": "#/components/schemas/Base"}],
        "type": "object",
        "properties": {"name": {"type": "string", "nullable": true}},
        "required": ["name"],
        "discriminator": {"propertyName": "kind"},
    });
    assert_eq!(
        project_schema(&schema, &components, &mut Vec::new()).unwrap(),
        json!({
            "type": "object",
            "properties": {"name": {"type": ["string", "null"]}, "id": {"type": "string"}},
            "required": ["name", "id"],
        })
    );
}

#[test]
fn conflicting_flattened_properties_are_rejected() {
    let components = BTreeMap::from([(
        "Base".to_owned(),
        json!({"type": "object", "properties": {"id": {"type": "integer"}}}),
    )]);
    let schema = json!({
        "allOf": [{"$ref": "#/components/schemas/Base"}],
        "properties": {"id": {"type": "string"}},
    });
    assert!(project_schema(&schema, &components, &mut Vec::new()).is_err());
}

#[test]
fn references_must_resolve_to_components() {
    let document = json!({
        "components": {"schemas": {"Thing": {"$ref": "#/components/schemas/Missing"}}}
    });
    assert!(validate_references(&document).is_err());
}

#[test]
fn conflicting_component_definitions_are_rejected() {
    let mut components = BTreeMap::new();
    merge_component(
        &mut components,
        "Thing".to_owned(),
        json!({"type": "string"}),
    )
    .unwrap();
    assert!(merge_component(
        &mut components,
        "Thing".to_owned(),
        json!({"type": "integer"})
    )
    .is_err());
}

#[test]
fn events_publish_flat_payload_descriptors_and_session_lifecycle() {
    let document = try_openrpc_document().unwrap();
    let events = document["x-events"].as_array().unwrap();
    let names = events
        .iter()
        .map(|event| event["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(names.contains(&"events.presenceUpdate"));
    assert!(names.contains(&"session.invalidated"));
    assert!(names.contains(&"session.unavailable"));

    let presence = events
        .iter()
        .find(|event| event["name"] == "events.presenceUpdate")
        .unwrap();
    assert_eq!(
        presence["x-params-schema"],
        json!({"$ref": "#/components/schemas/PresenceUpdatePayload"})
    );
    assert_eq!(
        presence["params"],
        json!([{
            "name": "activeConnections",
            "required": true,
            "schema": {"type": "integer", "format": "int32", "minimum": 0}
        }])
    );
}
#[test]
fn error_descriptors_publish_every_protocol_code() {
    let descriptors = error_descriptors();
    assert_eq!(descriptors.len(), RpcErrorCode::ALL.len());
    assert_eq!(
        descriptors,
        vec![
            json!({"code": -32700, "message": "Parse error"}),
            json!({"code": -32600, "message": "Invalid Request"}),
            json!({"code": -32601, "message": "Method not found"}),
            json!({"code": -32602, "message": "Invalid params"}),
            json!({"code": -32603, "message": "Internal error"}),
            json!({"code": 1000, "message": "Bad request"}),
            json!({"code": 1001, "message": "Unauthorized"}),
            json!({"code": 1003, "message": "Forbidden"}),
            json!({"code": 1004, "message": "Not found"}),
            json!({"code": 1009, "message": "Conflict"}),
            json!({"code": 1010, "message": "Gone"}),
            json!({"code": 1013, "message": "Payload too large"}),
            json!({"code": 1103, "message": "Speaking is restricted"}),
            json!({"code": 1503, "message": "Service unavailable"}),
            json!({"code": 1500, "message": "Internal error"}),
            json!({"code": 1429, "message": "Too many requests"}),
        ]
    );
}
