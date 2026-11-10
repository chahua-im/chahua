use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::PgConnection;
use serde_json::json;

use crate::dto::members::{
    AddMemberBody, ListMembersQuery, ListMembersResponse, MemberResponse, RemoveMemberQuery,
    UpdateMemberBody,
};
use crate::dto::speaking::{MemberSpeakingModeResponse, UpdateSpeakingModeRequest};
use crate::errors::AppError;
use crate::metrics::Metrics;
use crate::models::{
    GroupJoinReason, GroupKind, GroupMembership, GroupRole, NewGroupMembership, SpeakingMode,
    SystemMessageKind,
};
use crate::schema::{self, group_membership, groups};
use crate::services::avatars::AvatarService;
use crate::services::background::{BackgroundJob, BackgroundService, DeleteScope};
use crate::services::media::MediaStore;
use crate::services::messages::{PreparedMessageSend, SendMessageOutcome, SendPreparedMessageDeps};
use crate::services::push::PushService;
use crate::services::user::{
    lookup_user_profiles, parse_user_search_query, search_group_member_uids, UserSearchMode,
};
use crate::services::ws_registry::ConnectionRegistry;
use crate::utils::ids::IdGen;
use crate::utils::pagination::validate_limit;
use crate::MAX_MEMBERS_LIMIT;

use super::groups::load_requester_group_role;

pub struct PostAddMemberDeps<'a> {
    pub id_gen: &'a Arc<IdGen>,
    pub media: &'a MediaStore,
    pub avatars: &'a Arc<AvatarService>,
    pub metrics: &'a Arc<Metrics>,
    pub ws_registry: &'a Arc<ConnectionRegistry>,
    pub push_service: &'a Arc<PushService>,
}

pub struct DeleteRemoveMemberDeps<'a> {
    pub id_gen: &'a Arc<IdGen>,
    pub media: &'a MediaStore,
    pub avatars: &'a Arc<AvatarService>,
    pub metrics: &'a Arc<Metrics>,
    pub ws_registry: &'a Arc<ConnectionRegistry>,
    pub push_service: &'a Arc<PushService>,
    pub background_service: &'a Arc<BackgroundService>,
}

/// Check if user is a member of the chat; return 403 if not.
pub(crate) fn check_membership(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
) -> Result<(), AppError> {
    use crate::schema::group_membership::dsl;

    let exists = group_membership::table
        .filter(dsl::chat_id.eq(chat_id).and(dsl::uid.eq(uid)))
        .count()
        .get_result::<i64>(conn)?;

    if exists == 0 {
        return Err(AppError::Forbidden("Not a member of this chat"));
    }

    Ok(())
}

/// Check if user is an admin of the chat; return 403 if not a member or not admin.
pub(crate) fn require_admin_role(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
) -> Result<(), AppError> {
    use crate::schema::group_membership::dsl;

    let role: Option<GroupRole> = group_membership::table
        .filter(dsl::chat_id.eq(chat_id).and(dsl::uid.eq(uid)))
        .select(dsl::role)
        .first(conn)
        .optional()?;

    match role {
        Some(GroupRole::Admin) => Ok(()),
        Some(_) => Err(AppError::Forbidden("Admin role required")),
        None => Err(AppError::Forbidden("Not a member of this chat")),
    }
}

pub fn get_members(
    uid: i32,
    chat_id: i64,
    query: ListMembersQuery,
    conn: &mut PgConnection,
    avatars: &AvatarService,
) -> Result<ListMembersResponse, AppError> {
    check_membership(conn, chat_id, uid)?;

    use crate::schema::group_membership::dsl as gm_dsl;

    let requester_is_admin = matches!(
        load_requester_group_role(conn, chat_id, uid)?,
        Some(GroupRole::Admin)
    );

    let limit = validate_limit(query.limit, MAX_MEMBERS_LIMIT);
    let search_mode = query.mode.unwrap_or(UserSearchMode::Autocomplete);
    let search = parse_user_search_query(query.q.as_deref(), search_mode);
    let member_uids =
        search_group_member_uids(conn, chat_id, query.after, limit + 1, search.as_ref())?;

    let has_more = member_uids.len() as i64 > limit;
    let page_uids: Vec<i32> = member_uids.into_iter().take(limit as usize).collect();
    let rows: Vec<GroupMembership> = group_membership::table
        .filter(
            gm_dsl::chat_id
                .eq(chat_id)
                .and(gm_dsl::uid.eq_any(&page_uids)),
        )
        .select(GroupMembership::as_select())
        .load(conn)?;

    let rows_by_uid: HashMap<i32, GroupMembership> =
        rows.into_iter().map(|row| (row.uid, row)).collect();
    let page_rows: Vec<(i32, GroupRole, DateTime<Utc>, SpeakingMode)> = page_uids
        .into_iter()
        .filter_map(|member_uid| {
            rows_by_uid
                .get(&member_uid)
                .map(|row| (row.uid, row.role.clone(), row.joined_at, row.speaking_mode))
        })
        .collect();
    let members = build_member_responses(conn, avatars, page_rows)?;
    let next_cursor = has_more
        .then(|| members.last().map(|member| member.uid))
        .flatten();

    Ok(ListMembersResponse {
        members,
        next_cursor,
        can_manage_members: requester_is_admin,
    })
}

pub async fn post_add_member(
    uid: i32,
    chat_id: i64,
    body: AddMemberBody,
    conn: &mut PgConnection,
    deps: PostAddMemberDeps<'_>,
) -> Result<MemberResponse, AppError> {
    require_admin_role(conn, chat_id, uid)?;

    let kind: GroupKind = groups::table
        .find(chat_id)
        .select(groups::kind)
        .first(conn)?;
    if kind == GroupKind::Dm {
        return Err(AppError::BadRequest(
            "DM chats cannot have additional members",
        ));
    }

    let profiles = lookup_user_profiles(conn, &[body.uid])?;
    let profile = profiles.get(&body.uid);
    if profile.is_none() {
        return Err(AppError::BadRequest("User not found"));
    }

    use crate::schema::group_membership::dsl as gm_dsl;
    let already_member = schema::group_membership::table
        .filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(body.uid)))
        .count()
        .get_result::<i64>(conn)?;
    if already_member > 0 {
        return Err(AppError::Conflict("User is already a member"));
    }

    let role = body.role.unwrap_or(GroupRole::Member);
    let last_message_id: Option<i64> = groups::table
        .filter(groups::id.eq(chat_id))
        .select(groups::last_message_id)
        .first(conn)
        .optional()?
        .flatten();
    let now = Utc::now();
    diesel::insert_into(group_membership::table)
        .values(&NewGroupMembership {
            chat_id,
            uid: body.uid,
            role: role.clone(),
            joined_at: now,
            join_reason: GroupJoinReason::DirectInvite,
            join_reason_extra: Some(json!({ "inviter_uid": uid })),
            last_read_message_id: last_message_id,
        })
        .execute(conn)?;

    let target_username = profile
        .and_then(|profile| profile.username.clone())
        .unwrap_or_else(|| "Someone".to_string());
    if let Ok(SendMessageOutcome::Created(send_result)) =
        crate::services::messages::send_prepared_message(
            conn,
            SendPreparedMessageDeps {
                id_gen: deps.id_gen,
                media: deps.media,
                avatars: deps.avatars,
                metrics: deps.metrics,
            },
            PreparedMessageSend {
                system_kind: Some(SystemMessageKind::MemberAdded),
                forwarded_from_message_id: None,
                metadata: None,
                chat_id,
                chat_kind: kind,
                sender_uid: uid,
                message: Some(crate::services::system_messages::with_user(
                    format!("added {}", target_username),
                    body.uid,
                )),
                message_type: crate::models::MessageType::System,
                sticker_id: None,
                reply_to_id: None,
                reply_root_id: None,
                client_generated_id: uuid::Uuid::new_v4().to_string(),
                attachment_ids: vec![],
                publish_immediately: true,
                forwarded_bundle_id: None,
                forwarded_preview_total: None,
                forwarded_preview_contains_forwarded_messages: None,
                forwarded_preview_items: None,
            },
        )
        .await
    {
        let send_result = *send_result;
        send_result
            .side_effects
            .fire(deps.ws_registry, deps.push_service);
    }

    crate::services::chat::publish_membership_changed(deps.ws_registry, body.uid, chat_id);
    let avatar_url = deps.avatars.lookup(&[body.uid]).remove(&body.uid).flatten();
    Ok(MemberResponse {
        uid: body.uid,
        role,
        speaking_mode: SpeakingMode::Unrestricted,
        joined_at: now,
        username: profile.and_then(|profile| profile.username.clone()),
        avatar_url,
        gender: profile.map(|profile| profile.gender).unwrap_or(0),
        user_group: profile.and_then(|profile| profile.user_group.clone()),
    })
}

pub async fn delete_remove_member(
    uid: i32,
    chat_id: i64,
    target_uid: i32,
    query: RemoveMemberQuery,
    conn: &mut PgConnection,
    deps: DeleteRemoveMemberDeps<'_>,
) -> Result<(), AppError> {
    let is_admin_removing_other = uid != target_uid;
    let (target_username, kind) = conn.transaction::<_, AppError, _>(|conn| {
        crate::services::speaking::lock_chat(conn, chat_id, true)?;
        if is_admin_removing_other {
            require_admin_role(conn, chat_id, uid)?;
        } else {
            check_membership(conn, chat_id, uid)?;
        }

        let kind: GroupKind = groups::table
            .find(chat_id)
            .select(groups::kind)
            .first(conn)?;
        if kind == GroupKind::Dm {
            return Err(AppError::BadRequest("DM chats cannot be left"));
        }

        use crate::schema::group_membership::dsl as gm_dsl;
        let target_role: Option<GroupRole> = group_membership::table
            .filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(target_uid)))
            .select(gm_dsl::role)
            .first(conn)
            .optional()?;
        let Some(target_role) = target_role else {
            return Err(AppError::NotFound("Member not found"));
        };

        let target_username = lookup_user_profiles(conn, &[target_uid])
            .ok()
            .and_then(|mut profiles| profiles.remove(&target_uid))
            .and_then(|profile| profile.username)
            .unwrap_or_else(|| "Someone".to_string());

        if matches!(target_role, GroupRole::Admin) {
            let admin_count = group_membership::table
                .filter(
                    gm_dsl::chat_id
                        .eq(chat_id)
                        .and(gm_dsl::role.eq(GroupRole::Admin)),
                )
                .count()
                .get_result::<i64>(conn)?;
            if admin_count <= 1 {
                return Err(AppError::BadRequest(
                    "Cannot remove the last admin from the group",
                ));
            }
        }

        diesel::delete(
            group_membership::table
                .filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(target_uid))),
        )
        .execute(conn)?;
        crate::services::threads::unsubscribe_user_from_chat(conn, chat_id, target_uid)?;
        Ok((target_username, kind))
    })?;

    deps.ws_registry.invalidate_unread(&[target_uid]);
    let (system_kind, sender_uid, message) = if is_admin_removing_other {
        (
            SystemMessageKind::MemberRemoved,
            uid,
            crate::services::system_messages::with_user(
                format!("removed {}", target_username),
                target_uid,
            ),
        )
    } else {
        (
            SystemMessageKind::MemberLeft,
            target_uid,
            "left the chat".to_string(),
        )
    };
    if let Ok(SendMessageOutcome::Created(send_result)) =
        crate::services::messages::send_prepared_message(
            conn,
            SendPreparedMessageDeps {
                id_gen: deps.id_gen,
                media: deps.media,
                avatars: deps.avatars,
                metrics: deps.metrics,
            },
            PreparedMessageSend {
                system_kind: Some(system_kind),
                forwarded_from_message_id: None,
                metadata: None,
                chat_id,
                chat_kind: kind,
                sender_uid,
                message: Some(message),
                message_type: crate::models::MessageType::System,
                sticker_id: None,
                reply_to_id: None,
                reply_root_id: None,
                client_generated_id: uuid::Uuid::new_v4().to_string(),
                attachment_ids: vec![],
                publish_immediately: true,
                forwarded_bundle_id: None,
                forwarded_preview_total: None,
                forwarded_preview_contains_forwarded_messages: None,
                forwarded_preview_items: None,
            },
        )
        .await
    {
        let send_result = *send_result;
        send_result
            .side_effects
            .fire(deps.ws_registry, deps.push_service);
    }

    if is_admin_removing_other {
        let scope = match query.delete_messages.as_deref() {
            Some("last24h") => Some(DeleteScope::Last24Hours),
            Some("all") => Some(DeleteScope::All),
            _ => None,
        };
        if let Some(scope) = scope {
            deps.background_service
                .enqueue(BackgroundJob::BulkDeleteMessages {
                    chat_id,
                    target_uid,
                    scope,
                });
        }
    }

    Ok(())
}

pub fn patch_member(
    requester_uid: i32,
    chat_id: i64,
    target_uid: i32,
    body: UpdateMemberBody,
    conn: &mut PgConnection,
    avatars: &AvatarService,
    ws_registry: &ConnectionRegistry,
) -> Result<MemberResponse, AppError> {
    let member = crate::services::speaking::update_member_role(
        conn,
        chat_id,
        requester_uid,
        target_uid,
        body.role,
    )?;
    crate::services::speaking::broadcast_member_mode(conn, ws_registry, chat_id, target_uid)?;
    crate::services::system_messages::broadcast_policy(conn, ws_registry, chat_id)?;

    let profiles = lookup_user_profiles(conn, &[target_uid])?;
    let profile = profiles.get(&target_uid);
    let avatar_url = avatars.lookup(&[target_uid]).remove(&target_uid).flatten();
    Ok(MemberResponse {
        uid: target_uid,
        role: member.role,
        speaking_mode: member.speaking_mode,
        joined_at: member.joined_at,
        username: profile.and_then(|profile| profile.username.clone()),
        avatar_url,
        gender: profile.map(|profile| profile.gender).unwrap_or(0),
        user_group: profile.and_then(|profile| profile.user_group.clone()),
    })
}

pub fn put_member_speaking_mode(
    uid: i32,
    chat_id: i64,
    target_uid: i32,
    body: UpdateSpeakingModeRequest,
    conn: &mut PgConnection,
    ws_registry: &ConnectionRegistry,
) -> Result<MemberSpeakingModeResponse, AppError> {
    let updated = crate::services::speaking::update_member_mode(
        conn,
        chat_id,
        uid,
        target_uid,
        body.speaking_mode,
    )?;
    crate::services::speaking::broadcast_member_mode(conn, ws_registry, chat_id, target_uid)?;
    Ok(updated)
}

fn build_member_responses(
    conn: &mut PgConnection,
    avatars: &AvatarService,
    page_rows: Vec<(i32, GroupRole, DateTime<Utc>, SpeakingMode)>,
) -> Result<Vec<MemberResponse>, AppError> {
    let uids: Vec<i32> = page_rows.iter().map(|(uid, _, _, _)| *uid).collect();
    let profiles = lookup_user_profiles(conn, &uids)?;
    let mut avatar_urls = avatars.lookup(&uids);

    Ok(page_rows
        .into_iter()
        .map(|(uid, role, joined_at, speaking_mode)| {
            let profile = profiles.get(&uid);
            MemberResponse {
                avatar_url: avatar_urls.remove(&uid).flatten(),
                uid,
                role,
                speaking_mode,
                joined_at,
                username: profile.and_then(|profile| profile.username.clone()),
                gender: profile.map(|profile| profile.gender).unwrap_or(0),
                user_group: profile.and_then(|profile| profile.user_group.clone()),
            }
        })
        .collect())
}
