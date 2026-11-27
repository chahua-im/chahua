use super::*;
use tokio::sync::oneshot;

fn summary(count: i64) -> ConversationUnreadSummary {
    ConversationUnreadSummary {
        key: "friends".into(),
        unread_message_count: count,
        ..Default::default()
    }
}
fn subscription(request_id: u32) -> Option<UnreadWatch> {
    Some(UnreadWatch {
        request_id,
        generation: 0,
        views: vec![],
        app_badge: true,
    })
}

#[test]
fn publishes_only_changed_absolute_counters_including_zero() {
    let mut state = Published::default();
    assert!(
        state
            .update(1, vec![summary(8)], Some(7), None)
            .unwrap()
            .full
    );
    assert!(state.update(1, vec![summary(8)], Some(7), None).is_none());
    let update = state.update(1, vec![summary(0)], Some(0), None).unwrap();
    assert!(!update.full);
    assert_eq!(update.summaries[0].unread_message_count, 0);
    assert_eq!(update.app_badge_count, Some(0));
    let badge_only = state.update(1, vec![summary(0)], Some(2), None).unwrap();
    assert!(badge_only.summaries.is_empty());
    assert_eq!(badge_only.app_badge_count, Some(2));
}

fn main_unread(show_unread_message_count: bool, chats: &[(i64, i64)]) -> Option<MainUnread> {
    Some(MainUnread {
        show_unread_message_count,
        chats: chats
            .iter()
            .map(
                |&(chat_id, unread_count)| crate::dto::conversations::MainUnreadChat {
                    chat_id,
                    unread_count,
                },
            )
            .collect(),
    })
}

#[test]
fn publishes_coherent_main_snapshot_for_swaps_counts_units_and_empty_replacement() {
    let mut state = Published::default();
    let first = state
        .update(
            1,
            vec![],
            Some(1),
            main_unread(false, &[(9007199254740993, 2)]),
        )
        .unwrap();
    assert!(first.full);
    assert_eq!(
        serde_json::to_value(first).unwrap()["mainUnread"],
        serde_json::json!({"showUnreadMessageCount": false, "chats": [{"chatId": "9007199254740993", "unreadCount": 2}]})
    );
    let swap = state
        .update(1, vec![], Some(1), main_unread(false, &[(i64::MAX, 2)]))
        .unwrap();
    assert!(!swap.full);
    assert!(swap.summaries.is_empty());
    assert_eq!(swap.app_badge_count, None);
    assert_eq!(swap.main_unread, main_unread(false, &[(i64::MAX, 2)]));
    let count_only = state
        .update(1, vec![], Some(1), main_unread(false, &[(i64::MAX, 3)]))
        .unwrap();
    assert_eq!(count_only.app_badge_count, None);
    assert_eq!(count_only.main_unread, main_unread(false, &[(i64::MAX, 3)]));
    assert!(state
        .update(1, vec![], Some(1), main_unread(false, &[(i64::MAX, 3)]))
        .is_none());
    let unit_only = state
        .update(1, vec![], Some(1), main_unread(true, &[(i64::MAX, 3)]))
        .unwrap();
    assert_eq!(unit_only.app_badge_count, None);
    assert_eq!(unit_only.main_unread, main_unread(true, &[(i64::MAX, 3)]));
    let counters_only = state
        .update(
            1,
            vec![summary(2)],
            Some(2),
            main_unread(true, &[(i64::MAX, 3)]),
        )
        .unwrap();
    assert_eq!(counters_only.main_unread, None);
    assert!(serde_json::to_value(counters_only)
        .unwrap()
        .get("mainUnread")
        .is_none());
    let cleared = state
        .update(1, vec![], Some(0), main_unread(true, &[]))
        .unwrap();
    assert!(!cleared.full);
    assert_eq!(
        serde_json::to_value(cleared).unwrap()["mainUnread"],
        serde_json::json!({"showUnreadMessageCount": true, "chats": []})
    );
    assert!(state
        .update(1, vec![], Some(0), main_unread(true, &[]))
        .is_none());
}

#[test]
fn full_publication_without_app_badge_omits_main_snapshot() {
    let payload = Published::default().update(1, vec![], None, None).unwrap();
    assert!(payload.full);
    let json = serde_json::to_value(payload).unwrap();
    assert!(json.get("appBadgeCount").is_none());
    assert!(json.get("mainUnread").is_none());
}

// A controlled loader verifies races without production DB access or wall-clock sleeps.
#[tokio::test]
async fn replacement_discards_inflight_snapshot_and_dirty_signal_survives_loading() {
    let (config, receiver) = watch::channel(None);
    let dirty = Arc::new(Notify::new());
    let (output, mut messages) = mpsc::channel(1);
    let (loads, mut requests) =
        mpsc::unbounded_channel::<(u32, oneshot::Sender<Result<Snapshot, String>>)>();
    let task = tokio::spawn(run_with(
        1,
        dirty.clone(),
        receiver,
        WatchOutput::Legacy(output),
        move |watch| {
            let (reply, response) = oneshot::channel();
            loads.send((watch.request_id, reply)).unwrap();
            async move { response.await.unwrap() }
        },
    ));
    config.send_replace(subscription(1));
    let (id, old) = requests.recv().await.unwrap();
    assert_eq!(id, 1);
    config.send_replace(subscription(2));
    old.send(Ok((
        vec![summary(99)],
        Some(99),
        main_unread(false, &[(99, 1)]),
        None,
    )))
    .unwrap();
    let (id, current) = requests.recv().await.unwrap();
    assert_eq!(id, 2);
    assert!(messages.try_recv().is_err());
    dirty.notify_one();
    dirty.notify_one();
    current
        .send(Ok((
            vec![summary(4)],
            Some(4),
            main_unread(false, &[(4, 1)]),
            None,
        )))
        .unwrap();
    let ServerWsMessage::ConversationUnread(first) = messages.recv().await.unwrap() else {
        panic!()
    };
    assert!(first.full);
    assert_eq!(first.request_id, 2);
    let (_, next) = tokio::time::timeout(Duration::from_secs(2), requests.recv())
        .await
        .unwrap()
        .unwrap();
    next.send(Ok((
        vec![summary(0)],
        Some(0),
        main_unread(false, &[]),
        None,
    )))
    .unwrap();
    let ServerWsMessage::ConversationUnread(update) = messages.recv().await.unwrap() else {
        panic!()
    };
    assert!(!update.full);
    assert_eq!(update.app_badge_count, Some(0));
    assert_eq!(update.main_unread, main_unread(false, &[]));
    config.send_replace(None);
    tokio::task::yield_now().await;
    dirty.notify_one();
    assert!(tokio::time::timeout(COALESCE * 2, requests.recv())
        .await
        .is_err());
    drop(config);
    task.await.unwrap();
}

#[tokio::test]
async fn mute_expiry_refreshes_without_messages_and_retry_restores_full_state() {
    let (config, receiver) = watch::channel(None);
    let dirty = Arc::new(Notify::new());
    let (output, mut messages) = mpsc::channel(1);
    let (loads, mut requests) =
        mpsc::unbounded_channel::<oneshot::Sender<Result<Snapshot, String>>>();
    let task = tokio::spawn(run_with(
        1,
        dirty,
        receiver,
        WatchOutput::Legacy(output),
        move |_| {
            let (reply, response) = oneshot::channel();
            loads.send(reply).unwrap();
            async move { response.await.unwrap() }
        },
    ));
    config.send_replace(subscription(1));
    requests
        .recv()
        .await
        .unwrap()
        .send(Ok((
            vec![summary(1)],
            Some(1),
            main_unread(false, &[(1, 1)]),
            Some(Utc::now() + chrono::Duration::milliseconds(30)),
        )))
        .unwrap();
    assert!(matches!(
        messages.recv().await,
        Some(ServerWsMessage::ConversationUnread(_))
    ));
    let retry = tokio::time::timeout(Duration::from_secs(2), requests.recv())
        .await
        .unwrap()
        .unwrap();
    retry.send(Err("offline".into())).unwrap();
    assert!(matches!(
        messages.recv().await,
        Some(ServerWsMessage::ConversationUnreadError(_))
    ));
    let recovered = tokio::time::timeout(Duration::from_secs(2), requests.recv())
        .await
        .unwrap()
        .unwrap();
    recovered
        .send(Ok((
            vec![summary(1)],
            Some(1),
            main_unread(false, &[(1, 1)]),
            None,
        )))
        .unwrap();
    let Some(ServerWsMessage::ConversationUnread(payload)) = messages.recv().await else {
        panic!()
    };
    assert!(payload.full); // Identical counters must still clear the client's error state.
    assert_eq!(payload.main_unread, main_unread(false, &[(1, 1)]));
    drop(config);
    task.await.unwrap();
}
