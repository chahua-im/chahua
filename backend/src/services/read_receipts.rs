//! Direct-message read receipt storage, visibility, and realtime invalidation.
//!
//! Receipt markers are deliberately separate from unread cursors: clients may
//! rewind unread state and deleted messages may move an unread cursor, but a
//! read receipt is a monotonic high-water mark.

use diesel::prelude::*;
use diesel::PgConnection;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::dto::ws::{ReadReceiptChangedPayload, ServerWsMessage};
use crate::errors::AppError;
use crate::models::{GroupKind, ReadReceiptVisibility};
use crate::schema::{
    blocks, friendships, group_membership, groups, messages, thread_user_states, user_extra,
};
use crate::services::ws_registry::ConnectionRegistry;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DmParticipants {
    first: i32,
    second: i32,
}

impl DmParticipants {
    fn peer_for(self, uid: i32) -> Option<i32> {
        if uid == self.first {
            Some(self.second)
        } else if uid == self.second {
            Some(self.first)
        } else {
            None
        }
    }
}

fn canonical_pair(a: i32, b: i32) -> (i32, i32) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

fn shares_read_receipts(visibility: ReadReceiptVisibility, override_value: Option<bool>) -> bool {
    override_value.unwrap_or(match visibility {
        ReadReceiptVisibility::Friends => true,
        ReadReceiptVisibility::Nobody => false,
    })
}

fn read_receipt_is_visible(
    is_friend: bool,
    is_blocked: bool,
    viewer_visibility: ReadReceiptVisibility,
    viewer_override: Option<bool>,
    peer_visibility: ReadReceiptVisibility,
    peer_override: Option<bool>,
) -> bool {
    is_friend
        && !is_blocked
        && shares_read_receipts(viewer_visibility, viewer_override)
        && shares_read_receipts(peer_visibility, peer_override)
}

fn dm_participants(
    conn: &mut PgConnection,
    chat_id: i64,
) -> Result<Option<DmParticipants>, diesel::result::Error> {
    let row = groups::table
        .filter(groups::id.eq(chat_id).and(groups::kind.eq(GroupKind::Dm)))
        .select((groups::dm_uid1, groups::dm_uid2))
        .first::<(Option<i32>, Option<i32>)>(conn)
        .optional()?;
    Ok(row.and_then(|(first, second)| {
        Some(DmParticipants {
            first: first?,
            second: second?,
        })
    }))
}

/// Return a DM's other participant for a member. Group chats never have a
/// read-receipt scope.
pub fn dm_peer_for_member(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
) -> Result<Option<i32>, AppError> {
    Ok(dm_participants(conn, chat_id)?.and_then(|participants| participants.peer_for(uid)))
}

/// Validate a top-level chat read target before either cursor advances.
pub fn validate_chat_read_target(
    conn: &mut PgConnection,
    chat_id: i64,
    message_id: i64,
) -> Result<(), AppError> {
    let exists = diesel::select(diesel::dsl::exists(
        messages::table.filter(
            messages::id
                .eq(message_id)
                .and(messages::chat_id.eq(chat_id))
                .and(messages::reply_root_id.is_null())
                .and(messages::is_published.eq(true)),
        ),
    ))
    .get_result(conn)?;
    if exists {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "Read target must be a published top-level message in this chat",
        ))
    }
}

/// Validate the root-message target used when a client explicitly reads a
/// thread with no replies.
pub fn validate_thread_root_read_target(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
) -> Result<(), AppError> {
    validate_chat_read_target(conn, chat_id, thread_root_id)
}

/// Validate a thread reply read target before either cursor advances.
pub fn validate_thread_read_target(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
    message_id: i64,
) -> Result<(), AppError> {
    let exists = diesel::select(diesel::dsl::exists(
        messages::table.filter(
            messages::id
                .eq(message_id)
                .and(messages::chat_id.eq(chat_id))
                .and(messages::reply_root_id.eq(thread_root_id))
                .and(messages::is_published.eq(true)),
        ),
    ))
    .get_result(conn)?;
    if exists {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "Read target must be a published reply in this thread",
        ))
    }
}

/// Advance the chat receipt high-water marker without changing unread state.
pub fn advance_chat_read_receipt(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
    message_id: i64,
) -> Result<bool, diesel::result::Error> {
    use crate::schema::group_membership::dsl as gm;

    let updated = diesel::update(
        group_membership::table.filter(
            gm::chat_id.eq(chat_id).and(gm::uid.eq(uid)).and(
                gm::last_read_receipt_message_id
                    .is_null()
                    .or(gm::last_read_receipt_message_id.lt(message_id)),
            ),
        ),
    )
    .set(gm::last_read_receipt_message_id.eq(Some(message_id)))
    .execute(conn)?;
    Ok(updated > 0)
}

/// Advance the thread receipt high-water marker without changing unread state.
pub fn advance_thread_read_receipt(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
    uid: i32,
    message_id: i64,
) -> Result<bool, diesel::result::Error> {
    let updated = diesel::update(
        thread_user_states::table.filter(
            thread_user_states::chat_id
                .eq(chat_id)
                .and(thread_user_states::thread_root_id.eq(thread_root_id))
                .and(thread_user_states::uid.eq(uid))
                .and(
                    thread_user_states::last_read_receipt_message_id
                        .is_null()
                        .or(thread_user_states::last_read_receipt_message_id.lt(message_id)),
                ),
        ),
    )
    .set(thread_user_states::last_read_receipt_message_id.eq(Some(message_id)))
    .execute(conn)?;
    Ok(updated > 0)
}

/// Return the peer's visible receipt for one DM scope. The caller must have
/// already passed membership authorization for `chat_id`.
pub fn get_read_receipt(
    conn: &mut PgConnection,
    viewer_uid: i32,
    chat_id: i64,
    thread_root_id: Option<i64>,
) -> Result<Option<i64>, AppError> {
    let Some(peer_uid) = dm_peer_for_member(conn, chat_id, viewer_uid)? else {
        return Err(AppError::NotFound(
            "Read receipts are only available for direct messages",
        ));
    };
    let (uid1, uid2) = canonical_pair(viewer_uid, peer_uid);
    let friendship = friendships::table
        .filter(friendships::uid1.eq(uid1).and(friendships::uid2.eq(uid2)))
        .select((
            friendships::uid1_shares_read_receipts,
            friendships::uid2_shares_read_receipts,
        ))
        .first::<(Option<bool>, Option<bool>)>(conn)
        .optional()?;
    let Some((uid1_override, uid2_override)) = friendship else {
        return Ok(None);
    };

    let blocked = diesel::select(diesel::dsl::exists(
        blocks::table.filter(
            blocks::blocker_uid
                .eq(viewer_uid)
                .and(blocks::blocked_uid.eq(peer_uid))
                .or(blocks::blocker_uid
                    .eq(peer_uid)
                    .and(blocks::blocked_uid.eq(viewer_uid))),
        ),
    ))
    .get_result(conn)?;
    let visibilities = user_extra::table
        .filter(user_extra::uid.eq_any([viewer_uid, peer_uid]))
        .select((user_extra::uid, user_extra::read_receipt_visibility))
        .load::<(i32, ReadReceiptVisibility)>(conn)?;
    let viewer_visibility = visibilities
        .iter()
        .find_map(|(uid, visibility)| (*uid == viewer_uid).then_some(*visibility))
        .unwrap_or(ReadReceiptVisibility::Friends);
    let peer_visibility = visibilities
        .iter()
        .find_map(|(uid, visibility)| (*uid == peer_uid).then_some(*visibility))
        .unwrap_or(ReadReceiptVisibility::Friends);
    let (viewer_override, peer_override) = if viewer_uid == uid1 {
        (uid1_override, uid2_override)
    } else {
        (uid2_override, uid1_override)
    };
    if !read_receipt_is_visible(
        true,
        blocked,
        viewer_visibility,
        viewer_override,
        peer_visibility,
        peer_override,
    ) {
        return Ok(None);
    }

    let receipt = match thread_root_id {
        Some(thread_root_id) => thread_user_states::table
            .filter(
                thread_user_states::chat_id
                    .eq(chat_id)
                    .and(thread_user_states::thread_root_id.eq(thread_root_id))
                    .and(thread_user_states::uid.eq(peer_uid)),
            )
            .select(thread_user_states::last_read_receipt_message_id)
            .first(conn)
            .optional()?
            .flatten(),
        None => group_membership::table
            .filter(
                group_membership::chat_id
                    .eq(chat_id)
                    .and(group_membership::uid.eq(peer_uid)),
            )
            .select(group_membership::last_read_receipt_message_id)
            .first(conn)
            .optional()?
            .flatten(),
    };
    Ok(receipt)
}

/// DM chats in `chat_ids` whose peer receipt is visible to `viewer_uid`.
fn visible_dm_peers(
    conn: &mut PgConnection,
    viewer_uid: i32,
    chat_ids: &[i64],
) -> Result<HashMap<i64, i32>, diesel::result::Error> {
    if chat_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = groups::table
        .filter(groups::id.eq_any(chat_ids))
        .filter(groups::kind.eq(GroupKind::Dm))
        .select((groups::id, groups::dm_uid1, groups::dm_uid2))
        .load::<(i64, Option<i32>, Option<i32>)>(conn)?;
    let mut peers = HashMap::new();
    for (chat_id, first, second) in rows {
        let (Some(first), Some(second)) = (first, second) else {
            continue;
        };
        let peer = if first == viewer_uid {
            second
        } else if second == viewer_uid {
            first
        } else {
            continue;
        };
        peers.insert(chat_id, peer);
    }
    if peers.is_empty() {
        return Ok(peers);
    }

    let peer_uids: Vec<i32> = peers
        .values()
        .copied()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let friend_rows = friendships::table
        .filter(
            friendships::uid1
                .eq(viewer_uid)
                .and(friendships::uid2.eq_any(&peer_uids))
                .or(friendships::uid2
                    .eq(viewer_uid)
                    .and(friendships::uid1.eq_any(&peer_uids))),
        )
        .select((
            friendships::uid1,
            friendships::uid2,
            friendships::uid1_shares_read_receipts,
            friendships::uid2_shares_read_receipts,
        ))
        .load::<(i32, i32, Option<bool>, Option<bool>)>(conn)?;
    let friendship_map: HashMap<(i32, i32), (Option<bool>, Option<bool>)> = friend_rows
        .into_iter()
        .map(|(uid1, uid2, uid1_override, uid2_override)| {
            ((uid1, uid2), (uid1_override, uid2_override))
        })
        .collect();
    let blocked_pairs: HashSet<(i32, i32)> = blocks::table
        .filter(
            blocks::blocker_uid
                .eq(viewer_uid)
                .and(blocks::blocked_uid.eq_any(&peer_uids))
                .or(blocks::blocker_uid
                    .eq_any(&peer_uids)
                    .and(blocks::blocked_uid.eq(viewer_uid))),
        )
        .select((blocks::blocker_uid, blocks::blocked_uid))
        .load::<(i32, i32)>(conn)?
        .into_iter()
        .map(|(blocker, blocked)| canonical_pair(blocker, blocked))
        .collect();

    let mut visibility_uids = peer_uids;
    visibility_uids.push(viewer_uid);
    let visibility_map: HashMap<i32, ReadReceiptVisibility> = user_extra::table
        .filter(user_extra::uid.eq_any(&visibility_uids))
        .select((user_extra::uid, user_extra::read_receipt_visibility))
        .load::<(i32, ReadReceiptVisibility)>(conn)?
        .into_iter()
        .collect();
    let viewer_visibility = visibility_map
        .get(&viewer_uid)
        .copied()
        .unwrap_or(ReadReceiptVisibility::Friends);
    peers.retain(|_, peer| {
        let pair = canonical_pair(viewer_uid, *peer);
        let Some((uid1_override, uid2_override)) = friendship_map.get(&pair) else {
            return false;
        };
        let (viewer_override, peer_override) = if pair.0 == viewer_uid {
            (*uid1_override, *uid2_override)
        } else {
            (*uid2_override, *uid1_override)
        };
        let peer_visibility = visibility_map
            .get(peer)
            .copied()
            .unwrap_or(ReadReceiptVisibility::Friends);
        read_receipt_is_visible(
            true,
            blocked_pairs.contains(&pair),
            viewer_visibility,
            viewer_override,
            peer_visibility,
            peer_override,
        )
    });
    Ok(peers)
}

/// Peer receipts for a page of DM chats, keyed by chat id.
pub fn visible_chat_receipts(
    conn: &mut PgConnection,
    viewer_uid: i32,
    chat_ids: &[i64],
) -> Result<HashMap<i64, i64>, diesel::result::Error> {
    let peers = visible_dm_peers(conn, viewer_uid, chat_ids)?;
    if peers.is_empty() {
        return Ok(HashMap::new());
    }
    let chat_ids: Vec<i64> = peers.keys().copied().collect();
    let peer_uids: Vec<i32> = peers
        .values()
        .copied()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let rows = group_membership::table
        .filter(group_membership::chat_id.eq_any(&chat_ids))
        .filter(group_membership::uid.eq_any(&peer_uids))
        .select((
            group_membership::chat_id,
            group_membership::uid,
            group_membership::last_read_receipt_message_id,
        ))
        .load::<(i64, i32, Option<i64>)>(conn)?;
    Ok(rows
        .into_iter()
        .filter(|(chat_id, uid, _)| peers.get(chat_id) == Some(uid))
        .filter_map(|(chat_id, _, receipt)| receipt.map(|receipt| (chat_id, receipt)))
        .collect())
}

/// Peer receipts for a page of DM thread scopes, keyed by thread root id.
pub fn visible_thread_receipts(
    conn: &mut PgConnection,
    viewer_uid: i32,
    scopes: &[(i64, i64)],
) -> Result<HashMap<i64, i64>, diesel::result::Error> {
    let chat_ids: Vec<i64> = scopes
        .iter()
        .map(|(chat_id, _)| *chat_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let peers = visible_dm_peers(conn, viewer_uid, &chat_ids)?;
    if peers.is_empty() {
        return Ok(HashMap::new());
    }
    let chat_ids: Vec<i64> = peers.keys().copied().collect();
    let root_ids: Vec<i64> = scopes.iter().map(|(_, root_id)| *root_id).collect();
    let peer_uids: Vec<i32> = peers
        .values()
        .copied()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let rows = thread_user_states::table
        .filter(thread_user_states::chat_id.eq_any(&chat_ids))
        .filter(thread_user_states::thread_root_id.eq_any(&root_ids))
        .filter(thread_user_states::uid.eq_any(&peer_uids))
        .select((
            thread_user_states::chat_id,
            thread_user_states::thread_root_id,
            thread_user_states::uid,
            thread_user_states::last_read_receipt_message_id,
        ))
        .load::<(i64, i64, i32, Option<i64>)>(conn)?;
    Ok(rows
        .into_iter()
        .filter(|(chat_id, _, uid, _)| peers.get(chat_id) == Some(uid))
        .filter_map(|(_, root_id, _, receipt)| receipt.map(|receipt| (root_id, receipt)))
        .collect())
}

/// Find the persisted DM for a participant pair, including former friendships.
pub fn dm_chat_id_for_pair(
    conn: &mut PgConnection,
    uid: i32,
    peer_uid: i32,
) -> Result<Option<i64>, diesel::result::Error> {
    let (uid1, uid2) = canonical_pair(uid, peer_uid);
    groups::table
        .filter(
            groups::kind
                .eq(GroupKind::Dm)
                .and(groups::dm_uid1.eq(uid1))
                .and(groups::dm_uid2.eq(uid2)),
        )
        .select(groups::id)
        .first(conn)
        .optional()
}

/// Broadcast an invalidation to both devices sets when a DM receipt changes.
pub fn broadcast_read_receipt_changed_if_dm(
    conn: &mut PgConnection,
    registry: &Arc<ConnectionRegistry>,
    chat_id: i64,
    privacy_changed: bool,
    reader_uid: Option<i32>,
    thread_root_id: Option<i64>,
) -> Result<(), diesel::result::Error> {
    let Some(participants) = dm_participants(conn, chat_id)? else {
        return Ok(());
    };
    let message = Arc::new(ServerWsMessage::ReadReceiptChanged(
        ReadReceiptChangedPayload {
            reader_uid,
            thread_root_id,
            chat_id,
            privacy_changed: privacy_changed.then_some(true),
        },
    ));
    registry.broadcast_to_uids(&[participants.first, participants.second], message);
    Ok(())
}

/// Invalidate every current-friend DM affected by one user's global policy.
pub fn broadcast_global_privacy_changed(
    conn: &mut PgConnection,
    registry: &Arc<ConnectionRegistry>,
    uid: i32,
) -> Result<(), diesel::result::Error> {
    let greater: Vec<i32> = friendships::table
        .filter(friendships::uid1.eq(uid))
        .select(friendships::uid2)
        .load(conn)?;
    let lesser: Vec<i32> = friendships::table
        .filter(friendships::uid2.eq(uid))
        .select(friendships::uid1)
        .load(conn)?;
    let mut dm_chats: Vec<(i64, i32)> = Vec::new();
    if !greater.is_empty() {
        dm_chats.extend(
            groups::table
                .filter(
                    groups::kind
                        .eq(GroupKind::Dm)
                        .and(groups::dm_uid1.eq(uid))
                        .and(groups::dm_uid2.eq_any(&greater)),
                )
                .select((groups::id, groups::dm_uid2.assume_not_null()))
                .load::<(i64, i32)>(conn)?,
        );
    }
    if !lesser.is_empty() {
        dm_chats.extend(
            groups::table
                .filter(
                    groups::kind
                        .eq(GroupKind::Dm)
                        .and(groups::dm_uid2.eq(uid))
                        .and(groups::dm_uid1.eq_any(&lesser)),
                )
                .select((groups::id, groups::dm_uid1.assume_not_null()))
                .load::<(i64, i32)>(conn)?,
        );
    }
    for (chat_id, peer_uid) in dm_chats {
        let message = Arc::new(ServerWsMessage::ReadReceiptChanged(
            ReadReceiptChangedPayload {
                reader_uid: None,
                thread_root_id: None,
                chat_id,
                privacy_changed: Some(true),
            },
        ));
        registry.broadcast_to_uids(&[uid, peer_uid], message);
    }
    Ok(())
}

/// Invalidate a pair's DM receipt display after privacy or relationship changes.
pub fn broadcast_pair_privacy_changed(
    conn: &mut PgConnection,
    registry: &Arc<ConnectionRegistry>,
    uid: i32,
    peer_uid: i32,
) -> Result<(), diesel::result::Error> {
    if let Some(chat_id) = dm_chat_id_for_pair(conn, uid, peer_uid)? {
        broadcast_read_receipt_changed_if_dm(conn, registry, chat_id, true, None, None)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::read_receipt_is_visible;
    use crate::models::ReadReceiptVisibility;

    #[test]
    fn receipts_require_reciprocal_friend_visibility_without_blocks() {
        assert!(read_receipt_is_visible(
            true,
            false,
            ReadReceiptVisibility::Friends,
            None,
            ReadReceiptVisibility::Friends,
            None,
        ));
        assert!(!read_receipt_is_visible(
            false,
            false,
            ReadReceiptVisibility::Friends,
            None,
            ReadReceiptVisibility::Friends,
            None,
        ));
        assert!(!read_receipt_is_visible(
            true,
            true,
            ReadReceiptVisibility::Friends,
            None,
            ReadReceiptVisibility::Friends,
            None,
        ));
        assert!(!read_receipt_is_visible(
            true,
            false,
            ReadReceiptVisibility::Nobody,
            None,
            ReadReceiptVisibility::Friends,
            None,
        ));
        assert!(read_receipt_is_visible(
            true,
            false,
            ReadReceiptVisibility::Nobody,
            Some(true),
            ReadReceiptVisibility::Nobody,
            Some(true),
        ));
    }
}
