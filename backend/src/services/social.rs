//! Social-graph DB logic: friendships, friend requests, and blocks.
//!
//! Chahua is the authoritative source for friend relationships and blocks.
//! All functions take a `&mut PgConnection` (borrowed from `DbConn`); the few
//! that need snowflake IDs are `async` and take `&AppState` for the generator.

use chrono::Utc;
use diesel::prelude::*;

use crate::errors::AppError;
use crate::models::{
    FriendAddVerificationMode, FriendRequest, FriendRequestStatus, GroupJoinReason, GroupKind,
    GroupRole, GroupVisibility, NewBlock, NewFriendRequest, NewFriendship, NewGroup,
    NewGroupMembership, NewUserExtra,
};
use crate::schema::{blocks, friend_requests, friendships, group_membership, groups, user_extra};
use crate::utils::ids;
use crate::AppState;

/// Return the pair as `(min, max)` so each relationship is stored once.
fn canonical_pair(a: i32, b: i32) -> (i32, i32) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
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

/// A pending friend request between the pair, in either direction.
pub fn find_pending_request_between(
    conn: &mut PgConnection,
    a: i32,
    b: i32,
) -> QueryResult<Option<FriendRequest>> {
    let (u1, u2) = canonical_pair(a, b);
    friend_requests::table
        .filter(
            friend_requests::status
                .eq(FriendRequestStatus::Pending)
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

/// Authorization gate for DM: sender and peer must be mutual friends and not
/// blocked in either direction.
pub fn check_can_dm(conn: &mut PgConnection, sender: i32, peer: i32) -> Result<(), AppError> {
    if sender == peer {
        return Err(AppError::BadRequest("Cannot send a message to yourself"));
    }
    if !are_mutual_friends(conn, sender, peer)? {
        return Err(AppError::Forbidden(
            "You can only direct-message mutual friends",
        ));
    }
    if is_blocked_either_direction(conn, sender, peer)? {
        return Err(AppError::Forbidden("Cannot direct-message this user"));
    }
    Ok(())
}

/// Authorization gate for posting into a chat. For DM chats, require that the
/// sender and peer are still mutual friends and not blocked (friendship/block
/// state can change after the DM was created). Regular groups are gated by
/// membership elsewhere; this is a no-op for them.
pub fn assert_can_send_to_chat(
    conn: &mut PgConnection,
    chat_id: i64,
    sender_uid: i32,
) -> Result<(), AppError> {
    let (kind, dm_uid1, dm_uid2) = groups::table
        .filter(groups::id.eq(chat_id))
        .select((groups::kind, groups::dm_uid1, groups::dm_uid2))
        .first::<(GroupKind, Option<i32>, Option<i32>)>(conn)
        .optional()?
        .ok_or(AppError::NotFound("Chat not found"))?;

    if kind == GroupKind::Dm {
        // The sender is one of the canonical pair; the other is the peer.
        let peer = dm_uid1
            .filter(|&u| u != sender_uid)
            .or(dm_uid2)
            .ok_or(AppError::Internal("DM peer missing"))?;
        check_can_dm(conn, sender_uid, peer)?;
    }
    Ok(())
}

/// Find the existing 1:1 DM group for `(user_a, user_b)`, or create one.
/// `user_a` is the initiating user. Returns the group id.
pub async fn find_or_create_dm(
    conn: &mut PgConnection,
    state: &AppState,
    user_a: i32,
    user_b: i32,
) -> Result<i64, AppError> {
    if user_a == user_b {
        return Err(AppError::BadRequest("Cannot start a DM with yourself"));
    }
    let (u1, u2) = canonical_pair(user_a, user_b);

    let pair_filter = groups::kind
        .eq(GroupKind::Dm)
        .and(groups::dm_uid1.eq(u1))
        .and(groups::dm_uid2.eq(u2));

    // Fast path: existing DM for this pair.
    if let Some(id) = groups::table
        .filter(pair_filter.clone())
        .select(groups::id)
        .first::<i64>(conn)
        .optional()?
    {
        return Ok(id);
    }

    // Creating a new DM requires mutual friendship and no block in either
    // direction. (An existing DM is returned above regardless of current
    // friendship state, so history stays accessible; sending is gated
    // separately by `assert_can_send_to_chat`.)
    check_can_dm(conn, user_a, user_b)?;

    let id = ids::next_gid(state.id_gen.as_ref()).await.map_err(|err| {
        tracing::error!("failed to generate dm group id: {:?}", err);
        AppError::Internal("Failed to generate id")
    })?;
    let now = Utc::now();

    conn.transaction::<i64, AppError, _>(|conn| {
        let inserted = diesel::insert_into(groups::table)
            .values(&NewGroup {
                id,
                name: String::new(),
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
            // A concurrent request created this DM; reuse it.
            return groups::table
                .filter(pair_filter.clone())
                .select(groups::id)
                .first::<i64>(conn)
                .map_err(|_| AppError::Internal("Concurrent DM disappeared"));
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
        Ok(id)
    })
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

/// Cancel any pending friend requests between the pair (both directions).
fn cancel_pending_requests_between(
    conn: &mut PgConnection,
    a: i32,
    b: i32,
    now: chrono::DateTime<Utc>,
) -> QueryResult<usize> {
    let (u1, u2) = canonical_pair(a, b);
    diesel::update(
        friend_requests::table.filter(
            friend_requests::status
                .eq(FriendRequestStatus::Pending)
                .and(
                    friend_requests::from_uid
                        .eq(u1)
                        .and(friend_requests::to_uid.eq(u2))
                        .or(friend_requests::from_uid
                            .eq(u2)
                            .and(friend_requests::to_uid.eq(u1))),
                ),
        ),
    )
    .set((
        friend_requests::status.eq(FriendRequestStatus::Cancelled),
        friend_requests::decided_at.eq(now),
    ))
    .execute(conn)
}

pub enum CreateRequestOutcome {
    /// A new pending request was created (notify `to_uid`).
    Created { request: FriendRequest },
    /// A reciprocal pending request was auto-accepted (notify the original requester).
    AutoAccepted { request: FriendRequest },
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
        last_seen_at: now,
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
    if let Some(existing) = find_pending_request_between(conn, from, to)? {
        if existing.from_uid == from {
            return Ok(CreateRequestOutcome::AlreadyPending);
        }
        // Reciprocal pending request (to -> from): auto-accept it.
        let request = conn.transaction::<FriendRequest, AppError, _>(|conn| {
            let updated =
                diesel::update(friend_requests::table.filter(friend_requests::id.eq(existing.id)))
                    .set((
                        friend_requests::status.eq(FriendRequestStatus::Accepted),
                        friend_requests::decided_at.eq(now),
                    ))
                    .returning(FriendRequest::as_returning())
                    .get_result(conn)?;
            insert_friendship(conn, from, to, from, now)?;
            Ok(updated)
        })?;
        return Ok(CreateRequestOutcome::AutoAccepted { request });
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

/// Accept or reject a friend request. Only the recipient (`to_uid`) may resolve.
pub fn resolve_friend_request(
    conn: &mut PgConnection,
    resolver_uid: i32,
    request_id: i64,
    accept: bool,
) -> Result<FriendRequest, AppError> {
    let now = Utc::now();
    conn.transaction::<FriendRequest, AppError, _>(|conn| {
        let request = friend_requests::table
            .filter(friend_requests::id.eq(request_id))
            .select(FriendRequest::as_select())
            .first::<FriendRequest>(conn)
            .optional()?
            .ok_or(AppError::NotFound("Friend request not found"))?;

        if request.to_uid != resolver_uid {
            return Err(AppError::Forbidden(
                "Only the recipient can respond to this friend request",
            ));
        }
        if request.status != FriendRequestStatus::Pending {
            return Err(AppError::Conflict("Friend request is no longer pending"));
        }

        let new_status = if accept {
            FriendRequestStatus::Accepted
        } else {
            FriendRequestStatus::Rejected
        };
        let updated =
            diesel::update(friend_requests::table.filter(friend_requests::id.eq(request_id)))
                .set((
                    friend_requests::status.eq(new_status),
                    friend_requests::decided_at.eq(now),
                ))
                .returning(FriendRequest::as_returning())
                .get_result(conn)?;

        if accept {
            insert_friendship(
                conn,
                request.from_uid,
                request.to_uid,
                request.from_uid,
                now,
            )?;
        }
        Ok(updated)
    })
}

/// Cancel a pending friend request. Only the sender (`from_uid`) may cancel.
pub fn cancel_friend_request(
    conn: &mut PgConnection,
    sender_uid: i32,
    request_id: i64,
) -> Result<FriendRequest, AppError> {
    let now = Utc::now();
    conn.transaction::<FriendRequest, AppError, _>(|conn| {
        let request = friend_requests::table
            .filter(friend_requests::id.eq(request_id))
            .select(FriendRequest::as_select())
            .first::<FriendRequest>(conn)
            .optional()?
            .ok_or(AppError::NotFound("Friend request not found"))?;

        if request.from_uid != sender_uid {
            return Err(AppError::Forbidden(
                "Only the sender can cancel this friend request",
            ));
        }
        if request.status != FriendRequestStatus::Pending {
            return Err(AppError::Conflict("Friend request is no longer pending"));
        }

        let updated =
            diesel::update(friend_requests::table.filter(friend_requests::id.eq(request_id)))
                .set((
                    friend_requests::status.eq(FriendRequestStatus::Cancelled),
                    friend_requests::decided_at.eq(now),
                ))
                .returning(FriendRequest::as_returning())
                .get_result(conn)?;
        Ok(updated)
    })
}

/// List pending friend requests directed at `uid`.
pub fn list_incoming_requests(
    conn: &mut PgConnection,
    uid: i32,
) -> QueryResult<Vec<FriendRequest>> {
    friend_requests::table
        .filter(
            friend_requests::to_uid
                .eq(uid)
                .and(friend_requests::status.eq(FriendRequestStatus::Pending)),
        )
        .order(friend_requests::created_at.desc())
        .select(FriendRequest::as_select())
        .load::<FriendRequest>(conn)
}

/// List pending friend requests sent by `uid`.
pub fn list_outgoing_requests(
    conn: &mut PgConnection,
    uid: i32,
) -> QueryResult<Vec<FriendRequest>> {
    friend_requests::table
        .filter(
            friend_requests::from_uid
                .eq(uid)
                .and(friend_requests::status.eq(FriendRequestStatus::Pending)),
        )
        .order(friend_requests::created_at.desc())
        .select(FriendRequest::as_select())
        .load::<FriendRequest>(conn)
}

/// Block a user. Idempotent. Side effects: removes any friendship and cancels
/// any pending friend requests between the pair (both directions). Silent to
/// the blocked user (no WS event); their client refreshes on next fetch.
pub fn block_user(conn: &mut PgConnection, blocker: i32, blocked: i32) -> Result<(), AppError> {
    if blocker == blocked {
        return Err(AppError::BadRequest("Cannot block yourself"));
    }
    let now = Utc::now();
    conn.transaction::<(), AppError, _>(|conn| {
        diesel::insert_into(blocks::table)
            .values(&NewBlock {
                blocker_uid: blocker,
                blocked_uid: blocked,
                created_at: now,
            })
            .on_conflict((blocks::blocker_uid, blocks::blocked_uid))
            .do_nothing()
            .execute(conn)?;
        remove_friendship(conn, blocker, blocked)?;
        cancel_pending_requests_between(conn, blocker, blocked, now)?;
        Ok(())
    })?;
    Ok(())
}

/// Unblock a user. Returns `true` if a block was removed.
pub fn unblock_user(conn: &mut PgConnection, blocker: i32, blocked: i32) -> Result<bool, AppError> {
    let affected = diesel::delete(
        blocks::table.filter(
            blocks::blocker_uid
                .eq(blocker)
                .and(blocks::blocked_uid.eq(blocked)),
        ),
    )
    .execute(conn)?;
    Ok(affected > 0)
}

#[cfg(test)]
mod tests {
    use super::canonical_pair;

    #[test]
    fn canonical_pair_orders_low_high() {
        assert_eq!(canonical_pair(5, 3), (3, 5));
        assert_eq!(canonical_pair(3, 5), (3, 5));
        assert_eq!(canonical_pair(-1, 9), (-1, 9));
    }
}
