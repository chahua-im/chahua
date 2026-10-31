use diesel::prelude::*;

use super::*;

async fn exchange(input: &RpcSessionInput, output: &mut RpcSessionOutput, request: Value) -> Value {
    input.send(request.to_string()).await.unwrap();
    receive_json(output).await
}

#[tokio::test]
async fn malformed_control_notifications_cannot_bypass_pending_control_bound() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let token = services
        .auth_token_service
        .issue_session(1, "control-notification-bound", 0)
        .unwrap();
    let (input, output, task) = open_authenticated(services.clone(), token).await;
    let notifications = (0..32)
        .map(|_| json!({"jsonrpc":"2.0","method":"session.ping","params":[]}))
        .collect::<Vec<_>>();
    input
        .send(serde_json::to_string(&notifications).unwrap())
        .await
        .unwrap();
    timeout(Duration::from_secs(1), task)
        .await
        .expect("control abuse closes instead of accumulating response waiters")
        .expect("session shuts down cleanly");
    assert!(services.ws_registry.online_connections(1).is_empty());
    drop(output);
}

#[tokio::test]
async fn pipelined_handshakes_bind_only_the_first_frame_identity_and_keep_conflicts_recoverable() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let first_token = services
        .auth_token_service
        .issue_session(1, "first-frame-client", 0)
        .unwrap();
    let second_token = services
        .auth_token_service
        .issue_session(2, "later-frame-client", 0)
        .unwrap();
    let (input_rx, output_tx, dependencies, transport) = rpc_session_channels(services.clone());
    let RpcSessionTransport { input, mut output } = transport;
    // Queue complete frames before the reader runs. Worker scheduling must not
    // let a later session.open select a different identity.
    for request in [
        json!({"jsonrpc":"2.0","id":"first","method":"session.open","params":{"protocolVersion":1,"token":first_token}}),
        json!({"jsonrpc":"2.0","id":"second","method":"session.open","params":{"protocolVersion":1,"token":second_token}}),
        json!({"jsonrpc":"2.0","id":"profile","method":"users.getMe","params":{}}),
    ] {
        input.send(request.to_string()).await.unwrap();
    }
    let task = tokio::spawn(serve_rpc_session(input_rx, output_tx, dependencies));
    let opened = receive_json(&mut output).await;
    assert_eq!(opened["id"], "first");
    assert_eq!(opened["result"]["uid"], 1);
    assert_eq!(opened["result"]["clientId"], "first-frame-client");
    let mut replies = HashMap::new();
    for _ in 0..2 {
        let reply = receive_json(&mut output).await;
        replies.insert(reply["id"].as_str().unwrap().to_owned(), reply);
    }
    assert_eq!(replies["second"]["error"]["code"], 1009);
    assert_eq!(replies["profile"]["result"]["uid"], 1);
    assert_eq!(services.auth_token_service.verifier_invocations(), 1);
    assert_eq!(services.ws_registry.online_connections(1).len(), 1);
    assert!(services.ws_registry.online_connections(2).is_empty());
    let ping = exchange(
        &input,
        &mut output,
        json!({"jsonrpc":"2.0","id":"still-bound","method":"session.ping"}),
    )
    .await;
    assert_eq!(ping["id"], "still-bound");
    assert_eq!(ping["result"], Value::Null);
    close_session(input, output, task).await;
    assert!(services.ws_registry.online_connections(1).is_empty());
}

#[tokio::test]
async fn already_closed_input_cannot_authenticate_or_admit_queued_mutations() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let before = crate::schema::groups::table
        .count()
        .get_result::<i64>(&mut services.db.get().unwrap())
        .unwrap();
    let token = services
        .auth_token_service
        .issue_session(1, "closed-before-reader", 0)
        .unwrap();
    let (input_rx, output_tx, dependencies, transport) = rpc_session_channels(services.clone());
    transport.input.send(json!({"jsonrpc":"2.0","id":"open","method":"session.open","params":{"protocolVersion":1,"token":token}}).to_string()).await.unwrap();
    transport.input.send(json!({"jsonrpc":"2.0","id":"create","method":"groups.create","params":{"name":"must not be admitted"}}).to_string()).await.unwrap();
    transport.input.close();
    timeout(
        Duration::from_secs(1),
        serve_rpc_session(input_rx, output_tx, dependencies),
    )
    .await
    .expect("preclosed session terminates immediately");
    assert_eq!(services.auth_token_service.verifier_invocations(), 0);
    assert!(services.ws_registry.online_connections(1).is_empty());
    let after = crate::schema::groups::table
        .count()
        .get_result::<i64>(&mut services.db.get().unwrap())
        .unwrap();
    assert_eq!(
        after, before,
        "queued mutations are not admitted after disconnect"
    );
}

#[tokio::test]
async fn anonymous_bootstrap_binds_known_identity_without_verifying_the_issued_credential() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let (input_rx, output_tx, dependencies, transport) = rpc_session_channels(services.clone());
    let task = tokio::spawn(serve_rpc_session(input_rx, output_tx, dependencies));
    let RpcSessionTransport { input, mut output } = transport;
    let opened = exchange(&input, &mut output, json!({"jsonrpc":"2.0","id":"anonymous","method":"session.open","params":{"protocolVersion":1}})).await;
    assert_eq!(
        opened["result"],
        json!({"protocolVersion":1,"authenticated":false})
    );
    assert!(services.ws_registry.online_connections(1).is_empty());
    let unauthorized = exchange(
        &input,
        &mut output,
        json!({"jsonrpc":"2.0","id":"anonymous-read","method":"users.getMe"}),
    )
    .await;
    assert_eq!(unauthorized["error"]["code"], 1001);
    let missing_client = exchange(&input, &mut output, json!({"jsonrpc":"2.0","id":"missing-client","method":"auth.createDevSession","params":{"uid":1}})).await;
    assert_eq!(missing_client["error"]["code"], 1000);
    let created = exchange(&input, &mut output, json!({"jsonrpc":"2.0","id":"bootstrap","method":"auth.createDevSession","params":{"uid":1,"clientId":"invalid/client id"}})).await;
    assert!(created["result"]["token"].is_string());
    let connections = services.ws_registry.online_connections(1);
    assert_eq!(connections.len(), 1);
    assert!(uuid::Uuid::parse_str(&connections[0].client_id).is_ok());
    let profile = exchange(
        &input,
        &mut output,
        json!({"jsonrpc":"2.0","id":"bound-read","method":"users.getMe"}),
    )
    .await;
    assert_eq!(profile["result"]["uid"], 1);
    let refreshed = exchange(
        &input,
        &mut output,
        json!({"jsonrpc":"2.0","id":"refresh","method":"auth.refresh"}),
    )
    .await;
    assert!(refreshed["result"]["token"].is_string());
    assert_eq!(
        services.auth_token_service.verifier_invocations(),
        0,
        "known development identity must not be signed then reverified"
    );
    close_session(input, output, task).await;
}

#[tokio::test]
async fn in_memory_transport_preserves_ids_notification_silence_and_batch_rejection_boundaries() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let token = services
        .auth_token_service
        .issue_session(1, "protocol-boundaries", 0)
        .unwrap();
    let (input, mut output, task) = open_authenticated(services.clone(), token).await;
    for id in [
        json!("string-id"),
        json!(0),
        json!(-9),
        json!(9_007_199_254_740_993_u64),
        Value::Null,
    ] {
        let reply = exchange(
            &input,
            &mut output,
            json!({"jsonrpc":"2.0","id":id,"method":"session.ping"}),
        )
        .await;
        assert!(reply.get("id").is_some());
        assert_eq!(reply["id"], id);
        assert_eq!(reply["result"], Value::Null);
    }
    for params in [Value::Null, json!([]), json!("positional")] {
        let reply = exchange(
            &input,
            &mut output,
            json!({"jsonrpc":"2.0","id":"bad-params","method":"users.getMe","params":params}),
        )
        .await;
        assert_eq!(reply["id"], "bad-params");
        assert_eq!(reply["error"]["code"], -32602);
    }
    for invalid in [
        json!(true),
        json!({"jsonrpc":"1.0","id":"bad-envelope","method":"session.ping"}),
        json!({"jsonrpc":"2.0","id":"missing-method"}),
    ] {
        let reply = exchange(&input, &mut output, invalid).await;
        assert_eq!(reply["id"], Value::Null);
        assert_eq!(reply["error"]["code"], -32600);
    }
    input
        .send(json!({"jsonrpc":"2.0","id":"unmatched","result":"must not be answered"}).to_string())
        .await
        .unwrap();
    input
        .send(json!({"jsonrpc":"2.0","method":"unknown.notification"}).to_string())
        .await
        .unwrap();
    input
        .send(
            json!([
                {"jsonrpc":"2.0","method":"session.ping"},
                {"jsonrpc":"2.0","method":"unknown.notification"},
            ])
            .to_string(),
        )
        .await
        .unwrap();
    let barrier = exchange(
        &input,
        &mut output,
        json!({"jsonrpc":"2.0","id":"notification-barrier","method":"session.ping"}),
    )
    .await;
    assert_eq!(
        barrier["id"], "notification-barrier",
        "notifications and incoming responses produce no reply"
    );
    let empty = exchange(&input, &mut output, json!([])).await;
    assert_eq!(empty["id"], Value::Null);
    assert_eq!(empty["error"]["code"], -32600);
    let before = crate::schema::groups::table
        .count()
        .get_result::<i64>(&mut services.db.get().unwrap())
        .unwrap();
    let oversized = (0..33).map(|id| json!({"jsonrpc":"2.0","id":id,"method":"groups.create","params":{"name":"must not execute"}})).collect::<Vec<_>>();
    let rejected = exchange(&input, &mut output, Value::Array(oversized)).await;
    assert_eq!(rejected["id"], Value::Null);
    assert_eq!(rejected["error"]["code"], -32600);
    let after = crate::schema::groups::table
        .count()
        .get_result::<i64>(&mut services.db.get().unwrap())
        .unwrap();
    assert_eq!(
        after, before,
        "oversized batch is rejected before any constituent mutation"
    );
    let mixed = exchange(
        &input,
        &mut output,
        json!([
            {"jsonrpc":"2.0","id":"ok","method":"session.ping"},
            {"jsonrpc":"2.0","id":"unknown","method":"unknown.method"},
            false,
            {"jsonrpc":"2.0","method":"session.ping"},
        ]),
    )
    .await;
    let responses = mixed.as_array().unwrap();
    assert_eq!(responses.len(), 3);
    assert!(responses
        .iter()
        .any(|reply| reply["id"] == "ok" && reply.get("result") == Some(&Value::Null)));
    assert!(responses
        .iter()
        .any(|reply| reply["id"] == "unknown" && reply["error"]["code"] == -32601));
    assert!(responses
        .iter()
        .any(|reply| reply["id"] == Value::Null && reply["error"]["code"] == -32600));
    close_session(input, output, task).await;
}
