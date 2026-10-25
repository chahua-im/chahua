//! Group-local speaking restrictions. Notification mutes and global policies are unrelated.
use diesel::prelude::*;

use crate::dto::speaking::{GroupSpeakingModeResponse, MemberSpeakingModeResponse};
use crate::dto::ws::ServerWsMessage;
use crate::errors::AppError;
use crate::models::{GroupKind, GroupMembership, GroupRole, Message, SpeakingMode};
use crate::schema::{group_membership as gm, groups};
use crate::services::ws_registry::ConnectionRegistry;

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Copy)]
pub enum SpeakingAction {
    ChatMessage,
    CreateThread,
    ThreadReply,
}

pub fn effective_mode(
    role: &GroupRole,
    group_mode: SpeakingMode,
    member_mode: SpeakingMode,
) -> SpeakingMode {
    if *role == GroupRole::Admin {
        SpeakingMode::Unrestricted
    } else {
        group_mode.max(member_mode)
    }
}

pub fn allows(mode: SpeakingMode, action: SpeakingAction) -> bool {
    match mode {
        SpeakingMode::Unrestricted => true,
        SpeakingMode::ThreadsOnly => !matches!(action, SpeakingAction::ChatMessage),
        SpeakingMode::RepliesOnly => matches!(action, SpeakingAction::ThreadReply),
        SpeakingMode::ReadOnly => false,
    }
}

/// Acquire before reading authorization state or locking message/member rows,
/// inside the transaction that performs the write. Concurrent sends take shared
/// locks; moderation and membership changes take exclusive locks until commit.
///
/// Raw SQL is necessary because Diesel's row-lock DSL cannot express advisory
/// locks. A separate lock avoids lock upgrades on groups.last_message_id and
/// serializing all sends. The two-int namespace is disjoint from forwarding's
/// bigint advisory locks. Hash collisions only serialize unrelated chats.
pub fn lock_chat(conn: &mut PgConnection, chat_id: i64, exclusive: bool) -> QueryResult<()> {
    const SPEAKING_LOCK_NAMESPACE: i32 = 0x53504b;
    let key = (chat_id ^ (chat_id >> 32)) as i32;
    let sql = if exclusive {
        "SELECT pg_advisory_xact_lock($1, $2)"
    } else {
        "SELECT pg_advisory_xact_lock_shared($1, $2)"
    };
    diesel::sql_query(sql)
        .bind::<diesel::sql_types::Integer, _>(SPEAKING_LOCK_NAMESPACE)
        .bind::<diesel::sql_types::Integer, _>(key)
        .execute(conn)?;
    Ok(())
}

/// Check an edit against the persisted message's location, never request fields.
/// Caller holds the chat's shared lock and verifies ownership/editability.
pub fn require_edit(conn: &mut PgConnection, message: &Message, uid: i32) -> Result<(), AppError> {
    let chat_id = message.chat_id;
    // A root stays in the main chat even when it has an attached thread.
    let action = if message.reply_root_id.is_some() {
        SpeakingAction::ThreadReply
    } else {
        SpeakingAction::ChatMessage
    };
    let (kind, group_mode, role, member_mode) = groups::table
        .inner_join(gm::table)
        .filter(groups::id.eq(chat_id).and(gm::uid.eq(uid)))
        .select((
            groups::kind,
            groups::speaking_mode,
            gm::role,
            gm::speaking_mode,
        ))
        .first::<(GroupKind, SpeakingMode, GroupRole, SpeakingMode)>(conn)
        .optional()?
        .ok_or(AppError::Forbidden("Not a member of this chat"))?;
    let mode = effective_mode(&role, group_mode, member_mode);
    if kind == GroupKind::Group && !allows(mode, action) {
        return Err(AppError::SpeakingRestricted(mode));
    }
    Ok(())
}

fn require_group_admin(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
) -> Result<SpeakingMode, AppError> {
    let (kind, mode, role) = groups::table
        .inner_join(gm::table)
        .filter(groups::id.eq(chat_id).and(gm::uid.eq(uid)))
        .select((groups::kind, groups::speaking_mode, gm::role))
        .first::<(GroupKind, SpeakingMode, GroupRole)>(conn)
        .optional()?
        .ok_or(AppError::Forbidden("Not a member of this chat"))?;
    if kind == GroupKind::Dm {
        return Err(AppError::BadRequest(
            "Speaking restrictions are not supported in DM chats",
        ));
    }
    if role != GroupRole::Admin {
        return Err(AppError::Forbidden("Admin role required"));
    }
    Ok(mode)
}

pub fn update_group_mode(
    conn: &mut PgConnection,
    chat_id: i64,
    requester_uid: i32,
    mode: SpeakingMode,
) -> Result<GroupSpeakingModeResponse, AppError> {
    conn.transaction(|conn| {
        lock_chat(conn, chat_id, true)?;
        require_group_admin(conn, chat_id, requester_uid)?;
        diesel::update(groups::table.find(chat_id))
            .set(groups::speaking_mode.eq(mode))
            .execute(conn)?;
        Ok(GroupSpeakingModeResponse {
            chat_id,
            speaking_mode: mode,
        })
    })
}

pub fn update_member_mode(
    conn: &mut PgConnection,
    chat_id: i64,
    requester_uid: i32,
    target_uid: i32,
    mode: SpeakingMode,
) -> Result<MemberSpeakingModeResponse, AppError> {
    conn.transaction(|conn| {
        lock_chat(conn, chat_id, true)?;
        let group_mode = require_group_admin(conn, chat_id, requester_uid)?;
        let role = gm::table
            .find((chat_id, target_uid))
            .select(gm::role)
            .first::<GroupRole>(conn)
            .optional()?
            .ok_or(AppError::NotFound("Member not found"))?;
        if role == GroupRole::Admin {
            return Err(AppError::BadRequest(
                "Administrators cannot have personal speaking restrictions",
            ));
        }
        diesel::update(gm::table.find((chat_id, target_uid)))
            .set(gm::speaking_mode.eq(mode))
            .execute(conn)?;
        Ok(member_state(chat_id, target_uid, role, group_mode, mode))
    })
}

/// Role changes and restriction changes share the same lock and transaction.
/// Promotion clears the personal limit, so a later demotion cannot revive it.
pub fn update_member_role(
    conn: &mut PgConnection,
    chat_id: i64,
    requester_uid: i32,
    target_uid: i32,
    role: GroupRole,
) -> Result<GroupMembership, AppError> {
    conn.transaction(|conn| {
        lock_chat(conn, chat_id, true)?;
        require_group_admin(conn, chat_id, requester_uid)?;
        if requester_uid == target_uid {
            return Err(AppError::BadRequest("Cannot change your own role"));
        }
        let member = gm::table
            .find((chat_id, target_uid))
            .select(GroupMembership::as_select())
            .first::<GroupMembership>(conn)
            .optional()?
            .ok_or(AppError::NotFound("Member not found"))?;
        let mode = if role == GroupRole::Admin {
            SpeakingMode::Unrestricted
        } else {
            member.speaking_mode
        };
        let updated = diesel::update(gm::table.find((chat_id, target_uid)))
            .set((gm::role.eq(&role), gm::speaking_mode.eq(mode)))
            .returning(GroupMembership::as_returning())
            .get_result(conn)?;
        Ok(updated)
    })
}

fn member_state(
    chat_id: i64,
    uid: i32,
    role: GroupRole,
    group_speaking_mode: SpeakingMode,
    speaking_mode: SpeakingMode,
) -> MemberSpeakingModeResponse {
    MemberSpeakingModeResponse {
        chat_id,
        uid,
        effective_speaking_mode: effective_mode(&role, group_speaking_mode, speaking_mode),
        role,
        speaking_mode,
        group_speaking_mode,
    }
}

/// Re-read after acquiring the shared lock and hold it until enqueue completes.
/// An earlier update may broadcast late, but cannot publish an older snapshot.
pub fn broadcast_group_mode(
    conn: &mut PgConnection,
    registry: &ConnectionRegistry,
    chat_id: i64,
) -> Result<(), AppError> {
    conn.transaction(|conn| {
        lock_chat(conn, chat_id, false)?;
        let speaking_mode = groups::table
            .find(chat_id)
            .select(groups::speaking_mode)
            .first(conn)?;
        let uids = gm::table
            .filter(gm::chat_id.eq(chat_id))
            .select(gm::uid)
            .load::<i32>(conn)?;
        registry.broadcast_to_uids(
            &uids,
            std::sync::Arc::new(ServerWsMessage::GroupSpeakingModeChanged(
                GroupSpeakingModeResponse {
                    chat_id,
                    speaking_mode,
                },
            )),
        );
        Ok(())
    })
}

pub fn broadcast_member_mode(
    conn: &mut PgConnection,
    registry: &ConnectionRegistry,
    chat_id: i64,
    uid: i32,
) -> Result<(), AppError> {
    conn.transaction(|conn| {
        lock_chat(conn, chat_id, false)?;
        let member = groups::table
            .inner_join(gm::table)
            .filter(groups::id.eq(chat_id).and(gm::uid.eq(uid)))
            .select((gm::role, groups::speaking_mode, gm::speaking_mode))
            .first::<(GroupRole, SpeakingMode, SpeakingMode)>(conn)
            .optional()?;
        // Removal may have committed between the update and this broadcast.
        let Some((role, group_mode, mode)) = member else {
            return Ok(());
        };
        let uids = gm::table
            .filter(gm::chat_id.eq(chat_id))
            .filter(gm::role.eq(GroupRole::Admin).or(gm::uid.eq(uid)))
            .select(gm::uid)
            .load::<i32>(conn)?;
        registry.broadcast_to_uids(
            &uids,
            std::sync::Arc::new(ServerWsMessage::MemberSpeakingModeChanged(member_state(
                chat_id, uid, role, group_mode, mode,
            ))),
        );
        Ok(())
    })
}
