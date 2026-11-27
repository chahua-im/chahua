use super::{
    canonical_pair, directional_presence_overrides, friend_presence_override_from_db,
    friend_presence_override_to_db, merge_request_history,
};
use crate::models::{FriendPresenceOverride, FriendRequest, FriendRequestStatus};
use chrono::{DateTime, Utc};

fn request_history_entry(
    id: i64,
    created_at_seconds: i64,
    status: FriendRequestStatus,
) -> FriendRequest {
    FriendRequest {
        id,
        from_uid: 1,
        to_uid: 2,
        status,
        created_at: DateTime::<Utc>::from_timestamp(created_at_seconds, 0).unwrap(),
        decided_at: None,
        message: None,
        question: None,
    }
}

#[test]
fn merge_request_history_orders_all_statuses_with_id_tiebreak() {
    let incoming = vec![
        request_history_entry(10, 100, FriendRequestStatus::Pending),
        request_history_entry(30, 300, FriendRequestStatus::Accepted),
    ];
    let outgoing = vec![
        request_history_entry(20, 200, FriendRequestStatus::Rejected),
        request_history_entry(40, 300, FriendRequestStatus::Pending),
    ];

    let merged = merge_request_history(incoming, outgoing);

    assert_eq!(
        merged
            .into_iter()
            .map(|request| request.id)
            .collect::<Vec<_>>(),
        vec![40, 30, 20, 10],
    );
}

#[test]
fn canonical_pair_orders_low_high() {
    assert_eq!(canonical_pair(5, 3), (3, 5));
    assert_eq!(canonical_pair(3, 5), (3, 5));
    assert_eq!(canonical_pair(-1, 9), (-1, 9));
}

#[test]
fn presence_overrides_follow_both_canonical_friendship_directions() {
    assert_eq!(
        directional_presence_overrides(true, Some(true), Some(false)),
        (Some(true), Some(false))
    );
    assert_eq!(
        directional_presence_overrides(false, Some(true), Some(false)),
        (Some(false), Some(true))
    );
}

#[test]
fn presence_override_enum_round_trips_through_nullable_storage() {
    for (override_value, stored) in [
        (FriendPresenceOverride::Inherit, None),
        (FriendPresenceOverride::Share, Some(true)),
        (FriendPresenceOverride::Hide, Some(false)),
    ] {
        assert_eq!(friend_presence_override_to_db(override_value), stored);
        assert_eq!(friend_presence_override_from_db(stored), override_value);
    }
}
