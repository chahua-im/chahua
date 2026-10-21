//! Direct-message read receipt storage, visibility, and realtime invalidation.
//!
//! Receipt markers are deliberately separate from unread cursors: clients may
//! rewind unread state and deleted messages may move an unread cursor, but a
//! read receipt is a monotonic high-water mark.

use diesel::prelude::*;
use diesel::PgConnection;
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
) -> Result<(), diesel::result::Error> {
    let Some(participants) = dm_participants(conn, chat_id)? else {
        return Ok(());
    };
    let message = Arc::new(ServerWsMessage::ReadReceiptChanged(
        ReadReceiptChangedPayload {
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
        broadcast_read_receipt_changed_if_dm(conn, registry, chat_id, true)?;
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
