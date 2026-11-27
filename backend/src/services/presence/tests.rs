use super::*;
use crate::services::ws_registry::WsMetrics;
use diesel::r2d2::ConnectionManager;
use prometheus::Registry;

#[test]
fn crash_fallback_preserves_explicit_ends_and_caps_silent_expiry() {
    let active = chrono::DateTime::from_timestamp(1_000, 0)
        .unwrap()
        .naive_utc();
    let after = active + chrono::Duration::seconds(10);
    let late = active + chrono::Duration::seconds(100);
    assert_eq!(
        last_seen_with_crash_fallback(None, Some(active), after),
        Some(after)
    );
    assert_eq!(
        last_seen_with_crash_fallback(None, Some(active), late),
        Some(active + chrono::Duration::seconds(60))
    );
    assert_eq!(
        last_seen_with_crash_fallback(Some(after), Some(active), late),
        Some(after)
    );
    assert_eq!(
        last_seen_with_crash_fallback(Some(active), Some(active), late),
        Some(active)
    );
}

#[test]
fn blocked_friends_receive_long_ago_in_both_directions_despite_share_overrides() {
    for (blocking, blocked_by) in [(true, false), (false, true), (true, true)] {
        let peer = social::PeerRelationship {
            blocking,
            blocked_by,
            friends_since: Some(Utc::now()),
            shares_presence: Some(true),
            peer_shares_presence: Some(true),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(blocked_presence(2, &peer).unwrap()).unwrap(),
            serde_json::json!({"uid": 2, "online": false, "lastSeenBucket": "longAgo"}),
        );
    }
    assert!(blocked_presence(2, &social::PeerRelationship::default()).is_none());
}

#[test]
fn away_is_visible_only_with_exact_presence_permission() {
    let now = Utc::now();
    let away = Some(AppPresenceState::Inactive);
    let exact = user_presence(2, true, away, Some(now), now);
    assert!(!exact.online);
    assert_eq!(exact.away, Some(true));
    let private = user_presence(2, false, away, Some(now), now);
    let json = serde_json::to_value(private).unwrap();
    assert_eq!(json["lastSeenBucket"], "recently");
    assert_eq!(json["online"], false);
    assert!(json.get("away").is_none());
    assert!(json.get("lastSeenAt").is_none());
}

#[test]
fn hidden_presence_never_serializes_exact_activity() {
    let now = Utc::now();
    for (days, bucket) in [
        (0, LastSeenBucket::Recently),
        (2, LastSeenBucket::Recently),
        (3, LastSeenBucket::WithinWeek),
        (7, LastSeenBucket::WithinMonth),
        (30, LastSeenBucket::LongAgo),
    ] {
        let response = user_presence(
            2,
            false,
            None,
            Some(now - chrono::Duration::days(days)),
            now,
        );
        assert_eq!(response.last_seen_bucket, Some(bucket));
        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["online"], false);
        assert!(json.get("lastSeenAt").is_none());
    }
    let online = user_presence(
        2,
        false,
        Some(AppPresenceState::Active),
        Some(now - chrono::Duration::days(40)),
        now,
    );
    assert_eq!(online.last_seen_bucket, Some(LastSeenBucket::Recently));
    assert!(!online.online);
    assert!(online.last_seen_at.is_none());
    let unknown = user_presence(2, false, None, None, now);
    assert!(unknown.last_seen_bucket.is_none());
    let exact = user_presence(2, true, None, Some(now), now);
    assert_eq!(exact.last_seen_at, Some(now));
    assert!(exact.last_seen_bucket.is_none());
}

#[tokio::test]
async fn failed_scope_load_records_failure_without_counting_group_work() {
    let registry = Registry::new();
    let metrics = Arc::new(PresenceMetrics::new(&registry));
    let connections = Arc::new(ConnectionRegistry::new(Arc::new(WsMetrics::new(&registry))));
    // libpq rejects this option before attempting any connection.
    let db = DbPool::builder()
        .max_size(1)
        .min_idle(Some(0))
        .connection_timeout(Duration::from_millis(10))
        .build_unchecked(ConnectionManager::<PgConnection>::new(
            "presence_test_invalid_option=value",
        ));
    let last_seen = Arc::new(LastSeen::new(
        db.clone(),
        Arc::new(super::super::client_tracking::ClientTrackingMetrics::new(
            &registry,
        )),
    ));
    let presence = PresenceSnapshotService::new(db, connections, metrics, last_seen);

    assert!(presence
        .snapshot(7, Some(1), vec![], vec![123])
        .await
        .is_err());

    let rendered = crate::metrics::encode(&registry).expect("metrics should render");
    assert!(rendered.contains("presence_snapshot_duration_seconds_count{result=\"failure\"} 1"));
    assert!(rendered.contains("presence_scope_load_duration_seconds_count{result=\"failure\"} 1"));
    assert!(rendered.contains("presence_group_count_lookup_duration_seconds_count 0"));
    assert!(rendered
        .contains("presence_group_count_refresh_duration_seconds_count{result=\"failure\"} 0"));
    assert!(rendered.contains("presence_group_members_scanned_count 0"));
}

#[test]
fn global_presence_modes_and_missing_rows_default_to_everyone() {
    assert!(presence_is_visible(
        false,
        true,
        false,
        PresenceVisibility::Everyone,
        None,
        PresenceVisibility::Everyone,
        None,
    ));
    assert!(presence_is_visible(
        false,
        true,
        true,
        PresenceVisibility::Friends,
        None,
        PresenceVisibility::Friends,
        None,
    ));
    assert!(!presence_is_visible(
        false,
        true,
        false,
        PresenceVisibility::Friends,
        None,
        PresenceVisibility::Friends,
        None,
    ));
    assert!(!presence_is_visible(
        false,
        true,
        true,
        PresenceVisibility::Nobody,
        None,
        PresenceVisibility::Everyone,
        None,
    ));
}

#[test]
fn friend_overrides_take_precedence_and_require_reciprocity() {
    assert!(presence_is_visible(
        false,
        true,
        true,
        PresenceVisibility::Nobody,
        Some(true),
        PresenceVisibility::Nobody,
        Some(true),
    ));
    assert!(!presence_is_visible(
        false,
        true,
        true,
        PresenceVisibility::Everyone,
        Some(false),
        PresenceVisibility::Everyone,
        Some(true),
    ));
    assert!(!presence_is_visible(
        false,
        true,
        true,
        PresenceVisibility::Everyone,
        Some(true),
        PresenceVisibility::Everyone,
        Some(false),
    ));
}

#[test]
fn blocks_hide_individual_presence_but_self_remains_visible() {
    assert!(!presence_is_visible(
        false,
        false,
        true,
        PresenceVisibility::Everyone,
        Some(true),
        PresenceVisibility::Everyone,
        Some(true),
    ));
    assert!(presence_is_visible(
        true,
        false,
        false,
        PresenceVisibility::Nobody,
        None,
        PresenceVisibility::Nobody,
        None,
    ));
}
#[test]
fn rpc_presence_watch_rejects_malformed_scope_without_narrowing_it() {
    assert!(matches!(
        validate_presence_watch(Some(2), Some(vec![3]), Some(vec!["not-an-id".into()])),
        Err(AppError::BadRequest("Invalid presence watch"))
    ));
    assert!(matches!(
        validate_presence_watch(None, Some((0..101).collect()), None),
        Err(AppError::BadRequest("Invalid presence watch"))
    ));
    assert_eq!(
        parse_legacy_presence_watch(Some(2), Some(vec![3]), Some(vec!["not-an-id".into()])),
        Some(Some(PresenceWatch {
            request_id: Some(2),
            user_ids: vec![3],
            chat_ids: vec![],
        }))
    );
}
