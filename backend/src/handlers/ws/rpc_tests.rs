use std::{net::SocketAddr, time::Duration};

use axum::{middleware, routing::get, Router};
use diesel::{connection::SimpleConnection, prelude::*};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::{net::TcpListener, task::JoinHandle, time::timeout};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        protocol::frame::{
            coding::{CloseCode, Data, OpCode},
            Frame,
        },
        Message,
    },
    MaybeTlsStream, WebSocketStream,
};

use crate::AppState;

type Client = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct Server {
    address: SocketAddr,
    task: JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn router(services: &AppState) -> Router {
    let state = services.clone();
    Router::new()
        .route("/ws", get(super::ws_handler))
        .route("/activity-probe", get(|| async { "ok" }))
        .nest(
            "/friends",
            crate::handlers::friends::router().split_for_parts().0,
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            crate::services::client_tracking::track_client_activity,
        ))
        .with_state(state)
}

async fn server(services: &AppState) -> Server {
    let app = router(services);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    Server { address, task }
}

async fn connect(server: &Server, bearer: &str) -> Client {
    let mut request = format!("ws://{}/ws", server.address)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {bearer}").parse().unwrap());
    connect_async(request).await.unwrap().0
}

async fn send_sized_text(client: &mut Client, text: String, fragmented: bool, oversized: bool) {
    if fragmented {
        let bytes = text.into_bytes();
        let split = bytes.len() / 2;
        client
            .send(Message::Frame(Frame::message(
                bytes[..split].to_vec(),
                OpCode::Data(Data::Text),
                false,
            )))
            .await
            .unwrap();
        let result = client
            .send(Message::Frame(Frame::message(
                bytes[split..].to_vec(),
                OpCode::Data(Data::Continue),
                true,
            )))
            .await;
        if !oversized {
            result.unwrap();
        }
    } else {
        let result = client.send(Message::Text(text.into())).await;
        if !oversized {
            result.unwrap();
        }
    }
}

fn pad_to(mut text: String, size: usize) -> String {
    assert!(text.len() <= size);
    text.push_str(&" ".repeat(size - text.len()));
    text
}

async fn expect_too_big_close(client: &mut Client) {
    timeout(Duration::from_secs(10), async {
        loop {
            match client
                .next()
                .await
                .expect("close frame")
                .expect("valid WebSocket frame")
            {
                Message::Close(Some(frame)) => {
                    assert_eq!(frame.code, CloseCode::Size);
                    return;
                }
                Message::Text(text) => {
                    let event: Value = serde_json::from_str(&text).unwrap();
                    assert_eq!(event["method"], "events.presenceUpdate");
                }
                other => panic!("expected close 1009, got {other:?}"),
            }
        }
    })
    .await
    .expect("close deadline");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wire_message_limit_applies_before_and_after_rpc_open() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let server = server(&services).await;
    let token = services
        .auth_token_service
        .issue_session(1, &uuid::Uuid::new_v4().to_string(), 0)
        .unwrap();
    let limit = crate::rpc::session::MAX_FRAME_BYTES;
    let open = json!({
        "jsonrpc": "2.0", "id": "open", "method": "session.open",
        "params": {"protocolVersion": 1, "token": token, "appVersion": "test"}
    })
    .to_string();
    let ping = json!({
        "jsonrpc": "2.0", "id": "ping", "method": "session.ping", "params": {}
    })
    .to_string();

    for fragmented in [false, true] {
        for after_open in [false, true] {
            let mut client = connect(&server, &token).await;
            if after_open {
                send_wire(&mut client, serde_json::from_str(&open).unwrap()).await;
                assert_eq!(
                    next_wire(&mut client).await["result"]["authenticated"],
                    true
                );
            }
            let payload = if after_open { &ping } else { &open };
            send_sized_text(
                &mut client,
                pad_to(payload.clone(), limit + 1),
                fragmented,
                true,
            )
            .await;
            expect_too_big_close(&mut client).await;
        }

        let mut client = connect(&server, &token).await;
        send_sized_text(&mut client, pad_to(open.clone(), limit), fragmented, false).await;
        assert_eq!(
            next_wire(&mut client).await["result"]["authenticated"],
            true
        );
        send_sized_text(&mut client, pad_to(ping.clone(), limit), fragmented, false).await;
        assert_eq!(
            after_presence(&mut client).await,
            json!({"jsonrpc": "2.0", "id": "ping", "result": null}),
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn large_immediate_batch_does_not_block_socket_session() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let server = server(&services).await;
    let token = services
        .auth_token_service
        .issue_session(1, &uuid::Uuid::new_v4().to_string(), 0)
        .unwrap();
    let mut client = connect(&server, &token).await;
    send_wire(
        &mut client,
        json!({
            "jsonrpc": "2.0", "id": "open", "method": "session.open",
            "params": {"protocolVersion": 1, "token": token, "appVersion": "test"}
        }),
    )
    .await;
    assert_eq!(
        next_wire(&mut client).await["result"]["authenticated"],
        true
    );

    let batch: Vec<_> = (0..32)
        .map(|id| json!({"jsonrpc": "2.0", "id": id, "method": "unknown.operation"}))
        .collect();
    send_wire(&mut client, json!(batch)).await;
    let response = after_presence(&mut client).await;
    let responses = response.as_array().expect("aggregate batch response");
    assert_eq!(responses.len(), 32);
    for id in 0..32 {
        assert!(responses
            .iter()
            .any(|response| response["id"] == id && response["error"]["code"] == -32601));
    }

    send_call(&mut client, "ping", "session.ping", json!({})).await;
    assert_eq!(
        after_presence(&mut client).await,
        json!({"jsonrpc": "2.0", "id": "ping", "result": null}),
    );
}

async fn rpc(client: &mut Client, id: &str, method: &str, params: Value) -> Value {
    client
        .send(Message::Text(
            json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    timeout(Duration::from_secs(10), async {
        while let Some(message) = client.next().await {
            if let Message::Text(text) = message.unwrap() {
                let response: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(response["jsonrpc"], "2.0");
                assert!(
                    response.get("type").is_none(),
                    "RPC must never receive a legacy envelope"
                );
                if response["id"] == id {
                    assert!(
                        response.get("error").is_none(),
                        "{method}: {:?}",
                        response["error"]
                    );
                    return response["result"].clone();
                }
            }
        }
        panic!("RPC connection closed before {method} completed");
    })
    .await
    .expect("RPC response deadline")
}

async fn wait_removed(services: &AppState) {
    timeout(Duration::from_secs(5), async {
        while !services.ws_registry.online_connections(1).is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("registry cleanup deadline");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn warmed_http_activity_does_not_wait_for_a_database_connection() {
    use tower::ServiceExt;

    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let token = services
        .auth_token_service
        .issue_session(1, "http-warm-activity", 0)
        .unwrap();
    let app = router(&services);
    let request = |version: &str| {
        axum::http::Request::builder()
            .uri("/activity-probe")
            .header("authorization", format!("Bearer {token}"))
            .header("x-app-version", version)
            .body(axum::body::Body::empty())
            .unwrap()
    };
    assert_eq!(
        app.clone()
            .oneshot(request("first"))
            .await
            .unwrap()
            .status(),
        axum::http::StatusCode::OK
    );

    let connection = services.db.get().expect("hold the only DB connection");
    let response = timeout(Duration::from_secs(1), app.oneshot(request("second"))).await;
    drop(connection);
    assert_eq!(
        response
            .expect("warmed tracking must not wait for the pool")
            .unwrap()
            .status(),
        axum::http::StatusCode::OK
    );
}

#[tokio::test]
async fn waiting_http_database_operation_does_not_stall_other_requests() {
    use tower::ServiceExt;

    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let token = services
        .auth_token_service
        .issue_session(1, "http-database-isolation", 0)
        .unwrap();
    let app = router(&services);
    let request = || {
        axum::http::Request::builder()
            .uri("/friends")
            .header("authorization", format!("Bearer {token}"))
            .body(axum::body::Body::empty())
            .unwrap()
    };
    assert_eq!(
        app.clone().oneshot(request()).await.unwrap().status(),
        axum::http::StatusCode::OK
    );
    let connection = services.db.get().unwrap();
    let pending = tokio::spawn(app.clone().oneshot(request()));
    tokio::time::sleep(Duration::from_millis(10)).await;
    let probe = timeout(
        Duration::from_secs(1),
        app.oneshot(
            axum::http::Request::builder()
                .uri("/activity-probe")
                .body(axum::body::Body::empty())
                .unwrap(),
        ),
    )
    .await;
    let still_waiting = !pending.is_finished();
    drop(connection);
    assert_eq!(
        probe
            .expect("pool wait must not stall the executor")
            .unwrap()
            .status(),
        axum::http::StatusCode::OK
    );
    assert!(still_waiting, "database work must wait for a connection");
    assert_eq!(
        timeout(Duration::from_secs(5), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .status(),
        axum::http::StatusCode::OK
    );
}

#[tokio::test]
async fn service_token_authentication_wait_does_not_stall_other_requests() {
    use tower::ServiceExt;

    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let app = Router::new()
        .route(
            "/principal",
            get(|_: crate::services::authentication::Principal| async { "authorized" }),
        )
        .route("/probe", get(|| async { "responsive" }))
        .with_state(services.clone());
    let credential = crate::services::service_tokens::generate_credential(
        &services.config.auth.service_token_hash_key,
    )
    .unwrap()
    .credential;
    let connection = services.db.get().unwrap();
    let pending = tokio::spawn(
        app.clone().oneshot(
            axum::http::Request::builder()
                .uri("/principal")
                .header("authorization", format!("Bearer {credential}"))
                .header("x-on-behalf-of", "invalid")
                .body(axum::body::Body::empty())
                .unwrap(),
        ),
    );
    tokio::time::sleep(Duration::from_millis(10)).await;
    let probe = timeout(
        Duration::from_secs(1),
        app.oneshot(
            axum::http::Request::builder()
                .uri("/probe")
                .body(axum::body::Body::empty())
                .unwrap(),
        ),
    )
    .await;
    let still_waiting = !pending.is_finished();
    drop(connection);
    assert_eq!(
        probe
            .expect("authentication pool wait must not stall the executor")
            .unwrap()
            .status(),
        axum::http::StatusCode::OK
    );
    assert!(still_waiting);
    assert_eq!(
        timeout(Duration::from_secs(5), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .status(),
        axum::http::StatusCode::UNAUTHORIZED,
        "invalid credentials must still take precedence over malformed delegation"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rpc_upgrade_ignores_conflicting_bearer_and_verifies_once_while_legacy_keeps_header_tracking(
) {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let server = server(&services).await;
    let body_client = uuid::Uuid::new_v4().to_string();
    let header_client = uuid::Uuid::new_v4().to_string();
    let token = services
        .auth_token_service
        .issue_session(1, &body_client, 0)
        .unwrap();
    let header_token = services
        .auth_token_service
        .issue_session(2, &header_client, 0)
        .unwrap();
    assert_eq!(services.auth_token_service.verifier_invocations(), 0);
    let mut client = connect(&server, &header_token).await;
    let opened = rpc(
        &mut client,
        "open",
        "session.open",
        json!({"protocolVersion":1,"token":token,"appVersion":"test"}),
    )
    .await;
    assert_eq!(opened["uid"], 1);
    assert_eq!(opened["clientId"], body_client);
    assert_eq!(services.auth_token_service.verifier_invocations(), 1);
    for index in 0..20 {
        let method = if index % 2 == 0 {
            "users.getMe"
        } else {
            "session.ping"
        };
        let result = rpc(&mut client, &format!("call-{index}"), method, json!({})).await;
        if method == "users.getMe" {
            assert_eq!(result["uid"], 1);
        } else {
            assert_eq!(result, Value::Null);
        }
    }
    let refreshed = rpc(&mut client, "refresh", "auth.refresh", json!({})).await;
    assert!(refreshed["token"].is_string());
    assert_eq!(services.auth_token_service.verifier_invocations(), 1);
    {
        let mut connection = services.db.get().unwrap();
        let count = crate::schema::clients::table
            .filter(crate::schema::clients::client_id.eq(&header_client))
            .count()
            .get_result::<i64>(&mut connection)
            .unwrap();
        assert_eq!(count, 0, "RPC must not record the upgrade-header client");
    }
    client.close(None).await.unwrap();
    wait_removed(&services).await;

    let mut reconnected = connect(&server, &header_token).await;
    assert_eq!(
        rpc(
            &mut reconnected,
            "reopen",
            "session.open",
            json!({"protocolVersion":1,"token":token})
        )
        .await["uid"],
        1
    );
    assert_eq!(services.auth_token_service.verifier_invocations(), 2);
    reconnected.close(None).await.unwrap();
    wait_removed(&services).await;

    let ticket = services
        .auth_token_service
        .issue_legacy_session(1, &body_client, 0)
        .unwrap();
    let mut legacy = connect(&server, &header_token).await;
    legacy
        .send(Message::Text(
            json!({"type":"auth","ticket":ticket}).to_string().into(),
        ))
        .await
        .unwrap();
    legacy
        .send(Message::Text(json!({"type":"ping"}).to_string().into()))
        .await
        .unwrap();
    let pong = timeout(Duration::from_secs(5), async {
        loop {
            let text = legacy.next().await.unwrap().unwrap().into_text().unwrap();
            let message: Value = serde_json::from_str(&text).unwrap();
            if message["type"] == "pong" {
                break text;
            }
            assert_eq!(message["type"], "presenceUpdate");
        }
    })
    .await
    .unwrap();
    assert_eq!(pong, r#"{"type":"pong"}"#);
    assert_eq!(
        services.auth_token_service.verifier_invocations(),
        4,
        "legacy verifies header and ticket"
    );
    {
        let mut connection = services.db.get().unwrap();
        let owner = crate::schema::clients::table
            .filter(crate::schema::clients::client_id.eq(&header_client))
            .select(crate::schema::clients::last_active_uid)
            .first::<i32>(&mut connection)
            .unwrap();
        assert_eq!(
            owner, 2,
            "legacy retains header-derived bookkeeping identity"
        );
    }
    legacy.close(None).await.unwrap();
    wait_removed(&services).await;

    let failed_client = uuid::Uuid::new_v4().to_string();
    services.db.get().unwrap().batch_execute(&format!(
        "ALTER TABLE clients ADD CONSTRAINT rpc_header_failure CHECK (client_id <> '{failed_client}')",
    )).unwrap();
    let failed_header = services
        .auth_token_service
        .issue_session(2, &failed_client, 0)
        .unwrap();
    let mut failed_legacy = connect(&server, &failed_header).await;
    failed_legacy
        .send(Message::Text(
            json!({"type":"auth","ticket":ticket}).to_string().into(),
        ))
        .await
        .unwrap();
    let closed = timeout(Duration::from_secs(5), failed_legacy.next())
        .await
        .unwrap();
    assert!(
        !matches!(closed, Some(Ok(Message::Text(_)))),
        "failed tracking must not send a new application frame"
    );
    assert_eq!(
        services.auth_token_service.verifier_invocations(),
        5,
        "failure precedes ticket verification"
    );
    assert!(
        services.ws_registry.online_connections(1).is_empty(),
        "failed legacy upgrade must not register"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pipelined_upgrade_frames_cannot_replace_the_first_authenticated_identity() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let server = server(&services).await;
    let first = services
        .auth_token_service
        .issue_session(1, "first-upgrade-frame", 0)
        .unwrap();
    let later = services
        .auth_token_service
        .issue_session(2, "later-upgrade-frame", 0)
        .unwrap();
    let header = services
        .auth_token_service
        .issue_session(3, "ignored-upgrade-header", 0)
        .unwrap();
    let mut client = connect(&server, &header).await;
    for request in [
        json!({"jsonrpc":"2.0","id":"first","method":"session.open","params":{"protocolVersion":1,"token":first}}),
        json!({"jsonrpc":"2.0","id":"later","method":"session.open","params":{"protocolVersion":1,"token":later}}),
        json!({"jsonrpc":"2.0","id":"profile","method":"users.getMe"}),
    ] {
        client
            .send(Message::Text(request.to_string().into()))
            .await
            .unwrap();
    }
    let replies = timeout(Duration::from_secs(10), async {
        let mut replies = std::collections::BTreeMap::new();
        let mut first_frame = true;
        while replies.len() < 3 {
            let message = client.next().await.expect("socket remains open").unwrap();
            if let Message::Text(text) = message {
                let reply: Value = serde_json::from_str(&text).unwrap();
                if first_frame {
                    assert_eq!(
                        reply["id"], "first",
                        "the first handshake response precedes events"
                    );
                    first_frame = false;
                }
                if let Some(id) = reply["id"].as_str() {
                    replies.insert(id.to_owned(), reply);
                }
            }
        }
        replies
    })
    .await
    .expect("pipelined responses deadline");
    assert_eq!(replies["first"]["result"]["uid"], 1);
    assert_eq!(replies["later"]["error"]["code"], 1009);
    assert_eq!(replies["profile"]["result"]["uid"], 1);
    assert_eq!(services.auth_token_service.verifier_invocations(), 1);
    assert_eq!(services.ws_registry.online_connections(1).len(), 1);
    assert!(services.ws_registry.online_connections(2).is_empty());
    assert!(services.ws_registry.online_connections(3).is_empty());
    assert_eq!(
        rpc(&mut client, "after-conflict", "users.getMe", json!({})).await["uid"],
        1
    );
    client.close(None).await.unwrap();
    wait_removed(&services).await;
}

async fn send_wire(client: &mut Client, value: Value) {
    client
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

async fn next_wire(client: &mut Client) -> Value {
    timeout(Duration::from_secs(5), async {
        loop {
            match client.next().await.expect("socket remains open").unwrap() {
                Message::Text(text) => return serde_json::from_str(&text).unwrap(),
                Message::Close(frame) => panic!("unexpected close {frame:?}"),
                _ => {}
            }
        }
    })
    .await
    .expect("wire frame deadline")
}

async fn after_presence(client: &mut Client) -> Value {
    loop {
        let frame = next_wire(client).await;
        if frame["method"] != "events.presenceUpdate" && frame["type"] != "presenceUpdate" {
            return frame;
        }
    }
}

async fn next_notification(client: &mut Client, method: &str) -> Value {
    timeout(Duration::from_secs(5), async {
        loop {
            let frame = next_wire(client).await;
            if frame["method"] == method {
                return frame["params"].clone();
            }
        }
    })
    .await
    .expect("notification deadline")
}

async fn send_call(client: &mut Client, id: &str, method: &str, params: Value) {
    send_wire(
        client,
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn message_sync_both_protocols_isolate_live_events_and_order_rpc_pages() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    services
        .db
        .get()
        .unwrap()
        .batch_execute(
            "-- These are temp tables. Resume should attach only the fixture chat.
         DELETE FROM group_membership WHERE uid IN (1, 2);
         INSERT INTO groups (id, name, membership_message_visibility)
             VALUES (9876770000, 'sync wire', 'admins');
         INSERT INTO group_membership (chat_id, uid, role)
             VALUES (9876770000, 1, 'member'), (9876770000, 2, 'admin');",
        )
        .unwrap();
    let server = server(&services).await;
    let token = |uid, client, ticket| {
        if ticket {
            services
                .auth_token_service
                .issue_legacy_session(uid, client, 0)
                .unwrap()
        } else {
            services
                .auth_token_service
                .issue_session(uid, client, 0)
                .unwrap()
        }
    };
    let chat_id = "9876770000";
    let mut ticket = connect(&server, &token(1, "sync-ticket-header", false)).await;
    send_wire(
        &mut ticket,
        json!({"type": "auth", "ticket": token(1, "sync-ticket", true), "messageSync": 1}),
    )
    .await;
    assert_eq!(
        next_wire(&mut ticket).await,
        json!({"type": "messageSyncHello", "payload": {"version": 1}})
    );
    assert_eq!(next_wire(&mut ticket).await["type"], "presenceUpdate");
    send_wire(
        &mut ticket,
        json!({"type": "messageSyncResume", "chats": [], "last": true, "priorityChatId": chat_id}),
    )
    .await;
    let frame = after_presence(&mut ticket).await;
    assert_eq!(frame["type"], "messageSyncReset");
    assert_eq!(frame["payload"]["chatId"], chat_id);
    assert_eq!(
        after_presence(&mut ticket).await,
        json!({"type": "messageSyncResumed", "payload": {}})
    );
    let request_id = 4_294_967_296_u64;
    send_wire(
        &mut ticket,
        json!({"type": "messageSyncPage", "requestId": request_id, "chatId": chat_id}),
    )
    .await;
    let ticket_page = after_presence(&mut ticket).await;
    assert_eq!(ticket_page["type"], "messageSyncPageResult");
    assert_eq!(ticket_page["payload"]["requestId"], request_id);
    assert_eq!(ticket_page["payload"]["at"], frame["payload"]["cursor"]);
    assert_eq!(ticket_page["payload"]["page"]["messages"], json!([]));

    let mut legacy_ticket = connect(&server, &token(1, "old-ticket-header", false)).await;
    send_wire(
        &mut legacy_ticket,
        json!({"type": "auth", "ticket": token(1, "old-ticket", true), "messageSync": 9}),
    )
    .await;
    assert_eq!(
        next_wire(&mut legacy_ticket).await["type"],
        "presenceUpdate"
    );
    let mut legacy_rpc = connect(&server, &token(1, "old-rpc-header", false)).await;
    let opened = rpc(
        &mut legacy_rpc,
        "open",
        "session.open",
        json!({
            "protocolVersion": 1, "token": token(1, "old-rpc", false), "messageSync": 9,
        }),
    )
    .await;
    assert!(opened.get("messageSync").is_none());
    send_call(
        &mut legacy_rpc,
        "disabled",
        "messageSync.resume",
        json!({"chats": [], "last": true}),
    )
    .await;
    let disabled = after_presence(&mut legacy_rpc).await;
    assert_eq!(disabled["id"], "disabled");
    assert_eq!(
        disabled["error"]["message"],
        "message sync is not enabled for this session"
    );

    let receiver_token = token(1, "sync-rpc", false);
    let mut receiver = connect(&server, &receiver_token).await;
    let opened = rpc(
        &mut receiver,
        "open",
        "session.open",
        json!({
            "protocolVersion": 1, "token": &receiver_token, "messageSync": 1,
        }),
    )
    .await;
    assert_eq!(opened["messageSync"], 1);
    send_call(
        &mut receiver,
        "first-chunk",
        "messageSync.resume",
        json!({
            "chats": [{"chatId": chat_id}],
            "last": false,
        }),
    )
    .await;
    send_call(
        &mut receiver,
        "resume",
        "messageSync.resume",
        json!({
            "chats": [], "last": true, "priorityChatId": chat_id,
        }),
    )
    .await;
    let mut saw_reset = false;
    let mut replies = std::collections::HashSet::new();
    while replies.len() < 2 {
        let frame = after_presence(&mut receiver).await;
        if frame["method"] == "events.messageSyncReset" {
            assert!(!saw_reset);
            assert_eq!(frame["params"]["chatId"], chat_id);
            saw_reset = true;
        } else {
            let id = frame["id"].as_str().unwrap();
            assert!(id == "first-chunk" || (id == "resume" && saw_reset));
            assert_eq!(frame["result"], json!({}));
            assert!(replies.insert(id.to_owned()));
        }
    }

    let sender_token = token(2, "sync-test-sender", false);
    let mut sender = connect(&server, &sender_token).await;
    rpc(
        &mut sender,
        "open",
        "session.open",
        json!({"protocolVersion": 1, "token": &sender_token}),
    )
    .await;
    let sent = rpc(&mut sender, "send", "messages.send", json!({
        "chatId": chat_id, "message": "live", "messageType": "text", "clientGeneratedId": "sync-wire-send",
    })).await;
    let msg_id = sent["id"].as_str().unwrap();
    let live = after_presence(&mut receiver).await;
    assert_eq!(live["method"], "events.messageSyncBatch");
    assert_eq!(live["params"]["changes"][0]["message"]["id"], msg_id);
    assert_eq!(live["params"]["changes"][0]["appeared"], true);
    let ticket_live = after_presence(&mut ticket).await;
    assert_eq!(ticket_live["type"], "messageSyncBatch");
    assert_eq!(
        ticket_live["payload"]["changes"][0]["message"]["id"],
        msg_id
    );
    assert_eq!(
        after_presence(&mut legacy_rpc).await["method"],
        "events.message"
    );
    assert_eq!(after_presence(&mut legacy_ticket).await["type"], "message");

    rpc(
        &mut sender,
        "announce",
        "groups.addMember",
        json!({"chatId": chat_id, "uid": 3}),
    )
    .await;
    let hidden = after_presence(&mut receiver).await;
    assert_eq!(hidden["method"], "events.messageSyncBatch");
    assert_eq!(hidden["params"]["from"], live["params"]["to"]);
    assert_eq!(hidden["params"]["changes"], json!([]));
    let checkpoint = hidden["params"]["to"].clone();
    assert_ne!(checkpoint, live["params"]["to"]);
    let ticket_hidden = after_presence(&mut ticket).await;
    assert_eq!(ticket_hidden["type"], "messageSyncBatch");
    assert_eq!(ticket_hidden["payload"], hidden["params"]);
    receiver.close(None).await.unwrap();
    let edit = |body| {
        diesel::update(crate::schema::messages::table.find(msg_id.parse::<i64>().unwrap()))
            .set(crate::schema::messages::message.eq(body))
            .execute(&mut services.db.get().unwrap())
            .unwrap();
    };
    edit("while offline");
    let mut receiver = connect(&server, &receiver_token).await;
    rpc(
        &mut receiver,
        "open",
        "session.open",
        json!({
            "protocolVersion": 1, "token": &receiver_token, "messageSync": 1,
        }),
    )
    .await;
    send_call(
        &mut receiver,
        "resume",
        "messageSync.resume",
        json!({
            "chats": [{"chatId": chat_id, "cursor": checkpoint}], "last": true,
        }),
    )
    .await;
    let resumed = after_presence(&mut receiver).await;
    assert_eq!(resumed["method"], "events.messageSyncBatch");
    assert_eq!(resumed["params"]["from"], checkpoint);
    assert_eq!(
        resumed["params"]["changes"][0]["message"]["message"],
        "while offline"
    );
    let ready = after_presence(&mut receiver).await;
    assert_eq!(ready["method"], "events.messageSyncReady");
    assert_eq!(ready["params"]["cursor"], resumed["params"]["to"]);
    assert_eq!(after_presence(&mut receiver).await["result"], json!({}));

    edit("inside page snapshot");
    send_call(
        &mut receiver,
        "page",
        "messageSync.page",
        json!({"requestId": request_id, "chatId": chat_id}),
    )
    .await;
    let batch = after_presence(&mut receiver).await;
    assert_eq!(batch["method"], "events.messageSyncBatch");
    let page = after_presence(&mut receiver).await;
    assert_eq!(page["method"], "events.messageSyncPageResult");
    assert_eq!(page["params"]["at"], batch["params"]["to"]);
    assert_eq!(page["params"]["requestId"], request_id);
    assert_eq!(
        page["params"]["page"]["messages"][0]["message"],
        "inside page snapshot"
    );
    assert_eq!(after_presence(&mut receiver).await["result"], json!({}));

    rpc(
        &mut sender,
        "role",
        "groups.updateMember",
        json!({"chatId": chat_id, "uid": 1, "role": "admin"}),
    )
    .await;
    let reset = next_notification(&mut receiver, "events.messageSyncReset").await;
    assert_eq!(reset["chatId"], chat_id);
    assert_eq!(reset["reason"], "visibilityChanged");

    rpc(
        &mut sender,
        "remove",
        "groups.removeMember",
        json!({"chatId": chat_id, "uid": 1}),
    )
    .await;
    let revoked = next_notification(&mut receiver, "events.messageSyncRevoked").await;
    assert_eq!(revoked, json!({"chatId": chat_id}));
    send_call(
        &mut receiver,
        "revoked",
        "messageSync.page",
        json!({"requestId": 5, "chatId": chat_id}),
    )
    .await;
    let page = next_notification(&mut receiver, "events.messageSyncPageResult").await;
    assert_eq!(
        page,
        json!({"requestId": 5, "chatId": chat_id, "at": null, "page": null})
    );
    assert_eq!(after_presence(&mut receiver).await["result"], json!({}));

    rpc(
        &mut sender,
        "rejoin",
        "groups.addMember",
        json!({"chatId": chat_id, "uid": 1}),
    )
    .await;
    let reset = next_notification(&mut receiver, "events.messageSyncReset").await;
    assert_eq!(reset["chatId"], chat_id);
    assert_eq!(reset["reason"], "noBaseline");

    send_call(
        &mut receiver,
        "duplicate",
        "messageSync.resume",
        json!({"chats": [], "last": true}),
    )
    .await;
    let error = timeout(Duration::from_secs(5), async {
        loop {
            let frame = next_wire(&mut receiver).await;
            if frame["id"] == "duplicate" {
                return frame;
            }
        }
    })
    .await
    .expect("duplicate resume error deadline");
    assert_eq!(error["error"]["code"], -32602);
    let closed = timeout(Duration::from_secs(5), receiver.next())
        .await
        .unwrap();
    use tokio_tungstenite::tungstenite::{error::ProtocolError, Error};
    assert!(matches!(
        closed,
        None | Some(Ok(Message::Close(_)))
            | Some(Err(Error::Protocol(
                ProtocolError::ResetWithoutClosingHandshake
            )))
    ));
}

#[tokio::test]
async fn message_sync_ticket_closes_when_pruned_before_final_resume_chunk() {
    use tokio_tungstenite::tungstenite::{error::ProtocolError, Error};

    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let server = server(&services).await;
    let header = services
        .auth_token_service
        .issue_session(1, "prune-header", 0)
        .unwrap();
    let ticket = services
        .auth_token_service
        .issue_legacy_session(1, "prune-ticket", 0)
        .unwrap();
    let mut client = connect(&server, &header).await;
    send_wire(
        &mut client,
        json!({"type": "auth", "ticket": ticket, "messageSync": 1}),
    )
    .await;
    assert_eq!(next_wire(&mut client).await["type"], "messageSyncHello");
    send_wire(
        &mut client,
        json!({"type": "messageSyncResume", "chats": [], "last": false}),
    )
    .await;
    send_wire(&mut client, json!({"type": "ping", "state": "inactive"})).await;
    assert_eq!(after_presence(&mut client).await["type"], "pong");

    // Heartbeats have second precision. Prune without sending a final chunk.
    timeout(Duration::from_secs(3), async {
        while !services.ws_registry.online_connections(1).is_empty() {
            services.ws_registry.prune_stale(0);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let closed = timeout(Duration::from_secs(2), client.next())
        .await
        .unwrap();
    assert!(matches!(
        closed,
        None | Some(Ok(Message::Close(_)))
            | Some(Err(Error::Protocol(
                ProtocolError::ResetWithoutClosingHandshake
            )))
    ));
}
