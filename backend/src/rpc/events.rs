use crate::dto::rpc::notifications::{
    SessionInvalidatedNotification, SessionNotification, SessionUnavailableNotification,
};
use crate::dto::ws::ServerWsMessage;
use serde::Serialize;
use serde_json::{json, Value};
use utoipa::openapi::{schema::Schema, RefOr};
use utoipa::ToSchema;

#[derive(Serialize)]
struct RpcNotification<'a, P: Serialize + ?Sized> {
    jsonrpc: &'static str,
    method: &'static str,
    params: &'a P,
}

fn encode_notification<P: Serialize + ?Sized>(
    method: &'static str,
    params: &P,
) -> Result<String, serde_json::Error> {
    serde_json::to_string(&RpcNotification {
        jsonrpc: "2.0",
        method,
        params,
    })
}

/// Encodes a legacy server event as an RPC notification without serializing the
/// legacy `{type, payload}` envelope or cloning its payload.
pub fn encode_event(message: &ServerWsMessage) -> Result<String, serde_json::Error> {
    macro_rules! encode_server_event {
        ($($(#[$doc:meta])* $variant:ident($payload:ty) => $message_type:literal,)*) => {
            match message {
                $(ServerWsMessage::$variant(payload) => {
                    encode_notification(concat!("events.", $message_type), payload)
                },)*
            }
        };
    }

    crate::dto::ws::server_ws_messages!(encode_server_event)
}

/// Encodes the typed session-lifecycle notifications that are not legacy
/// WebSocket events.
pub fn encode_session_notification(
    notification: &SessionNotification,
) -> Result<String, serde_json::Error> {
    match notification {
        SessionNotification::Invalidated { reason } => encode_notification(
            notification.method(),
            &SessionInvalidatedNotification { reason: *reason },
        ),
        SessionNotification::Unavailable { reason } => encode_notification(
            notification.method(),
            &SessionUnavailableNotification { reason: *reason },
        ),
    }
}

fn schema_for<T: ToSchema>() -> Value {
    json!({"$ref": format!("#/components/schemas/{}", T::name())})
}

fn append_schemas<T: ToSchema>(schemas: &mut Vec<(String, RefOr<Schema>)>) {
    schemas.push((T::name().into_owned(), T::schema()));
    T::schemas(schemas);
}

fn deduplicate_schemas(schemas: Vec<(String, RefOr<Schema>)>) -> Vec<(String, RefOr<Schema>)> {
    let mut unique = Vec::new();
    for (name, schema) in schemas {
        if let Some((_, existing)) = unique
            .iter_mut()
            .find(|(existing_name, _)| existing_name == &name)
        {
            if matches!(existing, RefOr::Ref(_)) && !matches!(schema, RefOr::Ref(_)) {
                *existing = schema;
            }
        } else {
            unique.push((name, schema));
        }
    }
    unique
}

/// Schema components for every RPC notification payload, including transitive
/// components required by those payload schemas.
pub fn event_schemas() -> Vec<(String, RefOr<Schema>)> {
    let mut schemas = Vec::new();

    macro_rules! append_server_event_schemas {
        ($($(#[$doc:meta])* $variant:ident($payload:ty) => $message_type:literal,)*) => {
            $(append_schemas::<$payload>(&mut schemas);)*
        };
    }

    crate::dto::ws::server_ws_messages!(append_server_event_schemas);
    append_schemas::<SessionInvalidatedNotification>(&mut schemas);
    append_schemas::<SessionUnavailableNotification>(&mut schemas);
    deduplicate_schemas(schemas)
}

/// OpenRPC extension descriptors for server notifications. Notification params
/// are their payload object directly, so `x-params-schema` is authoritative
/// rather than an artificial nested `payload` parameter.
pub fn event_descriptors() -> Value {
    let mut events = Vec::new();

    macro_rules! append_server_event_descriptors {
        ($($(#[$doc:meta])* $variant:ident($payload:ty) => $message_type:literal,)*) => {
            $(events.push(json!({
                "name": concat!("events.", $message_type),
                "params": [],
                "x-params-schema": schema_for::<$payload>(),
            }));)*
        };
    }

    crate::dto::ws::server_ws_messages!(append_server_event_descriptors);
    events.push(json!({
        "name": "session.invalidated",
        "params": [],
        "x-params-schema": schema_for::<SessionInvalidatedNotification>(),
    }));
    events.push(json!({
        "name": "session.unavailable",
        "params": [],
        "x-params-schema": schema_for::<SessionUnavailableNotification>(),
    }));
    Value::Array(events)
}

#[cfg(test)]
mod tests {
    use super::{encode_event, encode_session_notification};
    use crate::dto::rpc::notifications::{
        SessionInvalidatedReason, SessionNotification, SessionUnavailableReason,
    };
    use crate::dto::ws::{PresenceUpdatePayload, ServerWsMessage};
    use serde_json::json;

    #[test]
    fn encodes_legacy_events_with_their_flat_payload() {
        let encoded = encode_event(&ServerWsMessage::PresenceUpdate(PresenceUpdatePayload {
            active_connections: 3,
        }))
        .expect("encode event");

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&encoded).expect("event JSON"),
            json!({
                "jsonrpc": "2.0",
                "method": "events.presenceUpdate",
                "params": {"activeConnections": 3},
            })
        );
    }

    #[test]
    fn encodes_safe_session_lifecycle_reasons() {
        let invalidated = encode_session_notification(&SessionNotification::Invalidated {
            reason: SessionInvalidatedReason::Revoked,
        })
        .expect("encode invalidated");
        let unavailable = encode_session_notification(&SessionNotification::Unavailable {
            reason: SessionUnavailableReason::AuthLookupUnavailable,
        })
        .expect("encode unavailable");

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&invalidated).expect("invalidated JSON"),
            json!({"jsonrpc":"2.0","method":"session.invalidated","params":{"reason":"revoked"}})
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&unavailable).expect("unavailable JSON"),
            json!({"jsonrpc":"2.0","method":"session.unavailable","params":{"reason":"authLookupUnavailable"}})
        );
    }
}
