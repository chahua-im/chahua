use diesel::{connection::SimpleConnection, prelude::*};
use serde_json::{json, Value};

use super::*;

async fn call(
    input: &RpcSessionInput,
    output: &mut RpcSessionOutput,
    id: &str,
    method: &str,
    params: Value,
) -> Value {
    input
        .send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string())
        .await
        .expect("session input accepts request");
    receive_json(output).await
}

#[tokio::test]
async fn ordinary_calls_and_refresh_observe_activity_without_changing_presence() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let client_id = "rpc-activity-parity";
    let token = services
        .auth_token_service
        .issue_session(1, client_id, 0)
        .expect("issue session");
    let (input, mut output, task) = open_authenticated(services.clone(), token).await;

    let before_call = services
        .client_tracking
        .last_seen
        .latest(1, None)
        .expect("bind records observed activity");
    let response = call(&input, &mut output, "me", "users.getMe", json!({})).await;
    assert_eq!(response["result"]["uid"], 1);
    let after_call = services
        .client_tracking
        .last_seen
        .latest(1, None)
        .expect("ordinary RPC records observed activity");
    assert!(after_call >= before_call);

    let before_refresh = after_call;
    let response = call(&input, &mut output, "refresh", "auth.refresh", json!({})).await;
    assert!(response["result"]["token"].is_string());
    let after_refresh = services
        .client_tracking
        .last_seen
        .latest(1, None)
        .expect("refresh records observed activity");
    assert!(after_refresh >= before_refresh);

    use crate::schema::clients::dsl;
    let recorded = dsl::clients
        .find(client_id)
        .select((dsl::last_active_uid, dsl::last_app_version))
        .first::<(i32, Option<String>)>(&mut services.db.get().expect("test DB connection"))
        .expect("client activity row");
    assert_eq!(recorded, (1, Some("rpc-session-test".into())));
    assert_eq!(
        services.ws_registry.online_connections(1)[0].app_state,
        crate::services::ws_registry::AppPresenceState::Inactive,
        "ordinary activity must not force active presence"
    );

    close_session(input, output, task).await;
}

#[tokio::test]
async fn activity_failure_rejects_ordinary_operation_before_its_transaction() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let token = services
        .auth_token_service
        .issue_session(1, "rpc-activity-failure", 0)
        .expect("issue session");
    let (input, mut output, task) = open_authenticated(services.clone(), token).await;
    let before = crate::schema::groups::table
        .count()
        .get_result::<i64>(&mut services.db.get().expect("test DB connection"))
        .expect("count groups");
    services
        .client_tracking
        .record_client_activity(2, "rpc-activity-failure", None)
        .expect("another identity rebinds client bookkeeping");
    services
        .db
        .get()
        .expect("test DB connection")
        .batch_execute(
            "ALTER TABLE pg_temp.clients ADD CONSTRAINT rpc_activity_failure \
         CHECK (client_id <> 'rpc-activity-failure' OR last_active_uid <> 1)",
        )
        .expect("reject only this fixture client's next rebind");

    let response = call(
        &input,
        &mut output,
        "create",
        "groups.create",
        json!({"name":"must not commit"}),
    )
    .await;
    assert_eq!(response["error"]["code"], 1500);
    let after = crate::schema::groups::table
        .count()
        .get_result::<i64>(&mut services.db.get().expect("test DB connection"))
        .expect("count groups");
    assert_eq!(
        after, before,
        "activity failure precedes the business transaction"
    );

    close_session(input, output, task).await;
}

#[tokio::test]
async fn active_controls_buffer_observation_while_inactive_controls_do_not() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let token = services
        .auth_token_service
        .issue_session(1, "rpc-control-activity", 0)
        .expect("issue session");
    let (input, mut output, task) = open_authenticated(services.clone(), token).await;
    let before = services.client_tracking.last_seen.latest(1, None);

    let active = call(
        &input,
        &mut output,
        "active",
        "session.ping",
        json!({"state":"active"}),
    )
    .await;
    assert_eq!(active["result"], Value::Null);
    let after_active = services
        .client_tracking
        .last_seen
        .latest(1, None)
        .expect("active control buffers observation immediately");
    assert!(before.is_none_or(|before| after_active >= before));

    let inactive = call(
        &input,
        &mut output,
        "inactive",
        "session.setAppState",
        json!({"state":"inactive"}),
    )
    .await;
    assert_eq!(inactive["result"], Value::Null);
    assert_eq!(
        services.client_tracking.last_seen.latest(1, None),
        Some(after_active),
        "inactive controls retain liveness but do not record activity"
    );
    assert_eq!(
        services.ws_registry.online_connections(1)[0].app_state,
        crate::services::ws_registry::AppPresenceState::Inactive
    );

    close_session(input, output, task).await;
}
