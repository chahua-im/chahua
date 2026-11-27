use super::*;
use std::time::Duration;

fn test_context() -> (
    RpcCallContext,
    mpsc::Receiver<RpcControlCommand>,
    mpsc::UnboundedReceiver<RpcLifecycleFailure>,
) {
    let (controls, controls_rx) = mpsc::channel(1);
    let (guard_failures, guard_rx) = mpsc::unbounded_channel();
    let context = RpcCallContext {
        session: None,
        connection_id: 1,
        rpc_id: Some(RpcId::String("queued".into())),
        message_sync_enabled: false,
        sync_control: None,
        controls,
        guard_failures: Some(guard_failures),
        close_session: None,
    };
    (context, controls_rx, guard_rx)
}

#[tokio::test]
async fn suspended_session_with_open_transport_returns_unavailable_for_queued_waiter() {
    let transport = TransportState::new();
    let shared = SessionShared::new(transport);
    let admission = admission::Admission::new(1, 1, 4, 4);
    let connection = Arc::new(Semaphore::new(4));
    let metrics = Arc::new(crate::metrics::RpcAdmissionMetrics::new(
        &prometheus::Registry::new(),
    ));
    let held = admission
        .request(
            1,
            &connection,
            Instant::now() + Duration::from_secs(5),
            &metrics,
        )
        .unwrap()
        .wait()
        .await;
    let queued = admission
        .request(
            1,
            &connection,
            Instant::now() + Duration::from_secs(5),
            &metrics,
        )
        .unwrap();
    let (mut context, _controls_rx, _guard_rx) = test_context();

    shared.suspend_authorized_work().await;
    let shared_for_wait = shared.clone();
    let waiter = tokio::spawn(async move {
        wait_for_admission(
            queued,
            Instant::now() + Duration::from_secs(5),
            &shared_for_wait,
            &mut context,
        )
        .await
    });
    tokio::task::yield_now().await;
    drop(held);

    let result = waiter.await.unwrap();
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("suspended open session must return Unavailable so batch completes"),
    };
    assert_eq!(error.code, RpcErrorCode::Unavailable);
    assert!(!shared.transport.is_closed());
}

#[tokio::test]
async fn closed_transport_cancels_queued_waiter() {
    let transport = TransportState::new();
    let shared = SessionShared::new(transport);
    let admission = admission::Admission::new(1, 1, 4, 4);
    let connection = Arc::new(Semaphore::new(4));
    let metrics = Arc::new(crate::metrics::RpcAdmissionMetrics::new(
        &prometheus::Registry::new(),
    ));
    let _held = admission
        .request(
            1,
            &connection,
            Instant::now() + Duration::from_secs(5),
            &metrics,
        )
        .unwrap()
        .wait()
        .await;
    let queued = admission
        .request(
            1,
            &connection,
            Instant::now() + Duration::from_secs(5),
            &metrics,
        )
        .unwrap();
    let (mut context, _controls_rx, _guard_rx) = test_context();

    let shared_for_wait = shared.clone();
    let waiter = tokio::spawn(async move {
        wait_for_admission(
            queued,
            Instant::now() + Duration::from_secs(5),
            &shared_for_wait,
            &mut context,
        )
        .await
    });
    tokio::task::yield_now().await;
    shared.transport.close();

    let result = waiter.await.unwrap();
    assert!(matches!(result, Ok(None)));
}
