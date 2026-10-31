use std::collections::BTreeMap;

use serde_json::{json, Map, Value};
use utoipa::openapi::RefOr;

use crate::rpc::error::RpcErrorCode;
use crate::rpc::methods::{self, ExecutionClass, SchemaSet};

const OPENRPC_VERSION: &str = "1.4.0";
const SCHEMA_REF_PREFIX: &str = "#/components/schemas/";

/// Builds the config-free OpenRPC document served by the API and written by the
/// schema export command. The method registry is its only method source.
pub fn openrpc_document() -> Value {
    try_openrpc_document().expect("RPC schema registry must produce a valid OpenRPC document")
}

fn try_openrpc_document() -> Result<Value, String> {
    let mut components = BTreeMap::new();
    let mut methods = Vec::with_capacity(methods::method_metadata().len());

    for metadata in methods::method_metadata() {
        let params = (metadata.params)();
        let result = (metadata.result)();
        merge_schema_set(&mut components, &params)?;
        merge_schema_set(&mut components, &result)?;

        methods.push((metadata, params, result));
    }

    for (name, schema) in crate::rpc::events::event_schemas() {
        merge_component(&mut components, name, schema_to_value(&schema)?)?;
    }

    crate::openapi::apply_snowflake_component_markers(&mut components);
    merge_http_components(&mut components)?;

    let mut projected_components = BTreeMap::new();
    for (name, schema) in &components {
        projected_components.insert(
            name.clone(),
            project_schema(schema, &components, &mut Vec::new())?,
        );
    }

    let mut method_values = Vec::with_capacity(methods.len());
    for (metadata, params, result) in methods {
        let params_schema = schema_set_document_schema(&params, &components)?;
        let result_schema = schema_set_document_schema(&result, &components)?;
        method_values.push(method_document(
            metadata.name,
            metadata.execution_class,
            params_schema,
            result_schema,
            &projected_components,
        )?);
    }

    let errors = RpcErrorCode::ALL
        .iter()
        .map(|code| {
            json!({
                "name": code.name(),
                "code": *code as i32,
                "message": code.message(),
            })
        })
        .collect::<Vec<_>>();

    let events = project_events(
        crate::rpc::events::event_descriptors(),
        &projected_components,
    )?;

    let document = json!({
        "openrpc": OPENRPC_VERSION,
        "info": {
            "title": "Wetty Chat RPC API",
            "version": "0.1.0",
            "description": "Transport-independent JSON-RPC API for Wetty Chat.",
            "license": {"name": "GPL-3.0", "url": "https://www.gnu.org/licenses/gpl-3.0.html"},
        },
        "methods": method_values,
        "components": {"schemas": projected_components},
        "x-error-codes": errors,
        "x-events": events,
    });

    validate_references(&document)?;
    Ok(document)
}

fn method_document(
    name: &str,
    execution_class: ExecutionClass,
    params_schema: Value,
    result_schema: Value,
    components: &BTreeMap<String, Value>,
) -> Result<Value, String> {
    let descriptors = object_descriptors(&params_schema, components, name)?;

    Ok(json!({
        "name": name,
        "paramStructure": "by-name",
        "params": descriptors,
        "x-params-schema": params_schema,
        "result": {"name": "result", "schema": result_schema},
        "errors": error_descriptors(),
        "x-execution-class": execution_class_name(execution_class),
    }))
}

fn error_descriptors() -> Vec<Value> {
    RpcErrorCode::ALL
        .iter()
        .map(|code| json!({"code": *code as i32, "message": code.message()}))
        .collect()
}

fn execution_class_name(class: ExecutionClass) -> &'static str {
    match class {
        ExecutionClass::Read => "read",
        ExecutionClass::Mutation => "mutation",
        ExecutionClass::Session => "session",
        ExecutionClass::Control => "control",
    }
}

fn project_events(events: Value, components: &BTreeMap<String, Value>) -> Result<Value, String> {
    let events = events
        .as_array()
        .ok_or_else(|| "event descriptors must be an array".to_owned())?;
    let mut projected = Vec::with_capacity(events.len());
    for event in events {
        let mut event = event.clone();
        let schema = event
            .get("x-params-schema")
            .ok_or_else(|| "event descriptor has no x-params-schema".to_owned())?;
        let schema = project_schema(schema, components, &mut Vec::new())?;
        let event_name = event
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| "event descriptor has no name".to_owned())?;
        event["params"] = Value::Array(object_descriptors(&schema, components, event_name)?);
        event["x-params-schema"] = schema;
        projected.push(event);
    }
    Ok(Value::Array(projected))
}

fn schema_set_document_schema(
    schema_set: &SchemaSet,
    components: &BTreeMap<String, Value>,
) -> Result<Value, String> {
    let root = schema_to_value(&schema_set.schema)?;
    if is_named_schema_set(schema_set)
        && is_component_root(&root)
        && components.contains_key(&schema_set.name)
    {
        return Ok(json!({"$ref": format!("{SCHEMA_REF_PREFIX}{}", schema_set.name)}));
    }
    project_schema(&root, components, &mut Vec::new())
}

fn object_descriptors(
    schema: &Value,
    components: &BTreeMap<String, Value>,
    owner: &str,
) -> Result<Vec<Value>, String> {
    let resolved = resolve_schema(schema, components)?;
    let empty_properties = Map::new();
    let properties = match resolved.get("properties") {
        Some(Value::Object(properties)) => properties,
        None if resolved.get("type").and_then(Value::as_str) == Some("object") => &empty_properties,
        _ => {
            return Err(format!(
                "RPC parameters for {owner} are not an object schema"
            ))
        }
    };
    let required = resolved
        .get("required")
        .and_then(Value::as_array)
        .map(|fields| {
            fields
                .iter()
                .map(|field| {
                    field.as_str().map(str::to_owned).ok_or_else(|| {
                        format!("non-string required field in RPC parameters for {owner}")
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();

    let mut descriptors = Vec::with_capacity(properties.len());
    for field in &required {
        let schema = properties
            .get(field)
            .ok_or_else(|| format!("required RPC parameter {field} is absent from {owner}"))?;
        descriptors.push(json!({"name": field, "required": true, "schema": schema}));
    }
    for (field, schema) in properties {
        if !required.contains(field) {
            descriptors.push(json!({"name": field, "required": false, "schema": schema}));
        }
    }
    Ok(descriptors)
}

fn merge_schema_set(
    components: &mut BTreeMap<String, Value>,
    schema_set: &SchemaSet,
) -> Result<(), String> {
    for (name, schema) in &schema_set.dependencies {
        merge_component(components, name.clone(), schema_to_value(schema)?)?;
    }

    let root = schema_to_value(&schema_set.schema)?;
    if !is_reference(&root) && is_named_schema_set(schema_set) && is_component_root(&root) {
        merge_component(components, schema_set.name.clone(), root)?;
    }
    Ok(())
}

fn is_named_schema_set(schema_set: &SchemaSet) -> bool {
    !matches!(
        schema_set.name.as_str(),
        "()" | "bool"
            | "i8"
            | "i16"
            | "i32"
            | "i64"
            | "u8"
            | "u16"
            | "u32"
            | "u64"
            | "f32"
            | "f64"
            | "String"
            | "str"
            | "Vec"
            | "Option"
            | "BTreeMap"
            | "HashMap"
    )
}

fn is_component_root(schema: &Value) -> bool {
    schema.as_object().is_some_and(|object| {
        object.get("type") == Some(&Value::String("object".to_owned()))
            || object.contains_key("properties")
            || object.contains_key("allOf")
            || object.contains_key("oneOf")
            || object.contains_key("anyOf")
            || object.contains_key("enum")
    })
}

fn schema_to_value(schema: &RefOr<utoipa::openapi::schema::Schema>) -> Result<Value, String> {
    serde_json::to_value(schema).map_err(|error| format!("serialize generated schema: {error}"))
}

fn merge_http_components(components: &mut BTreeMap<String, Value>) -> Result<(), String> {
    let document = serde_json::to_value(crate::openapi::document())
        .map_err(|error| format!("serialize shared OpenAPI components: {error}"))?;
    let schemas = document
        .pointer("/components/schemas")
        .and_then(Value::as_object)
        .ok_or_else(|| "shared OpenAPI document has no schema components".to_owned())?;
    for (name, schema) in schemas {
        merge_component(components, name.clone(), schema.clone())?;
    }
    Ok(())
}

fn merge_component(
    components: &mut BTreeMap<String, Value>,
    name: String,
    schema: Value,
) -> Result<(), String> {
    match components.get(&name) {
        Some(existing) if existing == &schema => Ok(()),
        Some(_) => Err(format!("conflicting generated schema component: {name}")),
        None => {
            components.insert(name, schema);
            Ok(())
        }
    }
}

fn project_schema(
    schema: &Value,
    components: &BTreeMap<String, Value>,
    stack: &mut Vec<String>,
) -> Result<Value, String> {
    let mut projected = match schema {
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| project_schema(value, components, stack))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        Value::Object(object) => {
            let mut output = Map::new();
            for (key, value) in object {
                if key != "nullable" && key != "discriminator" {
                    output.insert(key.clone(), project_schema(value, components, stack)?);
                }
            }
            Value::Object(output)
        }
        scalar => scalar.clone(),
    };

    if schema.get("nullable") == Some(&Value::Bool(true)) {
        projected = add_explicit_null(projected);
    }

    flatten_all_of(projected, components, stack)
}

fn add_explicit_null(mut schema: Value) -> Value {
    if !schema.is_object() {
        return json!({"anyOf": [schema, {"type": "null"}]});
    }

    match schema.get("type").cloned() {
        Some(Value::String(kind)) if kind != "null" => {
            schema
                .as_object_mut()
                .expect("schema is an object")
                .insert("type".to_owned(), json!([kind, "null"]));
            schema
        }
        Some(Value::Array(mut kinds)) => {
            if !kinds.iter().any(|kind| kind == "null") {
                kinds.push(Value::String("null".to_owned()));
            }
            schema
                .as_object_mut()
                .expect("schema is an object")
                .insert("type".to_owned(), Value::Array(kinds));
            schema
        }
        Some(_) | None => json!({"anyOf": [schema, {"type": "null"}]}),
    }
}

fn flatten_all_of(
    schema: Value,
    components: &BTreeMap<String, Value>,
    stack: &mut Vec<String>,
) -> Result<Value, String> {
    let Value::Object(mut object) = schema else {
        return Ok(schema);
    };
    let Some(Value::Array(parts)) = object.remove("allOf") else {
        return Ok(Value::Object(object));
    };

    let mut flattened_parts = Vec::with_capacity(parts.len());
    for part in parts {
        flattened_parts.push(resolve_and_project(&part, components, stack)?);
    }
    if !flattened_parts.iter().all(is_object_schema) {
        object.insert("allOf".to_owned(), Value::Array(flattened_parts));
        return Ok(Value::Object(object));
    }

    for part in flattened_parts {
        merge_object_schema(&mut object, part)?;
    }
    Ok(Value::Object(object))
}

fn resolve_and_project(
    schema: &Value,
    components: &BTreeMap<String, Value>,
    stack: &mut Vec<String>,
) -> Result<Value, String> {
    if let Some(name) = component_reference(schema) {
        if stack.iter().any(|current| current == name) {
            return Err(format!("cyclic allOf schema reference: {name}"));
        }
        let source = components
            .get(name)
            .ok_or_else(|| format!("unresolved generated schema reference: {name}"))?;
        stack.push(name.to_owned());
        let output = project_schema(source, components, stack)?;
        stack.pop();
        Ok(output)
    } else {
        project_schema(schema, components, stack)
    }
}

fn is_object_schema(schema: &Value) -> bool {
    schema.as_object().is_some_and(|object| {
        object.contains_key("properties")
            || object.get("type") == Some(&Value::String("object".to_owned()))
    })
}

fn merge_object_schema(target: &mut Map<String, Value>, source: Value) -> Result<(), String> {
    let Value::Object(source) = source else {
        return Ok(());
    };

    if let Some(Value::Object(properties)) = source.get("properties") {
        let target_properties = target
            .entry("properties")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .expect("object schema properties are an object");
        for (name, property) in properties {
            match target_properties.get(name) {
                Some(existing) if existing == property => {}
                Some(_) => return Err(format!("conflicting flattened property schema: {name}")),
                None => {
                    target_properties.insert(name.clone(), property.clone());
                }
            }
        }
    }

    let mut required = target
        .remove("required")
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    if let Some(source_required) = source.get("required").and_then(Value::as_array) {
        for field in source_required {
            if !required.contains(field) {
                required.push(field.clone());
            }
        }
    }
    if !required.is_empty() {
        target.insert("required".to_owned(), Value::Array(required));
    }

    for (key, value) in source {
        if matches!(
            key.as_str(),
            "properties" | "required" | "title" | "description"
        ) {
            continue;
        }
        target.entry(key).or_insert(value);
    }
    Ok(())
}

fn resolve_schema<'a>(
    schema: &'a Value,
    components: &'a BTreeMap<String, Value>,
) -> Result<&'a Value, String> {
    if let Some(name) = component_reference(schema) {
        components
            .get(name)
            .ok_or_else(|| format!("unresolved generated schema reference: {name}"))
    } else {
        Ok(schema)
    }
}

fn component_reference(schema: &Value) -> Option<&str> {
    schema
        .get("$ref")
        .and_then(Value::as_str)
        .and_then(|reference| reference.strip_prefix(SCHEMA_REF_PREFIX))
}

fn is_reference(schema: &Value) -> bool {
    schema.get("$ref").is_some()
}

fn validate_references(document: &Value) -> Result<(), String> {
    fn walk(value: &Value, components: &BTreeMap<String, Value>) -> Result<(), String> {
        match value {
            Value::Array(values) => {
                for value in values {
                    walk(value, components)?;
                }
            }
            Value::Object(object) => {
                if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
                    let name = reference
                        .strip_prefix(SCHEMA_REF_PREFIX)
                        .ok_or_else(|| format!("unsupported schema reference: {reference}"))?;
                    if !components.contains_key(name) {
                        return Err(format!("unresolved schema reference: {reference}"));
                    }
                }
                for value in object.values() {
                    walk(value, components)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    let schemas = document
        .pointer("/components/schemas")
        .and_then(Value::as_object)
        .ok_or_else(|| "OpenRPC document has no schema components".to_owned())?;
    let components = schemas
        .iter()
        .map(|(name, schema)| (name.clone(), schema.clone()))
        .collect::<BTreeMap<_, _>>();
    for (name, schema) in &components {
        if component_reference(schema) == Some(name.as_str()) {
            return Err(format!("component {name} is only a self reference"));
        }
    }
    walk(document, &components)
}

#[cfg(test)]
mod tests {
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
}
