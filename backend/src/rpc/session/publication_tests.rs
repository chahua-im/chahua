use diesel::prelude::*;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};

use super::{rpc_session_channels, serve_rpc_session, RpcSessionTransport};
use crate::dto::ws::ServerWsMessage;

async fn request(
    transport: &mut RpcSessionTransport,
    id: &str,
    method: &str,
    params: Value,
) -> Value {
    let response = response(transport, id, method, params).await;
    assert!(
        response.get("error").is_none(),
        "{method}: {:?}",
        response["error"]
    );
    response["result"].clone()
}

async fn response(
    transport: &mut RpcSessionTransport,
    id: &str,
    method: &str,
    params: Value,
) -> Value {
    transport
        .input
        .send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string())
        .await
        .unwrap();
    timeout(Duration::from_secs(10), async {
        loop {
            let frame = transport.output.recv().await.expect("session response");
            let (text, _lease) = frame.into_parts();
            let response: Value = serde_json::from_str(&text).unwrap();
            if response["id"] == id {
                return response;
            }
        }
    })
    .await
    .expect("response deadline")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn committed_mutation_publishes_once_when_peer_disconnects_before_consuming_response() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let token = services
        .auth_token_service
        .issue_session(1, &uuid::Uuid::new_v4().to_string(), 0)
        .unwrap();
    let (input, output, dependencies, mut transport) = rpc_session_channels(services.clone());
    let session = tokio::spawn(serve_rpc_session(input, output, dependencies));
    request(
        &mut transport,
        "open",
        "session.open",
        json!({"protocolVersion":1,"token":token}),
    )
    .await;
    let group = request(
        &mut transport,
        "group",
        "groups.create",
        json!({"name":"Publication regression"}),
    )
    .await;
    let chat_id = group["id"].as_str().unwrap().to_owned();
    let (observer, mut events) = services
        .ws_registry
        .register(1, "publication-observer".into());
    let client_id = uuid::Uuid::new_v4().to_string();
    let params = json!({"chatId":chat_id,"message":"Committed publication regression","messageType":"text","clientGeneratedId":client_id});
    transport
        .input
        .send(
            json!({"jsonrpc":"2.0","id":"write","method":"messages.send","params":params})
                .to_string(),
        )
        .await
        .unwrap();

    // Registry publication occurs after commit. Do not drain the transport's
    // result channel: the peer has not received this operation's response.
    let message_id = timeout(Duration::from_secs(10), async {
        loop {
            let event = events.recv().await.expect("registry publication");
            if let ServerWsMessage::Message(message) = event.as_ref() {
                if message.client_generated_id == client_id {
                    break message.id;
                }
            }
        }
    })
    .await
    .expect("post-commit publication deadline");
    transport.input.close();
    timeout(Duration::from_secs(5), session)
        .await
        .unwrap()
        .unwrap();
    {
        use crate::schema::messages::dsl;
        let count = dsl::messages
            .filter(dsl::client_generated_id.eq(&client_id))
            .count()
            .get_result::<i64>(&mut services.db.get().unwrap())
            .unwrap();
        assert_eq!(
            count, 1,
            "disconnect must not duplicate or roll back the committed object"
        );
    }
    assert_eq!(
        services.ws_registry.online_connections(1).len(),
        1,
        "only the observer remains registered"
    );

    let (input, output, dependencies, mut retry_transport) = rpc_session_channels(services.clone());
    let retry_session = tokio::spawn(serve_rpc_session(input, output, dependencies));
    request(
        &mut retry_transport,
        "reopen",
        "session.open",
        json!({"protocolVersion":1,"token":token}),
    )
    .await;
    let retried = request(&mut retry_transport, "retry", "messages.send", params).await;
    assert_eq!(retried["id"], message_id.to_string());
    tokio::time::sleep(Duration::from_millis(50)).await;
    while let Ok(event) = events.try_recv() {
        assert!(
            !matches!(event.as_ref(), ServerWsMessage::Message(message) if message.id == message_id),
            "idempotent retry must not republish the committed message"
        );
    }
    retry_transport.input.close();
    timeout(Duration::from_secs(5), retry_session)
        .await
        .unwrap()
        .unwrap();
    services.ws_registry.remove_connection(1, observer.conn_id);
    assert!(services.ws_registry.online_connections(1).is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn outbox_conflict_returns_the_accepted_copy_without_republication() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let token = services
        .auth_token_service
        .issue_session(1, &uuid::Uuid::new_v4().to_string(), 0)
        .unwrap();
    let (input, output, dependencies, mut transport) = rpc_session_channels(services.clone());
    let session = tokio::spawn(serve_rpc_session(input, output, dependencies));
    request(
        &mut transport,
        "open",
        "session.open",
        json!({"protocolVersion":1,"token":token}),
    )
    .await;
    let dest = request(
        &mut transport,
        "dest",
        "groups.create",
        json!({"name":"Outbox destination"}),
    )
    .await;
    let source = request(
        &mut transport,
        "source",
        "groups.create",
        json!({"name":"Outbox sources"}),
    )
    .await;
    let dest = &dest["id"];
    let source = &source["id"];
    let mut sources = Vec::new();
    for text in ["first", "second", "third"] {
        let message = request(
            &mut transport,
            text,
            "messages.send",
            json!({
                "chatId":source, "message":text, "messageType":"text",
                "clientGeneratedId":uuid::Uuid::new_v4().to_string()
            }),
        )
        .await;
        sources.push(message["id"].clone());
    }
    let root = request(
        &mut transport,
        "root",
        "messages.send",
        json!({
            "chatId":dest, "message":"Thread root", "messageType":"text",
            "clientGeneratedId":uuid::Uuid::new_v4().to_string()
        }),
    )
    .await;
    let (observer, mut events) = services
        .ws_registry
        .register(1, "outbox-conflict-observer".into());
    for (method, original, field, changed) in [
        (
            "messages.send",
            json!({"chatId":dest,"message":"accepted","messageType":"text"}),
            "message",
            json!("different"),
        ),
        (
            "messages.sendInThread",
            json!({"chatId":dest,"threadId":root["id"],"message":"accepted","messageType":"text"}),
            "message",
            json!("different"),
        ),
        (
            "messages.forwardOne",
            json!({"chatId":dest,"sourceChatId":source,"messageId":sources[0]}),
            "messageId",
            sources[1].clone(),
        ),
        (
            "messages.forward",
            json!({"chatId":dest,"sourceChatId":source,"messageIds":[sources[0],sources[1]]}),
            "messageIds",
            json!([sources[0], sources[2]]),
        ),
    ] {
        let client_id = uuid::Uuid::new_v4().to_string();
        let mut original = original;
        original["clientGeneratedId"] = json!(client_id);
        let accepted = request(&mut transport, "accepted", method, original.clone()).await;
        let identical = request(&mut transport, "identical", method, original.clone()).await;
        assert_eq!(identical["id"], accepted["id"], "{method}");
        let mut different = original;
        different[field] = changed;
        let conflict = response(&mut transport, "conflict", method, different.clone()).await;
        assert_eq!(conflict["error"]["code"], 1009, "{method}: {conflict}");
        let data = &conflict["error"]["data"];
        assert_eq!(data["code"], "clientGeneratedIdConflict", "{method}");
        for key in [
            "id",
            "clientGeneratedId",
            "sender",
            "chatId",
            "replyRootId",
            "message",
        ] {
            assert_eq!(
                data["existingMessage"][key], accepted[key],
                "{method}: {key}"
            );
        }

        use crate::schema::messages::dsl;
        assert_eq!(
            dsl::messages
                .filter(dsl::client_generated_id.eq(&client_id))
                .count()
                .get_result::<i64>(&mut services.db.get().unwrap())
                .unwrap(),
            1
        );
        let mut publications = 0;
        while let Ok(event) = events.try_recv() {
            if matches!(event.as_ref(), ServerWsMessage::Message(message) if message.client_generated_id == client_id)
            {
                publications += 1;
            }
        }
        assert_eq!(publications, 1, "{method}");

        if method == "messages.send" {
            different["chatId"] = source.clone();
            let wrong_chat =
                response(&mut transport, "wrong-chat", method, different.clone()).await;
            assert_eq!(wrong_chat["error"]["code"], 1009);
            assert!(wrong_chat["error"].get("data").is_none());
            different["chatId"] = dest.clone();
            different["threadId"] = root["id"].clone();
            let wrong_thread = response(
                &mut transport,
                "wrong-thread",
                "messages.sendInThread",
                different.clone(),
            )
            .await;
            assert_eq!(wrong_thread["error"]["code"], 1009);
            assert!(wrong_thread["error"].get("data").is_none());
            different.as_object_mut().unwrap().remove("threadId");
            request(
                &mut transport,
                "delete",
                "messages.delete",
                json!({"chatId":dest,"messageId":accepted["id"]}),
            )
            .await;
            let deleted = response(&mut transport, "deleted", method, different).await;
            let shell = &deleted["error"]["data"]["existingMessage"];
            assert_eq!(shell["id"], accepted["id"]);
            assert_eq!(shell["isDeleted"], true);
            assert_eq!(shell["message"], Value::Null);
            assert_eq!(shell["attachments"], json!([]));
            assert!(shell["metadata"].is_null());
        }
    }
    transport.input.close();
    timeout(Duration::from_secs(5), session)
        .await
        .unwrap()
        .unwrap();
    services.ws_registry.remove_connection(1, observer.conn_id);
}
