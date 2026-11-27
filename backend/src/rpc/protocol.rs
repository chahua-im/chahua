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
mod tests;
