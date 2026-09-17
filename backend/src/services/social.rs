//! Social-graph DB logic: friendships, friend requests, and blocks.
//!
//! Chahua is the authoritative source for friend relationships and blocks.
//! All functions take a `&mut PgConnection` (borrowed from `DbConn`); the few
//! that need snowflake IDs are `async` and take `&AppState` for the generator.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use diesel::prelude::*;

use crate::errors::AppError;
use crate::models::{
    FriendAddVerificationMode, FriendRequest, FriendRequestStatus, GroupJoinReason, GroupKind,
    GroupRole, GroupVisibility, NewBlock, NewFriendRequest, NewFriendship, NewGroup,
    NewGroupMembership, NewUserExtra, PresenceVisibility,
};
use crate::schema::{blocks, friend_requests, friendships, group_membership, groups, user_extra};
use crate::services::user;
use crate::utils::ids;
use crate::AppState;

const UNRESOLVED_FRIEND_REQUEST_STATUSES: [FriendRequestStatus; 2] =
    [FriendRequestStatus::Pending, FriendRequestStatus::Archived];

/// Return the pair as `(min, max)` so each relationship is stored once.
fn canonical_pair(a: i32, b: i32) -> (i32, i32) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

/// Relationship facts for `uid` against many peers, keyed by peer uid.
#[derive(Default)]
pub struct PeerRelationship {
    pub friends_since: Option<chrono::DateTime<Utc>>,
    pub dm_chat_id: Option<i64>,
    pub blocking: bool,
    pub blocked_by: bool,
    /// `(id, uid_is_sender, created_at)`.
    pub pending_request: Option<(i64, bool, chrono::DateTime<Utc>)>,
}

/// The stored, viewer-independent portion of a user's presence.
#[derive(Debug, Clone, Copy)]
pub struct PresenceRecord {
    pub last_seen_at: Option<chrono::NaiveDateTime>,
    pub visibility: PresenceVisibility,
}

#[derive(Debug, Clone, Copy)]
pub struct VisiblePresence {
    pub visible: bool,
    pub last_seen_at: Option<chrono::NaiveDateTime>,
}

/// An immutable, transaction-time snapshot of one directed presence view.
/// `subject_uid` is the person whose presence is being sent to `viewer_uid`.
#[derive(Debug, Clone, Copy)]
pub struct DirectedPresenceReconciliation {
    pub viewer_uid: i32,
    pub subject_uid: i32,
    pub was_visible: bool,
    pub is_visible: bool,
    pub last_seen_at: Option<chrono::NaiveDateTime>,
}

/// Both directed views affected by a two-person social graph mutation.  These
/// facts are captured inside the mutation transaction; reconciliation must not
/// re-read the relationship after commit because that loses revocation targets.
#[derive(Debug, Clone, Copy)]
pub struct PresencePairReconciliation {
    pub first_to_second: DirectedPresenceReconciliation,
    pub second_to_first: DirectedPresenceReconciliation,
}

#[derive(Debug, Clone)]
pub struct PresenceVisibilityReconciliation {
    pub directions: Vec<DirectedPresenceReconciliation>,
}

/// The persisted visibility plus the transaction-time reconciliation facts.
/// The before/after visibility is already folded into the directions, so
/// callers must not re-read the relationship after commit.
#[derive(Debug, Clone)]
pub struct PresenceVisibilityMutation {
    pub visibility: PresenceVisibility,
    pub reconciliation: PresenceVisibilityReconciliation,
}

fn pair_presence_views(
    conn: &mut PgConnection,
    first_uid: i32,
    second_uid: i32,
) -> QueryResult<(VisiblePresence, VisiblePresence)> {
    let first_to_second =
        visible_presence_records(conn, second_uid, &[first_uid]).map(|mut records| {
            records
                .remove(&first_uid)
                .expect("presence pair lookup includes subject")
        })?;
    let second_to_first =
        visible_presence_records(conn, first_uid, &[second_uid]).map(|mut records| {
            records
                .remove(&second_uid)
                .expect("presence pair lookup includes subject")
        })?;
    Ok((first_to_second, second_to_first))
}

fn pair_reconciliation(
    first_uid: i32,
    second_uid: i32,
    before: (VisiblePresence, VisiblePresence),
    after: (VisiblePresence, VisiblePresence),
) -> PresencePairReconciliation {
    PresencePairReconciliation {
        first_to_second: DirectedPresenceReconciliation {
            viewer_uid: second_uid,
            subject_uid: first_uid,
            was_visible: before.0.visible,
            is_visible: after.0.visible,
            last_seen_at: after.0.last_seen_at,
        },
        second_to_first: DirectedPresenceReconciliation {
            viewer_uid: first_uid,
            subject_uid: second_uid,
            was_visible: before.1.visible,
            is_visible: after.1.visible,
            last_seen_at: after.1.last_seen_at,
        },
    }
}

/// The before/after visibility facts needed to reconcile an existing friend
/// relationship without attempting to infer the old setting after its update.
#[derive(Debug, Clone, Copy)]
pub struct PresenceVisibilityChange {
    pub previous: PresenceVisibility,
    pub current: PresenceVisibility,
}

#[derive(Debug, Clone, Copy)]
pub struct PresenceReconciliationPeer {
    pub uid: i32,
    pub was_visible: bool,
    pub is_visible: bool,
    pub last_seen_at: Option<chrono::NaiveDateTime>,
}

fn presence_pair_is_visible(
    viewer_uid: i32,
    target_uid: i32,
    viewer_visibility: PresenceVisibility,
    target_visibility: PresenceVisibility,
    are_friends: bool,
    blocked: bool,
) -> bool {
    if viewer_uid == target_uid {
        return true;
    }
    if blocked {
        return false;
    }
    let allows = |visibility| {
        visibility == PresenceVisibility::Everyone
            || (visibility == PresenceVisibility::Friends && are_friends)
    };
    allows(viewer_visibility) && allows(target_visibility)
}

/// Load presence records and apply the bilateral visibility policy for a viewer.
///
/// A missing `user_extra` row deliberately behaves like the product defaults:
/// `everyone` visibility and no observed last-seen time. The friendship and block
/// queries are split by canonical pair direction so they retain their index paths.
pub fn visible_presence_records(
    conn: &mut PgConnection,
    viewer_uid: i32,
    target_uids: &[i32],
) -> QueryResult<HashMap<i32, VisiblePresence>> {
    let targets: HashSet<i32> = target_uids.iter().copied().collect();
    if targets.is_empty() {
        return Ok(HashMap::new());
    }

    let mut extra_uids: Vec<i32> = targets.iter().copied().collect();
    if !targets.contains(&viewer_uid) {
        extra_uids.push(viewer_uid);
    }
    let records: HashMap<i32, PresenceRecord> = user_extra::table
        .filter(user_extra::uid.eq_any(extra_uids))
        .select((
            user_extra::uid,
            user_extra::last_seen_at,
            user_extra::presence_visibility,
        ))
        .load::<(i32, Option<chrono::NaiveDateTime>, PresenceVisibility)>(conn)?
        .into_iter()
        .map(|(uid, last_seen_at, visibility)| {
            (
                uid,
                PresenceRecord {
                    last_seen_at,
                    visibility,
                },
            )
        })
        .collect();

    let viewer_visibility = records
        .get(&viewer_uid)
        .map(|record| record.visibility)
        .unwrap_or(PresenceVisibility::Everyone);
    if viewer_visibility == PresenceVisibility::Nobody {
        return Ok(targets
            .into_iter()
            .map(|target| {
                let last_seen_at = (target == viewer_uid)
                    .then(|| records.get(&target).and_then(|record| record.last_seen_at))
                    .flatten();
                (
                    target,
                    VisiblePresence {
                        visible: target == viewer_uid,
                        last_seen_at,
                    },
                )
            })
            .collect());
    }

    let peers: Vec<i32> = targets
        .iter()
        .copied()
        .filter(|target| *target != viewer_uid)
        .collect();
    let greater: Vec<i32> = peers
        .iter()
        .copied()
        .filter(|target| *target > viewer_uid)
        .collect();
    let lesser: Vec<i32> = peers
        .iter()
        .copied()
        .filter(|target| *target < viewer_uid)
        .collect();
    let mut friends = HashSet::new();
    if !greater.is_empty() {
        friends.extend(
            friendships::table
                .filter(
                    friendships::uid1
                        .eq(viewer_uid)
                        .and(friendships::uid2.eq_any(&greater)),
                )
                .select(friendships::uid2)
                .load::<i32>(conn)?,
        );
    }
    if !lesser.is_empty() {
        friends.extend(
            friendships::table
                .filter(
                    friendships::uid2
                        .eq(viewer_uid)
                        .and(friendships::uid1.eq_any(&lesser)),
                )
                .select(friendships::uid1)
                .load::<i32>(conn)?,
        );
    }

    let mut blocked = HashSet::new();
    if !peers.is_empty() {
        blocked.extend(
            blocks::table
                .filter(
                    blocks::blocker_uid
                        .eq(viewer_uid)
                        .and(blocks::blocked_uid.eq_any(&peers)),
                )
                .select(blocks::blocked_uid)
                .load::<i32>(conn)?,
        );
        blocked.extend(
            blocks::table
                .filter(
                    blocks::blocked_uid
                        .eq(viewer_uid)
                        .and(blocks::blocker_uid.eq_any(&peers)),
                )
                .select(blocks::blocker_uid)
                .load::<i32>(conn)?,
        );
    }

    Ok(targets
        .into_iter()
        .map(|target| {
            if target == viewer_uid {
                return (
                    target,
                    VisiblePresence {
                        visible: true,
                        last_seen_at: records.get(&target).and_then(|record| record.last_seen_at),
                    },
                );
            }
            let target_record = records.get(&target).copied().unwrap_or(PresenceRecord {
                last_seen_at: None,
                visibility: PresenceVisibility::Everyone,
            });
            let are_friends = friends.contains(&target);
            let visible = presence_pair_is_visible(
                viewer_uid,
                target,
                viewer_visibility,
                target_record.visibility,
                are_friends,
                blocked.contains(&target),
            );
            (
                target,
                VisiblePresence {
                    visible,
                    last_seen_at: visible.then_some(target_record.last_seen_at).flatten(),
                },
            )
        })
        .collect())
}

/// Friends currently eligible to receive a presence event for `uid`, plus the
/// number of friend candidates considered before visibility/block filtering.
///
/// Presence events are intentionally narrower than REST presence: only friends
/// receive them, and each candidate must still pass the bilateral visibility and
/// block policy. All relationship lookups retain their indexed directional form.
pub struct PresenceBroadcastAudience {
    pub recipients: Vec<i32>,
    pub candidates: usize,
}

pub fn presence_broadcast_recipients(
    conn: &mut PgConnection,
    uid: i32,
) -> QueryResult<PresenceBroadcastAudience> {
    let mut recipients = friendships::table
        .filter(friendships::uid1.eq(uid))
        .select(friendships::uid2)
        .load::<i32>(conn)?;
    recipients.extend(
        friendships::table
            .filter(friendships::uid2.eq(uid))
            .select(friendships::uid1)
            .load::<i32>(conn)?,
    );
    if recipients.is_empty() {
        return Ok(PresenceBroadcastAudience {
            recipients,
            candidates: 0,
        });
    }

    let mut extra_uids = recipients.clone();
    extra_uids.push(uid);
    let visibilities: HashMap<i32, PresenceVisibility> = user_extra::table
        .filter(user_extra::uid.eq_any(extra_uids))
        .select((user_extra::uid, user_extra::presence_visibility))
        .load::<(i32, PresenceVisibility)>(conn)?
        .into_iter()
        .collect();
    let subject_visibility = visibilities
        .get(&uid)
        .copied()
        .unwrap_or(PresenceVisibility::Everyone);

    let mut blocked = HashSet::new();
    blocked.extend(
        blocks::table
            .filter(
                blocks::blocker_uid
                    .eq(uid)
                    .and(blocks::blocked_uid.eq_any(&recipients)),
            )
            .select(blocks::blocked_uid)
            .load::<i32>(conn)?,
    );
    blocked.extend(
        blocks::table
            .filter(
                blocks::blocked_uid
                    .eq(uid)
                    .and(blocks::blocker_uid.eq_any(&recipients)),
            )
            .select(blocks::blocker_uid)
            .load::<i32>(conn)?,
    );

    let candidates = recipients.len();
    recipients.retain(|viewer_uid| {
        let viewer_visibility = visibilities
            .get(viewer_uid)
            .copied()
            .unwrap_or(PresenceVisibility::Everyone);
        presence_pair_is_visible(
            *viewer_uid,
            uid,
            viewer_visibility,
            subject_visibility,
            true,
            blocked.contains(viewer_uid),
        )
    });
    Ok(PresenceBroadcastAudience {
        recipients,
        candidates,
    })
}

/// Return every friend whose bilateral eligibility changed when `uid` changed
/// their setting.  This deliberately reads the current peer settings and block
/// facts, while the caller supplies the old setting captured by the mutation.
pub fn presence_visibility_reconciliation_peers(
    conn: &mut PgConnection,
    uid: i32,
    previous_visibility: PresenceVisibility,
    current_visibility: PresenceVisibility,
) -> QueryResult<Vec<PresenceReconciliationPeer>> {
    let mut peers = friendships::table
        .filter(friendships::uid1.eq(uid))
        .select(friendships::uid2)
        .load::<i32>(conn)?;
    peers.extend(
        friendships::table
            .filter(friendships::uid2.eq(uid))
            .select(friendships::uid1)
            .load::<i32>(conn)?,
    );
    if peers.is_empty() {
        return Ok(Vec::new());
    }

    let peer_records: HashMap<i32, PresenceRecord> = user_extra::table
        .filter(user_extra::uid.eq_any(&peers))
        .select((
            user_extra::uid,
            user_extra::last_seen_at,
            user_extra::presence_visibility,
        ))
        .load::<(i32, Option<chrono::NaiveDateTime>, PresenceVisibility)>(conn)?
        .into_iter()
        .map(|(uid, last_seen_at, visibility)| {
            (
                uid,
                PresenceRecord {
                    last_seen_at,
                    visibility,
                },
            )
        })
        .collect();
    let mut blocked = HashSet::new();
    blocked.extend(
        blocks::table
            .filter(
                blocks::blocker_uid
                    .eq(uid)
                    .and(blocks::blocked_uid.eq_any(&peers)),
            )
            .select(blocks::blocked_uid)
            .load::<i32>(conn)?,
    );
    blocked.extend(
        blocks::table
            .filter(
                blocks::blocked_uid
                    .eq(uid)
                    .and(blocks::blocker_uid.eq_any(&peers)),
            )
            .select(blocks::blocker_uid)
            .load::<i32>(conn)?,
    );

    Ok(peers
        .into_iter()
        .map(|peer_uid| {
            let peer = peer_records
                .get(&peer_uid)
                .copied()
                .unwrap_or(PresenceRecord {
                    last_seen_at: None,
                    visibility: PresenceVisibility::Everyone,
                });
            let blocked = blocked.contains(&peer_uid);
            PresenceReconciliationPeer {
                uid: peer_uid,
                was_visible: presence_pair_is_visible(
                    peer_uid,
                    uid,
                    peer.visibility,
                    previous_visibility,
                    true,
                    blocked,
                ),
                is_visible: presence_pair_is_visible(
                    peer_uid,
                    uid,
                    peer.visibility,
                    current_visibility,
                    true,
                    blocked,
                ),
                last_seen_at: peer.last_seen_at,
            }
        })
        .collect())
}

pub fn get_presence_visibility(
    conn: &mut PgConnection,
    uid: i32,
) -> QueryResult<PresenceVisibility> {
    user_extra::table
        .filter(user_extra::uid.eq(uid))
        .select(user_extra::presence_visibility)
        .first(conn)
        .optional()
        .map(|visibility| visibility.unwrap_or(PresenceVisibility::Everyone))
}

pub fn presence_last_seen_at(
    conn: &mut PgConnection,
    uid: i32,
) -> QueryResult<Option<chrono::NaiveDateTime>> {
    user_extra::table
        .filter(user_extra::uid.eq(uid))
        .select(user_extra::last_seen_at)
        .first(conn)
        .optional()
        .map(|last_seen_at| last_seen_at.flatten())
}

/// Store a presence visibility preference without fabricating a last-seen value.
pub fn upsert_presence_visibility(
    conn: &mut PgConnection,
    uid: i32,
    visibility: PresenceVisibility,
) -> QueryResult<PresenceVisibilityMutation> {
    let now = Utc::now().naive_utc();
    conn.transaction(|conn| {
        let previous = get_presence_visibility(conn, uid)?;
        diesel::insert_into(user_extra::table)
            .values(NewUserExtra {
                uid,
                first_seen_at: now,
                last_seen_at: None,
                presence_visibility: visibility,
                sticker_pack_order: serde_json::json!([]),
                verification_mode: FriendAddVerificationMode::Direct,
                verification_question: None,
            })
            .on_conflict(user_extra::uid)
            .do_update()
            .set(user_extra::presence_visibility.eq(visibility))
            .execute(conn)?;
        let change = PresenceVisibilityChange {
            previous,
            current: visibility,
        };
        let own_last_seen_at = presence_last_seen_at(conn, uid)?;
        let peers = presence_visibility_reconciliation_peers(conn, uid, previous, visibility)?;
        let mut directions = Vec::with_capacity(peers.len() * 2);
        for peer in peers {
            directions.push(DirectedPresenceReconciliation {
                viewer_uid: peer.uid,
                subject_uid: uid,
                was_visible: peer.was_visible,
                is_visible: peer.is_visible,
                last_seen_at: own_last_seen_at,
            });
            directions.push(DirectedPresenceReconciliation {
                viewer_uid: uid,
                subject_uid: peer.uid,
                was_visible: peer.was_visible,
                is_visible: peer.is_visible,
                last_seen_at: peer.last_seen_at,
            });
        }
        if change.previous == change.current {
            // Idempotent PUT: no visibility change means no reconciliation.
            directions.clear();
        }
        Ok(PresenceVisibilityMutation {
            visibility: change.current,
            reconciliation: PresenceVisibilityReconciliation { directions },
        })
    })
}

/// Load relationship facts for `uid` against `peers`.
///
/// Pair queries are split into their canonical halves so every lookup uses an
/// existing index's leading column.
pub fn peer_relationships(
    conn: &mut PgConnection,
    uid: i32,
    peers: &[i32],
) -> QueryResult<HashMap<i32, PeerRelationship>> {
    let greater: Vec<i32> = peers.iter().copied().filter(|peer| *peer > uid).collect();
    let lesser: Vec<i32> = peers.iter().copied().filter(|peer| *peer < uid).collect();
    let mut relationships = peers
        .iter()
        .copied()
        .map(|peer| (peer, PeerRelationship::default()))
        .collect::<HashMap<_, _>>();

    if !greater.is_empty() {
        for (peer, created_at) in friendships::table
            .filter(
                friendships::uid1
                    .eq(uid)
                    .and(friendships::uid2.eq_any(&greater)),
            )
            .select((friendships::uid2, friendships::created_at))
            .load::<(i32, chrono::DateTime<Utc>)>(conn)?
        {
            relationships.entry(peer).or_default().friends_since = Some(created_at);
        }

        for (peer, chat_id) in groups::table
            .filter(
                groups::kind
                    .eq(GroupKind::Dm)
                    .and(groups::dm_uid1.eq(uid))
                    .and(groups::dm_uid2.eq_any(&greater)),
            )
            .select((groups::dm_uid2, groups::id))
            .load::<(Option<i32>, i64)>(conn)?
        {
            if let Some(peer) = peer {
                relationships.entry(peer).or_default().dm_chat_id = Some(chat_id);
            }
        }
    }

    if !lesser.is_empty() {
        for (peer, created_at) in friendships::table
            .filter(
                friendships::uid2
                    .eq(uid)
                    .and(friendships::uid1.eq_any(&lesser)),
            )
            .select((friendships::uid1, friendships::created_at))
            .load::<(i32, chrono::DateTime<Utc>)>(conn)?
        {
            relationships.entry(peer).or_default().friends_since = Some(created_at);
        }

        for (peer, chat_id) in groups::table
            .filter(
                groups::kind
                    .eq(GroupKind::Dm)
                    .and(groups::dm_uid2.eq(uid))
                    .and(groups::dm_uid1.eq_any(&lesser)),
            )
            .select((groups::dm_uid1, groups::id))
            .load::<(Option<i32>, i64)>(conn)?
        {
            if let Some(peer) = peer {
                relationships.entry(peer).or_default().dm_chat_id = Some(chat_id);
            }
        }
    }

    for peer in blocks::table
        .filter(
            blocks::blocker_uid
                .eq(uid)
                .and(blocks::blocked_uid.eq_any(peers)),
        )
        .select(blocks::blocked_uid)
        .load::<i32>(conn)?
    {
        relationships.entry(peer).or_default().blocking = true;
    }

    for peer in blocks::table
        .filter(
            blocks::blocked_uid
                .eq(uid)
                .and(blocks::blocker_uid.eq_any(peers)),
        )
        .select(blocks::blocker_uid)
        .load::<i32>(conn)?
    {
        relationships.entry(peer).or_default().blocked_by = true;
    }

    for (peer, id, created_at) in friend_requests::table
        .filter(
            friend_requests::status
                .eq_any(UNRESOLVED_FRIEND_REQUEST_STATUSES)
                .and(friend_requests::from_uid.eq(uid))
                .and(friend_requests::to_uid.eq_any(peers)),
        )
        .select((
            friend_requests::to_uid,
            friend_requests::id,
            friend_requests::created_at,
        ))
        .load::<(i32, i64, chrono::DateTime<Utc>)>(conn)?
    {
        relationships.entry(peer).or_default().pending_request = Some((id, true, created_at));
    }

    for (peer, id, created_at) in friend_requests::table
        .filter(
            friend_requests::status
                .eq_any(UNRESOLVED_FRIEND_REQUEST_STATUSES)
                .and(friend_requests::to_uid.eq(uid))
                .and(friend_requests::from_uid.eq_any(peers)),
        )
        .select((
            friend_requests::from_uid,
            friend_requests::id,
            friend_requests::created_at,
        ))
        .load::<(i32, i64, chrono::DateTime<Utc>)>(conn)?
    {
        relationships.entry(peer).or_default().pending_request = Some((id, false, created_at));
    }

    Ok(relationships)
}

pub fn are_mutual_friends(conn: &mut PgConnection, a: i32, b: i32) -> QueryResult<bool> {
    let (u1, u2) = canonical_pair(a, b);
    let count = friendships::table
        .filter(friendships::uid1.eq(u1).and(friendships::uid2.eq(u2)))
        .count()
        .get_result::<i64>(conn)?;
    Ok(count > 0)
}

pub fn is_blocked_either_direction(conn: &mut PgConnection, a: i32, b: i32) -> QueryResult<bool> {
    let count = blocks::table
        .filter(
            blocks::blocker_uid
                .eq(a)
                .and(blocks::blocked_uid.eq(b))
                .or(blocks::blocker_uid.eq(b).and(blocks::blocked_uid.eq(a))),
        )
        .count()
        .get_result::<i64>(conn)?;
    Ok(count > 0)
}

/// An unresolved friend request between the pair, in either direction.
fn find_unresolved_request_between(
    conn: &mut PgConnection,
    a: i32,
    b: i32,
) -> QueryResult<Option<FriendRequest>> {
    let (u1, u2) = canonical_pair(a, b);
    friend_requests::table
        .filter(
            friend_requests::status
                .eq_any(UNRESOLVED_FRIEND_REQUEST_STATUSES)
                .and(
                    friend_requests::from_uid
                        .eq(u1)
                        .and(friend_requests::to_uid.eq(u2))
                        .or(friend_requests::from_uid
                            .eq(u2)
                            .and(friend_requests::to_uid.eq(u1))),
                ),
        )
        .select(FriendRequest::as_select())
        .first::<FriendRequest>(conn)
        .optional()
}

/// Domain failures when a direct-message send is no longer permitted.
#[derive(Debug)]
pub enum DmSendAuthorizationError {
    CannotMessageSelf,
    FriendshipRequired,
    Blocked,
    Database(diesel::result::Error),
}

impl From<diesel::result::Error> for DmSendAuthorizationError {
    fn from(error: diesel::result::Error) -> Self {
        Self::Database(error)
    }
}

impl From<DmSendAuthorizationError> for AppError {
    fn from(error: DmSendAuthorizationError) -> Self {
        match error {
            DmSendAuthorizationError::CannotMessageSelf => {
                AppError::BadRequest("Cannot send a message to yourself")
            }
            DmSendAuthorizationError::FriendshipRequired => {
                AppError::Forbidden("You can only direct-message mutual friends")
            }
            DmSendAuthorizationError::Blocked => {
                AppError::Forbidden("Cannot direct-message this user")
            }
            DmSendAuthorizationError::Database(error) => AppError::from(error),
        }
    }
}

/// Gate member-initiated writes (pins, edits, deletions, reactions) for a chat:
/// regular groups are unaffected; a dead DM (friendship ended or blocked either
/// way) is rejected. Membership is the caller's responsibility.
pub fn require_chat_writable(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
) -> Result<(), AppError> {
    let (kind, dm_uid1, dm_uid2) = groups::table
        .filter(groups::id.eq(chat_id))
        .select((groups::kind, groups::dm_uid1, groups::dm_uid2))
        .first::<(GroupKind, Option<i32>, Option<i32>)>(conn)?;
    if kind != GroupKind::Dm {
        return Ok(());
    }
    let peer = match (dm_uid1, dm_uid2) {
        (Some(uid1), Some(uid2)) if uid1 == uid => uid2,
        (Some(uid1), Some(uid2)) if uid2 == uid => uid1,
        _ => return Err(AppError::Forbidden("Not a participant of this chat")),
    };
    require_dm_writable(conn, uid, peer)
}

/// A DM whose friendship has ended (unfriended or blocked either way) keeps its
/// history readable but accepts no further member-initiated writes: pins,
/// edits, deletions, and reactions, in addition to the message sends already
/// blocked by `check_can_dm`. System messages still go through.
///
/// The two causes return distinct messages so users can tell a block apart
/// from an ended friendship.
fn require_dm_writable(conn: &mut PgConnection, uid: i32, peer: i32) -> Result<(), AppError> {
    if is_blocked_either_direction(conn, uid, peer)? {
        return Err(AppError::Forbidden(
            "This chat is read-only because a block is in place",
        ));
    }
    if !are_mutual_friends(conn, uid, peer)? {
        return Err(AppError::Forbidden(
            "This chat is read-only because the friendship has ended",
        ));
    }
    Ok(())
}

/// Authorize sending a direct message to `peer`.
pub fn check_can_dm(
    conn: &mut PgConnection,
    sender: i32,
    peer: i32,
) -> Result<(), DmSendAuthorizationError> {
    if sender == peer {
        return Err(DmSendAuthorizationError::CannotMessageSelf);
    }
    if !are_mutual_friends(conn, sender, peer)? {
        return Err(DmSendAuthorizationError::FriendshipRequired);
    }
    if is_blocked_either_direction(conn, sender, peer)? {
        return Err(DmSendAuthorizationError::Blocked);
    }
    Ok(())
}

/// Create the canonical DM group for an accepted friendship.
///
/// Called from the friendship-acceptance transaction, so a committed
/// friendship always has its DM group. `id` is generated before entering the
/// transaction because ID generation is asynchronous.
fn create_dm_for_friendship(
    conn: &mut PgConnection,
    id: i64,
    user_a: i32,
    user_b: i32,
    now: chrono::DateTime<Utc>,
) -> Result<(), AppError> {
    let (u1, u2) = canonical_pair(user_a, user_b);
    let pair_filter = groups::kind
        .eq(GroupKind::Dm)
        .and(groups::dm_uid1.eq(u1))
        .and(groups::dm_uid2.eq(u2));
    let profiles = user::lookup_user_profiles(conn, &[u1, u2])?;
    let username_a = profiles
        .get(&u1)
        .and_then(|profile| profile.username.as_deref())
        .ok_or(AppError::Internal("DM participant username missing"))?;
    let username_b = profiles
        .get(&u2)
        .and_then(|profile| profile.username.as_deref())
        .ok_or(AppError::Internal("DM participant username missing"))?;
    let name = format!("{username_a} - {username_b}");

    let inserted = diesel::insert_into(groups::table)
        .values(&NewGroup {
            id,
            name,
            description: None,
            avatar_image_id: None,
            created_at: now,
            visibility: GroupVisibility::Private,
            kind: GroupKind::Dm,
            dm_uid1: Some(u1),
            dm_uid2: Some(u2),
        })
        .on_conflict_do_nothing()
        .execute(conn)?;
    if inserted == 0 {
        groups::table
            .filter(pair_filter)
            .select(groups::id)
            .first::<i64>(conn)
            .map_err(|_| AppError::Internal("Concurrent DM disappeared"))?;
        return Ok(());
    }

    diesel::insert_into(group_membership::table)
        .values(&[
            NewGroupMembership {
                chat_id: id,
                uid: user_a,
                role: GroupRole::Member,
                joined_at: now,
                join_reason: GroupJoinReason::Creator,
                join_reason_extra: None,
                last_read_message_id: None,
            },
            NewGroupMembership {
                chat_id: id,
                uid: user_b,
                role: GroupRole::Member,
                joined_at: now,
                join_reason: GroupJoinReason::DirectInvite,
                join_reason_extra: None,
                last_read_message_id: None,
            },
        ])
        .execute(conn)?;
    Ok(())
}

/// A user's friends with the friendship creation time (unordered).
pub fn list_friends_with_since(
    conn: &mut PgConnection,
    uid: i32,
) -> QueryResult<Vec<(i32, chrono::DateTime<Utc>)>> {
    let rows = friendships::table
        .filter(friendships::uid1.eq(uid).or(friendships::uid2.eq(uid)))
        .select((
            friendships::uid1,
            friendships::uid2,
            friendships::created_at,
        ))
        .load::<(i32, i32, chrono::DateTime<Utc>)>(conn)?;
    Ok(rows
        .into_iter()
        .map(|(u1, u2, since)| (if u1 == uid { u2 } else { u1 }, since))
        .collect())
}

/// UIDs the user has blocked with the block time, newest first.
pub fn list_blocks_with_since(
    conn: &mut PgConnection,
    blocker: i32,
) -> QueryResult<Vec<(i32, chrono::DateTime<Utc>)>> {
    blocks::table
        .filter(blocks::blocker_uid.eq(blocker))
        .order(blocks::created_at.desc())
        .select((blocks::blocked_uid, blocks::created_at))
        .load::<(i32, chrono::DateTime<Utc>)>(conn)
}

/// Remove the friendship between two users. Returns `true` if a row was deleted.
pub fn remove_friendship(conn: &mut PgConnection, a: i32, b: i32) -> QueryResult<bool> {
    let (u1, u2) = canonical_pair(a, b);
    let affected = diesel::delete(
        friendships::table.filter(friendships::uid1.eq(u1).and(friendships::uid2.eq(u2))),
    )
    .execute(conn)?;
    Ok(affected > 0)
}

pub fn remove_friendship_with_presence(
    conn: &mut PgConnection,
    a: i32,
    b: i32,
) -> QueryResult<(bool, PresencePairReconciliation)> {
    conn.transaction(|conn| {
        let before = pair_presence_views(conn, a, b)?;
        let removed = remove_friendship(conn, a, b)?;
        let after = pair_presence_views(conn, a, b)?;
        Ok((removed, pair_reconciliation(a, b, before, after)))
    })
}

/// Create a friendship row for `(a, b)` (idempotent).
fn insert_friendship(
    conn: &mut PgConnection,
    a: i32,
    b: i32,
    initiated_by: i32,
    now: chrono::DateTime<Utc>,
) -> QueryResult<()> {
    let (u1, u2) = canonical_pair(a, b);
    diesel::insert_into(friendships::table)
        .values(&NewFriendship {
            uid1: u1,
            uid2: u2,
            initiated_by,
            created_at: now,
        })
        .on_conflict((friendships::uid1, friendships::uid2))
        .do_nothing()
        .execute(conn)?;
    Ok(())
}

pub enum CreateRequestOutcome {
    /// A new pending request was created (notify `to_uid`).
    Created { request: FriendRequest },
    /// A reciprocal pending request was auto-accepted (notify the original
    /// requester). The pair presence facts are captured inside the acceptance
    /// transaction.
    AutoAccepted {
        request: FriendRequest,
        reconciliation: PresencePairReconciliation,
    },
    /// A pending request already exists for this pair (show "申请中").
    AlreadyPending,
    /// The users are already friends.
    AlreadyFriends,
}

/// A user's friend-acceptance settings. No `user_extra` row means the default (`Direct`).
pub fn get_friend_settings(
    conn: &mut PgConnection,
    uid: i32,
) -> Result<(FriendAddVerificationMode, Option<String>), AppError> {
    let row = user_extra::table
        .filter(user_extra::uid.eq(uid))
        .select((
            user_extra::verification_mode,
            user_extra::verification_question,
        ))
        .first::<(FriendAddVerificationMode, Option<String>)>(conn)
        .optional()?;
    match row {
        Some((mode, question)) => Ok((mode, question)),
        None => Ok((FriendAddVerificationMode::Direct, None)),
    }
}

/// Upsert a user's friend-acceptance settings, validating mode/question consistency.
/// Settings live on the `user_extra` row; the upsert only touches the two
/// verification columns on conflict so it never clobbers the analytics/sticker
/// columns. A brand-new row (user never triggered client tracking) is seeded with
/// neutral defaults for those NOT NULL columns.
pub fn upsert_friend_settings(
    conn: &mut PgConnection,
    uid: i32,
    mode: FriendAddVerificationMode,
    question: Option<String>,
) -> Result<(FriendAddVerificationMode, Option<String>), AppError> {
    let trimmed_question = question.and_then(|q| {
        let t = q.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    });
    match mode {
        FriendAddVerificationMode::Question => {
            if trimmed_question.is_none() {
                return Err(AppError::BadRequest(
                    "A question is required for question verification mode",
                ));
            }
        }
        _ => {
            if trimmed_question.is_some() {
                return Err(AppError::BadRequest(
                    "Question must be empty unless mode is question",
                ));
            }
        }
    }

    let now = Utc::now().naive_utc();
    let row = NewUserExtra {
        uid,
        first_seen_at: now,
        last_seen_at: None,
        presence_visibility: PresenceVisibility::Everyone,
        sticker_pack_order: serde_json::json!([]),
        verification_mode: mode,
        verification_question: trimmed_question.clone(),
    };
    let result = diesel::insert_into(user_extra::table)
        .values(&row)
        .on_conflict(user_extra::uid)
        .do_update()
        .set((
            user_extra::verification_mode.eq(mode),
            user_extra::verification_question.eq(trimmed_question),
        ))
        .returning((
            user_extra::verification_mode,
            user_extra::verification_question,
        ))
        .get_result::<(FriendAddVerificationMode, Option<String>)>(conn)?;
    Ok(result)
}

/// Apply the target's verification mode to a prospective request, returning the
/// `(message, question)` to persist. `question` is the snapshot of the target's
/// question (mode 3 only).
fn normalize_request_message(
    mode: FriendAddVerificationMode,
    message: Option<String>,
    target_question: Option<String>,
) -> Result<(Option<String>, Option<String>), AppError> {
    let trimmed = message.and_then(|m| {
        let t = m.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    });
    match mode {
        FriendAddVerificationMode::Forbid => Err(AppError::Forbidden("对方已设置拒绝添加好友")),
        FriendAddVerificationMode::Direct => Ok((None, None)),
        FriendAddVerificationMode::NeedMessage => {
            let m = trimmed.ok_or_else(|| AppError::BadRequest("验证消息不能为空"))?;
            Ok((Some(m), None))
        }
        FriendAddVerificationMode::Question => {
            let answer = trimmed.ok_or_else(|| AppError::BadRequest("请回答问题"))?;
            let q = target_question
                .ok_or_else(|| AppError::Internal("Question missing for question mode"))?;
            Ok((Some(answer), Some(q)))
        }
    }
}

pub async fn create_friend_request(
    conn: &mut PgConnection,
    state: &AppState,
    from: i32,
    to: i32,
    message: Option<String>,
) -> Result<CreateRequestOutcome, AppError> {
    if from == to {
        return Err(AppError::BadRequest(
            "Cannot send a friend request to yourself",
        ));
    }
    let now = Utc::now();

    if is_blocked_either_direction(conn, from, to)? {
        return Err(AppError::Forbidden(
            "Cannot send a friend request to a blocked user",
        ));
    }
    if are_mutual_friends(conn, from, to)? {
        return Ok(CreateRequestOutcome::AlreadyFriends);
    }
    if let Some(existing) = find_unresolved_request_between(conn, from, to)? {
        if existing.from_uid == from {
            return Ok(CreateRequestOutcome::AlreadyPending);
        }
        // Reciprocal pending request (to -> from): auto-accept it.
        let dm_group_id = ids::next_gid(state.id_gen.as_ref()).await.map_err(|err| {
            tracing::error!("failed to generate dm group id: {:?}", err);
            AppError::Internal("Failed to generate id")
        })?;
        let (request, reconciliation) = conn
            .transaction::<(FriendRequest, PresencePairReconciliation), AppError, _>(|conn| {
                let before = pair_presence_views(conn, from, to)?;
                let updated = diesel::update(
                    friend_requests::table
                        .filter(friend_requests::id.eq(existing.id))
                        .filter(friend_requests::from_uid.eq(to))
                        .filter(friend_requests::to_uid.eq(from))
                        .filter(friend_requests::status.eq_any(UNRESOLVED_FRIEND_REQUEST_STATUSES)),
                )
                .set((
                    friend_requests::status.eq(FriendRequestStatus::Accepted),
                    friend_requests::decided_at.eq(now),
                ))
                .returning(FriendRequest::as_returning())
                .get_result::<FriendRequest>(conn)
                .optional()?
                .ok_or(AppError::Conflict("Friend request is no longer pending"))?;
                insert_friendship(conn, from, to, from, now)?;
                create_dm_for_friendship(conn, dm_group_id, from, to, now)?;
                let after = pair_presence_views(conn, from, to)?;
                Ok((updated, pair_reconciliation(from, to, before, after)))
            })?;
        return Ok(CreateRequestOutcome::AutoAccepted {
            request,
            reconciliation,
        });
    }
    // Apply the target's verification settings to the new request.
    let (mode, target_question) = get_friend_settings(conn, to)?;
    let (message, question) = normalize_request_message(mode, message, target_question)?;

    let id = ids::next_id(&state.id_gen).await.map_err(|err| {
        tracing::error!("failed to generate friend request id: {:?}", err);
        AppError::Internal("Failed to generate id")
    })?;

    let request = conn.transaction::<FriendRequest, AppError, _>(|conn| {
        diesel::insert_into(friend_requests::table)
            .values(&NewFriendRequest {
                id,
                from_uid: from,
                to_uid: to,
                status: FriendRequestStatus::Pending,
                created_at: now,
                message,
                question,
            })
            .returning(FriendRequest::as_returning())
            .get_result(conn)
            .map_err(|err| match err {
                diesel::result::Error::DatabaseError(
                    diesel::result::DatabaseErrorKind::UniqueViolation,
                    _,
                ) => AppError::Conflict("Friend request already pending"),
                other => AppError::from(other),
            })
    })?;

    Ok(CreateRequestOutcome::Created { request })
}

/// Result of a recipient resolving a friend request.
pub enum ResolveOutcome {
    /// The request reached its terminal status normally. On an accept, the
    /// pair presence facts are captured inside the same transaction so the
    /// caller can hand them to the presence coordinator without re-reading
    /// the (now changed) relationship.
    Resolved(FriendRequest, Option<PresencePairReconciliation>),
    /// A reject claimed a pending request whose users are already friends. The
    /// request is dismissed as `Rejected` and the friendship is left intact;
    /// the caller must report the anomaly to the recipient.
    RejectedWhileFriends(FriendRequest),
}

impl ResolveOutcome {
    pub fn request(&self) -> &FriendRequest {
        match self {
            Self::Resolved(request, _) | Self::RejectedWhileFriends(request) => request,
        }
    }
}

/// Accept or reject a friend request. Only the recipient (`to_uid`) may resolve.
pub async fn resolve_friend_request(
    conn: &mut PgConnection,
    state: &AppState,
    resolver_uid: i32,
    request_id: i64,
    accept: bool,
) -> Result<ResolveOutcome, AppError> {
    let dm_group_id = if accept {
        Some(ids::next_gid(state.id_gen.as_ref()).await.map_err(|err| {
            tracing::error!("failed to generate dm group id: {:?}", err);
            AppError::Internal("Failed to generate id")
        })?)
    } else {
        None
    };
    let now = Utc::now();
    conn.transaction::<ResolveOutcome, AppError, _>(|conn| {
        let new_status = if accept {
            FriendRequestStatus::Accepted
        } else {
            FriendRequestStatus::Rejected
        };
        let request = diesel::update(
            friend_requests::table
                .filter(friend_requests::id.eq(request_id))
                .filter(friend_requests::to_uid.eq(resolver_uid))
                .filter(friend_requests::status.eq_any(UNRESOLVED_FRIEND_REQUEST_STATUSES)),
        )
        .set((
            friend_requests::status.eq(new_status),
            friend_requests::decided_at.eq(now),
        ))
        .returning(FriendRequest::as_returning())
        .get_result::<FriendRequest>(conn)
        .optional()?;

        let Some(request) = request else {
            let existing_recipient = friend_requests::table
                .filter(friend_requests::id.eq(request_id))
                .select(friend_requests::to_uid)
                .first::<i32>(conn)
                .optional()?;
            return match existing_recipient {
                None => Err(AppError::NotFound("Friend request not found")),
                Some(to_uid) if to_uid != resolver_uid => Err(AppError::Forbidden(
                    "Only the recipient can respond to this friend request",
                )),
                Some(_) => Err(AppError::Conflict("Friend request is no longer pending")),
            };
        };

        if let Some(dm_group_id) = dm_group_id {
            let first_uid = request.from_uid;
            let second_uid = request.to_uid;
            let before = pair_presence_views(conn, first_uid, second_uid)?;
            insert_friendship(conn, first_uid, second_uid, first_uid, now)?;
            create_dm_for_friendship(conn, dm_group_id, first_uid, second_uid, now)?;
            let after = pair_presence_views(conn, first_uid, second_uid)?;
            return Ok(ResolveOutcome::Resolved(
                request,
                Some(pair_reconciliation(first_uid, second_uid, before, after)),
            ));
        }
        if are_mutual_friends(conn, request.from_uid, request.to_uid)? {
            return Ok(ResolveOutcome::RejectedWhileFriends(request));
        }
        Ok(ResolveOutcome::Resolved(request, None))
    })
}

pub fn archive_friend_request(
    conn: &mut PgConnection,
    uid: i32,
    request_id: i64,
) -> Result<(), AppError> {
    let affected = diesel::update(
        friend_requests::table
            .filter(friend_requests::id.eq(request_id))
            .filter(friend_requests::to_uid.eq(uid))
            .filter(friend_requests::status.eq(FriendRequestStatus::Pending)),
    )
    .set(friend_requests::status.eq(FriendRequestStatus::Archived))
    .execute(conn)?;
    if affected == 0 {
        return Err(AppError::NotFound("Pending friend request not found"));
    }
    Ok(())
}

/// List incoming friend requests, optionally filtered by archive state, newest first.
fn list_incoming_request_history(
    conn: &mut PgConnection,
    uid: i32,
    archived: Option<bool>,
) -> QueryResult<Vec<FriendRequest>> {
    let mut query = friend_requests::table
        .filter(friend_requests::to_uid.eq(uid))
        .into_boxed();
    match archived {
        Some(false) => {
            query = query.filter(friend_requests::status.eq(FriendRequestStatus::Pending));
        }
        Some(true) => {
            query = query.filter(friend_requests::status.ne(FriendRequestStatus::Pending));
        }
        None => {}
    }
    query
        .order((
            friend_requests::created_at.desc(),
            friend_requests::id.desc(),
        ))
        .select(FriendRequest::as_select())
        .load::<FriendRequest>(conn)
}

/// List outgoing requests, all of which belong to the sender's archived view.
fn list_outgoing_request_history(
    conn: &mut PgConnection,
    uid: i32,
    archived: Option<bool>,
) -> QueryResult<Vec<FriendRequest>> {
    if archived == Some(false) {
        return Ok(Vec::new());
    }
    friend_requests::table
        .filter(friend_requests::from_uid.eq(uid))
        .order((
            friend_requests::created_at.desc(),
            friend_requests::id.desc(),
        ))
        .select(FriendRequest::as_select())
        .load::<FriendRequest>(conn)
}

/// Newest-first merge of both history directions, ties broken by descending id.
fn merge_request_history(
    incoming: Vec<FriendRequest>,
    outgoing: Vec<FriendRequest>,
) -> Vec<FriendRequest> {
    let mut merged = incoming;
    merged.extend(outgoing);
    merged.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    merged
}

/// Friend requests involving `uid`, optionally filtered by archive state, newest first.
pub fn list_friend_request_history(
    conn: &mut PgConnection,
    uid: i32,
    archived: Option<bool>,
) -> QueryResult<Vec<FriendRequest>> {
    let incoming = list_incoming_request_history(conn, uid, archived)?;
    let outgoing = list_outgoing_request_history(conn, uid, archived)?;
    Ok(merge_request_history(incoming, outgoing))
}

/// Number of pending friend requests directed at `uid`; drives the request badge.
pub fn count_pending_incoming_requests(conn: &mut PgConnection, uid: i32) -> QueryResult<i64> {
    friend_requests::table
        .filter(
            friend_requests::to_uid
                .eq(uid)
                .and(friend_requests::status.eq(FriendRequestStatus::Pending)),
        )
        .count()
        .get_result(conn)
}

/// Block a user. Idempotent. Blocking only gates communication: it preserves
/// existing friendships and pending friend requests.
pub fn block_user_with_presence(
    conn: &mut PgConnection,
    blocker: i32,
    blocked: i32,
) -> Result<(bool, PresencePairReconciliation), AppError> {
    if blocker == blocked {
        return Err(AppError::BadRequest("Cannot block yourself"));
    }
    conn.transaction::<_, AppError, _>(|conn| {
        let before = pair_presence_views(conn, blocker, blocked)?;
        let now = Utc::now();
        let affected = diesel::insert_into(blocks::table)
            .values(&NewBlock {
                blocker_uid: blocker,
                blocked_uid: blocked,
                created_at: now,
            })
            .on_conflict((blocks::blocker_uid, blocks::blocked_uid))
            .do_nothing()
            .execute(conn)?;
        let after = pair_presence_views(conn, blocker, blocked)?;
        Ok((
            affected > 0,
            pair_reconciliation(blocker, blocked, before, after),
        ))
    })
}

/// Unblock a user. Returns `true` if a block was removed.
pub fn unblock_user_with_presence(
    conn: &mut PgConnection,
    blocker: i32,
    blocked: i32,
) -> Result<(bool, PresencePairReconciliation), AppError> {
    conn.transaction::<_, AppError, _>(|conn| {
        let before = pair_presence_views(conn, blocker, blocked)?;
        let removed = diesel::delete(
            blocks::table.filter(
                blocks::blocker_uid
                    .eq(blocker)
                    .and(blocks::blocked_uid.eq(blocked)),
            ),
        )
        .execute(conn)?;
        let after = pair_presence_views(conn, blocker, blocked)?;
        Ok((
            removed > 0,
            pair_reconciliation(blocker, blocked, before, after),
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::{canonical_pair, merge_request_history, presence_pair_is_visible};
    use crate::models::{FriendRequest, FriendRequestStatus, PresenceVisibility};
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
    fn presence_visibility_is_bilateral_and_block_safe() {
        use PresenceVisibility::{Everyone, Friends, Nobody};

        for (viewer, target, friends, expected) in [
            (Everyone, Everyone, false, true),
            (Everyone, Friends, false, false),
            (Friends, Everyone, false, false),
            (Friends, Friends, true, true),
            (Nobody, Everyone, true, false),
        ] {
            assert_eq!(
                presence_pair_is_visible(1, 2, viewer, target, friends, false),
                expected
            );
        }
        assert!(!presence_pair_is_visible(
            1, 2, Everyone, Everyone, true, true
        ));
        assert!(presence_pair_is_visible(1, 1, Nobody, Nobody, false, true));
    }

    /// The full §3 truth table: every (viewer, target) visibility pair ×
    /// friends / non-friends. `presence_pair_is_visible` is symmetric in its
    /// visibility arguments only through the shared `are_friends` input, so
    /// both directions of each row are asserted.
    #[test]
    fn presence_visibility_covers_the_full_truth_table() {
        use PresenceVisibility::{Everyone, Friends, Nobody};
        let levels = [Everyone, Friends, Nobody];
        // (viewer setting, target setting) => visible when friends.
        let expected_friends = [
            [true, true, false],
            [true, true, false],
            [false, false, false],
        ];
        for (vi, &viewer) in levels.iter().enumerate() {
            for (ti, &target) in levels.iter().enumerate() {
                assert_eq!(
                    presence_pair_is_visible(1, 2, viewer, target, true, false),
                    expected_friends[vi][ti],
                    "friends case viewer={viewer:?} target={target:?}"
                );
                // Non-friends: only everyone×everyone is visible.
                assert_eq!(
                    presence_pair_is_visible(2, 1, target, viewer, false, false),
                    (vi == 0 && ti == 0),
                    "non-friend case viewer={viewer:?} target={target:?}"
                );
            }
        }
    }

    #[test]
    fn presence_visibility_blocks_both_directions_and_keeps_self_visible() {
        use PresenceVisibility::{Everyone, Friends, Nobody};
        for (viewer, target) in [
            (Everyone, Everyone),
            (Friends, Friends),
            (Nobody, Nobody),
            (Everyone, Friends),
            (Friends, Everyone),
        ] {
            assert!(
                !presence_pair_is_visible(1, 2, viewer, target, true, true),
                "any block direction hides the pair for viewer={viewer:?} target={target:?}"
            );
            assert!(
                !presence_pair_is_visible(2, 1, target, viewer, true, true),
                "reverse direction viewer={target:?} target={viewer:?}"
            );
        }
        // Self is always visible regardless of settings or a (theoretical)
        // block record.
        assert!(presence_pair_is_visible(7, 7, Nobody, Nobody, false, true));
    }
}
