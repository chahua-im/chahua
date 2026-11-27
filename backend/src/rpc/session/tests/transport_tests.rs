use super::*;

#[tokio::test]
async fn closed_transport_stops_owned_event_forwarder_immediately() {
    let state = TransportState::new();
    let shared = SessionShared::new(state.clone());
    state.close();
    let (events_tx, events_rx) = mpsc::channel(1);
    let (output_tx, mut output_rx) = mpsc::channel(1);
    let sink = RpcOutputSink {
        tx: output_tx,
        state,
    };

    timeout(
        Duration::from_millis(100),
        forward_owned_events::<unread::watch::UnreadWatchEvent>(events_rx, shared, sink),
    )
    .await
    .expect("closed forwarder exits without waiting for a watch event");
    assert!(output_rx.try_recv().is_err());
    drop(events_tx);
}

#[tokio::test]
async fn closed_transport_stops_generation_checks_before_the_first_interval() {
    let Some(services) = crate::rpc::test_support::services().await else {
        return;
    };
    let state = TransportState::new();
    let shared = SessionShared::new(state.clone());
    state.close();
    let (guard_tx, mut guard_rx) = mpsc::unbounded_channel();
    let session = Arc::new(VerifiedSession {
        uid: 1,
        client_id: "closed-generation-check".into(),
        generation: 0,
        version: crate::services::auth_token::TokenVersion::V2,
    });

    timeout(
        Duration::from_millis(100),
        generation_checks(shared, services, session, guard_tx),
    )
    .await
    .expect("closed generation checker exits without a five-second interval");
    assert!(guard_rx.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn full_output_queue_closes_after_send_timeout() {
    let state = TransportState::new();
    let (tx, mut output) = mpsc::channel(1);
    tx.send("A".into()).await.unwrap();
    let sink = RpcOutputSink {
        tx,
        state: state.clone(),
    };
    let sending = tokio::spawn(async move { sink.send_text("B".into()).await });
    tokio::task::yield_now().await;
    time::advance(SEND_TIMEOUT).await;
    tokio::task::yield_now().await;
    assert!(
        sending.is_finished(),
        "a slow reader must not hold a sender indefinitely"
    );
    assert_eq!(sending.await.unwrap(), Err(RpcIoError::Closed));
    assert!(state.is_closed());
    assert_eq!(output.recv().await.as_deref(), Some("A"));
    assert!(
        output.try_recv().is_err(),
        "the timed-out response is not published"
    );
}
