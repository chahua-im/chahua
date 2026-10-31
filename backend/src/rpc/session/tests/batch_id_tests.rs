use diesel::prelude::*;

use super::*;

async fn barrier(input: &RpcSessionInput, output: &mut RpcSessionOutput) {
    input.send(json!({"jsonrpc":"2.0","id":"barrier","method":"session.ping","params":{"state":"inactive"}}).to_string()).await.unwrap();
    assert_eq!(receive_json(output).await["id"], "barrier");
}

#[tokio::test]
async fn completed_batch_member_id_stays_outstanding_until_the_aggregate_is_queued() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let token = services
        .auth_token_service
        .issue_session(1, "batch-id-lifetime", 0)
        .unwrap();
    let (input, mut output, task) = open_authenticated(services.clone(), token).await;
    let held = services.db.get().unwrap();
    input.send(json!([
        {"jsonrpc":"2.0","id":"reuse","method":"session.ping","params":{"state":"inactive"}},
        {"jsonrpc":"2.0","id":"slow","method":"users.getMe"},
    ]).to_string()).await.unwrap();
    // This current-thread runtime observes the metric only after the fast
    // dispatch has queued its WorkResult. Its following barrier result is FIFO
    // behind that result, while the DB-backed batch member remains blocked.
    timeout(Duration::from_secs(5), async {
        while !services
            .metrics
            .render()
            .unwrap()
            .contains("rpc_requests_total{method=\"session.ping\",outcome=\"success\"} 1\n")
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fast batch member completed");
    barrier(&input, &mut output).await;
    input.send(json!({"jsonrpc":"2.0","id":"reuse","method":"groups.create","params":{"name":"must not execute reused batch ID"}}).to_string()).await.unwrap();
    let duplicate = receive_json(&mut output).await;
    assert_eq!(duplicate["id"], Value::Null);
    assert_eq!(duplicate["error"]["code"], -32600);
    drop(held);
    close_session(input, output, task).await;
    let created = crate::schema::groups::table
        .filter(crate::schema::groups::name.eq("must not execute reused batch ID"))
        .count()
        .get_result::<i64>(&mut services.db.get().unwrap())
        .unwrap();
    assert_eq!(
        created, 0,
        "an ID buffered inside a pending batch cannot execute a second mutation"
    );
}

#[tokio::test]
async fn immediately_rejected_batch_member_id_is_reserved_until_the_other_members_finish() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let token = services
        .auth_token_service
        .issue_session(1, "rejected-batch-id", 0)
        .unwrap();
    let (input, mut output, task) = open_authenticated(services.clone(), token).await;
    let held = services.db.get().unwrap();
    let mut calls = (0..MAX_IN_FLIGHT)
        .map(|index| {
            json!({
                "jsonrpc":"2.0","id":format!("blocked-{index}"),"method":"users.getMe",
            })
        })
        .collect::<Vec<_>>();
    calls.push(json!({"jsonrpc":"2.0","id":"rejected-but-buffered","method":"users.getMe"}));
    input.send(Value::Array(calls).to_string()).await.unwrap();
    barrier(&input, &mut output).await;
    input.send(json!({"jsonrpc":"2.0","id":"rejected-but-buffered","method":"groups.create","params":{"name":"must not execute"}}).to_string()).await.unwrap();
    let duplicate = receive_json(&mut output).await;
    assert_eq!(duplicate["id"], Value::Null);
    assert_eq!(
        duplicate["error"]["code"], -32600,
        "even an immediate overload response still belongs to its unemitted batch"
    );
    drop(held);
    close_session(input, output, task).await;
}
