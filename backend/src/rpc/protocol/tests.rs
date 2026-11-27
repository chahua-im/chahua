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
        decode_params::<GroupsUpdateParams>(Some(json!({"chatId": "9007199254740993"}))).unwrap();
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
