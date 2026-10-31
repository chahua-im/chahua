use serde::Serialize;
use serde_json::{Number, Value};

use super::error::{RpcError, RpcErrorCode};

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(untagged)]
pub enum RpcId {
    String(String),
    Number(Number),
    Null,
}

impl RpcId {
    pub(crate) fn from_value(value: Value) -> Option<Self> {
        match value {
            Value::Null => Some(Self::Null),
            Value::String(value) => Some(Self::String(value)),
            Value::Number(value) => {
                // Numeric IDs denote values, not spellings: 1 and 1.0 cannot
                // become two simultaneously outstanding calls to the same client.
                let value = if value.is_f64() {
                    let number = value.as_f64()?;
                    if number.fract() == 0.0
                        && (-9_223_372_036_854_775_808.0..9_223_372_036_854_775_808.0)
                            .contains(&number)
                    {
                        Number::from(number as i64)
                    } else if number.fract() == 0.0
                        && (0.0..18_446_744_073_709_551_616.0).contains(&number)
                    {
                        Number::from(number as u64)
                    } else {
                        value
                    }
                } else {
                    value
                };
                Some(Self::Number(value))
            }
            _ => None,
        }
    }
}

#[derive(Debug)]
pub struct RpcCall {
    /// None denotes a notification; Some(Null) is a request that needs a reply.
    pub id: Option<RpcId>,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Debug)]
pub enum RpcItem {
    Call(RpcCall),
    Invalid(RpcResponse),
    /// Responses are never answered, including unknown response IDs.
    Response,
}

#[derive(Debug)]
pub enum RpcMessage {
    Single(RpcItem),
    Batch(Vec<RpcItem>),
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum RpcOutcome {
    Success { result: Value },
    Failure { error: RpcError },
}

#[derive(Debug, Serialize)]
pub struct RpcResponse {
    jsonrpc: &'static str,
    pub id: RpcId,
    #[serde(flatten)]
    pub outcome: RpcOutcome,
}

impl RpcResponse {
    pub fn success(id: RpcId, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            outcome: RpcOutcome::Success { result },
        }
    }

    pub fn error(id: RpcId, error: RpcError) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            outcome: RpcOutcome::Failure { error },
        }
    }

    pub fn invalid_request() -> Self {
        Self::error(RpcId::Null, RpcError::new(RpcErrorCode::InvalidRequest))
    }

    pub(crate) fn lifecycle_failure(&self) -> Option<super::error::RpcLifecycleFailure> {
        match &self.outcome {
            RpcOutcome::Success { .. } => None,
            RpcOutcome::Failure { error } => error.lifecycle_failure(),
        }
    }
}

pub fn parse_message(text: &str, max_batch_items: usize) -> Result<RpcMessage, RpcResponse> {
    let value = serde_json::from_str::<Value>(text)
        .map_err(|_| RpcResponse::error(RpcId::Null, RpcError::new(RpcErrorCode::ParseError)))?;
    match value {
        Value::Array(items) => {
            if items.is_empty() || items.len() > max_batch_items {
                return Err(RpcResponse::invalid_request());
            }
            Ok(RpcMessage::Batch(
                items.into_iter().map(parse_item).collect(),
            ))
        }
        value => Ok(RpcMessage::Single(parse_item(value))),
    }
}

fn parse_item(value: Value) -> RpcItem {
    let Value::Object(mut object) = value else {
        return RpcItem::Invalid(RpcResponse::invalid_request());
    };
    if !object.contains_key("method")
        && (object.contains_key("result") || object.contains_key("error"))
    {
        return RpcItem::Response;
    }
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return RpcItem::Invalid(RpcResponse::invalid_request());
    }
    let Some(Value::String(method)) = object.remove("method") else {
        return RpcItem::Invalid(RpcResponse::invalid_request());
    };
    let id = match object.remove("id") {
        Some(value) => match RpcId::from_value(value) {
            Some(id) => Some(id),
            None => return RpcItem::Invalid(RpcResponse::invalid_request()),
        },
        None => None,
    };
    RpcItem::Call(RpcCall {
        id,
        method,
        params: object.remove("params"),
    })
}

pub fn decode_params<T: serde::de::DeserializeOwned>(params: Option<Value>) -> Result<T, RpcError> {
    let params = match params {
        None => Value::Object(Default::default()),
        Some(Value::Object(object)) => Value::Object(object),
        Some(_) => return Err(RpcError::new(RpcErrorCode::InvalidParams)),
    };
    serde_json::from_value(params).map_err(|_| RpcError::new(RpcErrorCode::InvalidParams))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(text: &str) -> RpcCall {
        match parse_message(text, 32).unwrap() {
            RpcMessage::Single(RpcItem::Call(call)) => call,
            _ => panic!("expected a single call"),
        }
    }

    #[test]
    fn omitted_and_null_ids_have_distinct_reply_semantics() {
        assert_eq!(call(r#"{"jsonrpc":"2.0","method":"users.getMe"}"#).id, None);
        assert_eq!(
            call(r#"{"jsonrpc":"2.0","method":"users.getMe","id":null}"#).id,
            Some(RpcId::Null)
        );
        for (wire, id) in [
            (json!("7"), RpcId::String("7".into())),
            (json!(7), RpcId::Number(7.into())),
        ] {
            let text = json!({"jsonrpc":"2.0","method":"users.getMe","id":wire}).to_string();
            assert_eq!(call(&text).id, Some(id));
        }
    }

    #[test]
    fn numeric_equivalent_ids_cannot_bypass_outstanding_id_detection() {
        assert_eq!(
            call(r#"{"jsonrpc":"2.0","method":"x","id":1}"#).id,
            call(r#"{"jsonrpc":"2.0","method":"x","id":1.0}"#).id
        );
    }

    #[test]
    fn malformed_json_and_invalid_envelopes_have_distinct_errors() {
        let parse_error = parse_message("{", 32).unwrap_err();
        assert_eq!(
            serde_json::to_value(parse_error).unwrap()["error"]["code"],
            -32700
        );
        for value in [
            json!(null),
            json!(1),
            json!({"method":"x"}),
            json!({"jsonrpc":"2.0","method":1}),
            json!({"jsonrpc":"2.0","method":"x","id":false}),
        ] {
            let RpcMessage::Single(RpcItem::Invalid(response)) =
                parse_message(&value.to_string(), 32).unwrap()
            else {
                panic!("expected invalid request")
            };
            assert_eq!(
                serde_json::to_value(response).unwrap(),
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}})
            );
        }
    }

    #[test]
    fn batches_keep_per_item_errors_and_reject_invalid_batch_sizes() {
        assert!(parse_message("[]", 32).is_err());
        assert!(parse_message(
            &serde_json::to_string(&vec![json!({"jsonrpc":"2.0","method":"x"}); 33]).unwrap(),
            32
        )
        .is_err());
        let RpcMessage::Batch(items) = parse_message(
            r#"[1,{"jsonrpc":"2.0","method":"x"},{"jsonrpc":"2.0","id":1,"result":null}]"#,
            32,
        )
        .unwrap() else {
            panic!("expected batch")
        };
        assert!(matches!(&items[0], RpcItem::Invalid(_)));
        assert!(matches!(&items[1], RpcItem::Call(RpcCall { id: None, .. })));
        assert!(matches!(&items[2], RpcItem::Response));
    }

    #[test]
    fn only_named_params_are_decoded_and_null_results_are_explicit() {
        #[derive(serde::Deserialize)]
        struct Empty {}
        assert!(decode_params::<Empty>(None).is_ok());
        assert!(decode_params::<Empty>(Some(json!({}))).is_ok());
        for value in [json!(null), json!([]), json!("value"), json!(false)] {
            assert_eq!(
                decode_params::<Empty>(Some(value)).err().unwrap().code,
                RpcErrorCode::InvalidParams
            );
        }
        assert_eq!(
            serde_json::to_value(RpcResponse::success(RpcId::Null, Value::Null)).unwrap(),
            json!({"jsonrpc":"2.0","id":null,"result":null})
        );
    }

    #[test]
    fn flat_update_params_preserve_lossless_ids_and_explicit_clears() {
        use crate::dto::rpc::{groups::GroupsUpdateParams, invites::InvitesUpdateParams};
        let omitted =
            decode_params::<GroupsUpdateParams>(Some(json!({"chatId": "9007199254740993"})))
                .unwrap();
        let cleared = decode_params::<GroupsUpdateParams>(Some(
            json!({"chatId": "9007199254740993", "avatarImageId": null}),
        ))
        .unwrap();
        assert_eq!(omitted.chat_id, 9_007_199_254_740_993);
        assert_eq!(omitted.body.avatar_image_id, None);
        assert_eq!(cleared.body.avatar_image_id, Some(None));
        let cleared_expiry = decode_params::<InvitesUpdateParams>(Some(
            json!({"inviteId": "9223372036854775807", "expiresAt": null}),
        ))
        .unwrap();
        assert_eq!(cleared_expiry.invite_id, i64::MAX);
        assert_eq!(cleared_expiry.body.expires_at, Some(None));
        for params in [
            json!({"chatId": 42}),
            json!({"chatId": "invalid"}),
            json!({"path": {"chatId": "42"}}),
        ] {
            assert_eq!(
                decode_params::<GroupsUpdateParams>(Some(params))
                    .err()
                    .unwrap()
                    .code,
                RpcErrorCode::InvalidParams
            );
        }
    }
}
