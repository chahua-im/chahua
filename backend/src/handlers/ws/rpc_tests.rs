use std::{net::SocketAddr, time::Duration};

use axum::{middleware, routing::get, Router};
use diesel::{connection::SimpleConnection, prelude::*};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::{net::TcpListener, task::JoinHandle, time::timeout};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
    MaybeTlsStream, WebSocketStream,
};

use crate::{
    rpc::RpcServices,
    state::{AppInner, AppState},
};

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

fn state(services: &RpcServices) -> AppState {
    AppState::new(AppInner {
        db: services.db.clone(),
        id_gen: services.id_gen.clone(),
        metrics: services.metrics.clone(),
        config: services.config.clone(),
        media: services.media.clone(),
        avatars: services.avatars.clone(),
        link_previews: services.link_previews.clone(),
        authz_service: services.authz_service.clone(),
        ws_registry: services.ws_registry.clone(),
        presence_service: services.presence_service.clone(),
        push_service: services.push_service.clone(),
        unread_service: services.unread_service.clone(),
        client_tracking: services.client_tracking.clone(),
        background_service: services.background_service.clone(),
        message_search: services.message_search.clone(),
        auth_token_service: services.auth_token_service.clone(),
        token_generation: services.token_generation.clone(),
    })
}

fn router(services: &RpcServices) -> Router {
    let state = state(services);
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

async fn server(services: &RpcServices) -> Server {
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

async fn wait_removed(services: &RpcServices) {
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
        .with_state(state(&services));
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
