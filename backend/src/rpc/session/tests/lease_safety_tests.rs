use super::*;

#[tokio::test]
async fn outbound_receive_cancellation_retains_text_and_its_byte_lease_pair() {
    let budget = budget(2);
    let state = TransportState::new();
    let (text_tx, text_rx) = mpsc::channel(1);
    let (lease_tx, lease_rx) = mpsc::channel(2);
    let mut output = RpcSessionOutput {
        rx: text_rx,
        permits: lease_rx,
        pending_text: None,
        state: state.clone(),
    };
    let lease_a = budget.reserve(1).expect("reserve A");
    let lease_b = budget.reserve(1).expect("reserve B");
    let (inbound_tx, mut inbound_rx) = mpsc::channel::<()>(1);

    text_tx.send("A".into()).await.expect("queue A text");
    let receive = tokio::spawn(async move {
        let selected = tokio::select! {
            frame = output.recv() => ("outbound", frame),
            _ = inbound_rx.recv() => ("inbound", None),
        };
        (selected, output)
    });

    // This cannot reserve until `recv` has consumed A and is paused awaiting
    // A's sidecar lease.
    let reserved = timeout(Duration::from_secs(1), text_tx.reserve())
        .await
        .expect("receive consumes A before the inbound select wins");
    drop(reserved);
    inbound_tx.send(()).await.expect("wake inbound select");
    let ((selected, cancelled_frame), mut output) = receive.await.expect("writer task joins");
    assert_eq!(selected, "inbound");
    assert!(cancelled_frame.is_none());

    lease_tx.send(lease_a).await.expect("queue A lease");
    text_tx.send("B".into()).await.expect("queue B text");
    lease_tx.send(lease_b).await.expect("queue B lease");

    let first = output.recv().await.expect("A survives cancellation");
    let (first_text, first_lease) = first.into_parts();
    assert_eq!(first_text, "A");
    assert!(matches!(
        budget.reserve(1),
        Err(RpcIoError::BudgetExhausted)
    ));
    drop(first_lease);
    let spare = budget
        .reserve(1)
        .expect("A lease releases only after writer drops it");

    let second = output.recv().await.expect("B remains correctly paired");
    let (second_text, second_lease) = second.into_parts();
    assert_eq!(second_text, "B");
    drop(second_lease);
    drop(spare);
    assert!(budget.reserve(2).is_ok());
    assert!(!state.is_closed());
}

#[tokio::test]
async fn cancelled_input_send_never_publishes_an_unpaired_frame_or_closes_transport() {
    let budget = budget(1);
    let state = TransportState::new();
    let (text_tx, mut text_rx) = mpsc::channel(1);
    let (lease_tx, mut lease_rx) = mpsc::channel(1);
    lease_tx
        .send((InputLease::Frame(RpcFrameLease::empty()), Instant::now()))
        .await
        .expect("occupy permit sidecar queue");
    let input = RpcSessionInput {
        tx: text_tx.clone(),
        permits: lease_tx,
        pair_lock: Arc::new(Mutex::new(())),
        budget,
        metrics: crate::metrics::Metrics::new().api,
        state: state.clone(),
    };
    let (cancel_tx, mut cancel_rx) = mpsc::channel::<()>(1);
    let send = tokio::spawn(async move {
        let outcome = tokio::select! {
            outcome = input.send("A".into()) => outcome,
            _ = cancel_rx.recv() => Err(RpcIoError::Closed),
        };
        (outcome, input)
    });

    // `send` has reserved the text slot but cannot publish it because its
    // permit sidecar queue is full.
    timeout(Duration::from_secs(1), async {
        while text_tx.capacity() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("input send reserved its text slot");
    cancel_tx.send(()).await.expect("cancel input send");
    let (outcome, input) = send.await.expect("reader task joins");
    assert_eq!(outcome, Err(RpcIoError::Closed));
    assert!(
        text_rx.try_recv().is_err(),
        "cancelled text was not published"
    );
    assert!(
        !state.is_closed(),
        "cancelling one send does not close live transport"
    );

    let (InputLease::Frame(placeholder), _) = lease_rx.recv().await.expect("placeholder lease")
    else {
        panic!("placeholder must be a normal frame lease");
    };
    drop(placeholder);
    input
        .send("B".into())
        .await
        .expect("later frame remains reachable");
    assert_eq!(text_rx.recv().await.as_deref(), Some("B"));
    let (InputLease::Frame(lease), _) = lease_rx.recv().await.expect("B lease") else {
        panic!("B must retain its normal frame lease");
    };
    drop(lease);
}

#[tokio::test]
async fn closed_transport_stops_owned_event_forwarder_immediately() {
    let state = TransportState::new();
    let shared = SessionShared::new(state.clone());
    state.close();
    let (events_tx, events_rx) = mpsc::channel(1);
    let (output_tx, mut output_rx) = mpsc::channel(1);
    let sink = RpcOutputSink {
        tx: output_tx,
        permits: mpsc::channel(1).0,
        pair_lock: Arc::new(Mutex::new(())),
        budget: budget(1),
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
async fn outbound_queue_progress_does_not_restart_the_ten_second_send_deadline() {
    let budget = budget(2);
    let state = TransportState::new();
    let (text_tx, mut text_rx) = mpsc::channel(1);
    let (lease_tx, mut lease_rx) = mpsc::channel(1);
    text_tx.send("A".into()).await.unwrap();
    lease_tx.send(budget.reserve(1).unwrap()).await.unwrap();
    let sink = RpcOutputSink {
        tx: text_tx,
        permits: lease_tx,
        pair_lock: Arc::new(Mutex::new(())),
        budget: budget.clone(),
        state: state.clone(),
    };
    let sending = tokio::spawn(async move { sink.send_text("B".into()).await });
    tokio::task::yield_now().await;
    time::advance(Duration::from_secs(8)).await;
    let held_text = text_rx.recv().await.unwrap();
    tokio::task::yield_now().await;
    // Text capacity became available, but the matching lease queue remains
    // occupied while the adapter handles an inbound message.
    time::advance(Duration::from_secs(2)).await;
    tokio::task::yield_now().await;
    assert!(
        sending.is_finished(),
        "partial queue progress must not extend the deadline"
    );
    assert_eq!(sending.await.unwrap(), Err(RpcIoError::Closed));
    assert!(state.is_closed());
    assert!(
        text_rx.try_recv().is_err(),
        "timed-out send publishes neither half"
    );
    drop(held_text);
    drop(lease_rx.recv().await.unwrap());
    assert!(
        budget.reserve(2).is_ok(),
        "all serialized-byte permits are released"
    );
}
