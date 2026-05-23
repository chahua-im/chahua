use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use serde_json::json;
use std::collections::HashMap;
use utoipa_axum::router::OpenApiRouter;

use diesel::PgConnection;

use crate::dto::members::{ListMembersResponse, MemberResponse};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::handlers::groups::load_requester_group_role;
use crate::models::{GroupJoinReason, GroupMembership, GroupRole, NewGroupMembership};
use crate::schema::{self, group_membership};

use crate::services::user::{
    lookup_user_avatars, lookup_user_profiles, parse_user_search_query, search_group_member_uids,
    UserSearchMode,
};
use crate::utils::{auth::CurrentUid, pagination::validate_limit};
use crate::{AppState, MAX_MEMBERS_LIMIT};

#[derive(serde::Deserialize)]
pub struct ChatIdPath {
    pub chat_id: i64,
}

#[derive(serde::Deserialize)]
pub struct MemberPath {
    chat_id: i64,
    uid: i32,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddMemberBody {
    uid: i32,
    #[serde(default)]
    role: Option<GroupRole>,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMemberBody {
    role: GroupRole,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct ListMembersQuery {
    limit: Option<i64>,
    after: Option<i32>,
    q: Option<String>,
    mode: Option<UserSearchMode>,
}

fn build_member_responses(
    conn: &mut diesel::PgConnection,
    state: &AppState,
    page_rows: Vec<(i32, GroupRole, DateTime<Utc>)>,
) -> Result<Vec<MemberResponse>, AppError> {
    let uids: Vec<i32> = page_rows.iter().map(|(uid, _, _)| *uid).collect();
    let profiles = lookup_user_profiles(conn, &uids)?;
    let mut avatars = lookup_user_avatars(state, &uids);

    Ok(page_rows
        .into_iter()
        .map(|(uid, role, joined_at)| {
            let profile = profiles.get(&uid);
            MemberResponse {
                avatar_url: avatars.remove(&uid).flatten(),
                uid,
                role,
                joined_at,
                username: profile.and_then(|profile| profile.username.clone()),
                gender: profile.map(|profile| profile.gender).unwrap_or(0),
                user_group: profile.and_then(|profile| profile.user_group.clone()),
            }
        })
        .collect())
}

/// Check if user is a member of the chat; return 403 if not.
pub(super) fn check_membership(
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
pub(super) fn require_admin_role(
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

/// GET /group/:chat_id/members — List members of a chat.
#[utoipa::path(
    get,
    path = "/",
    tag = "members",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("limit" = Option<i64>, Query, description = "Page size limit"),
        ("after" = Option<i32>, Query, description = "Cursor for pagination"),
        ("q" = Option<String>, Query, description = "Search query"),
        ("mode" = Option<UserSearchMode>, Query, description = "Search mode"),
    ),
    responses(
        (status = OK, body = ListMembersResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn get_members(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Query(q): Query<ListMembersQuery>,
) -> Result<Json<ListMembersResponse>, AppError> {
    let conn = &mut *conn;

    // Require membership to see members list
    check_membership(conn, chat_id, uid)?;

    use crate::schema::group_membership::dsl as gm_dsl;

    let requester_is_admin = matches!(
        load_requester_group_role(conn, chat_id, uid)?,
        Some(GroupRole::Admin)
    );

    let limit = validate_limit(q.limit, MAX_MEMBERS_LIMIT);
    let search_mode = q.mode.unwrap_or(UserSearchMode::Autocomplete);
    let search = parse_user_search_query(q.q.as_deref(), search_mode);

    let member_uids = search_group_member_uids(conn, chat_id, q.after, limit + 1, search.as_ref())?;

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
    let page_rows: Vec<(i32, GroupRole, DateTime<Utc>)> = page_uids
        .into_iter()
        .filter_map(|member_uid| {
            rows_by_uid
                .get(&member_uid)
                .map(|row| (row.uid, row.role.clone(), row.joined_at))
        })
        .collect();
    let members = build_member_responses(conn, &state, page_rows)?;

    let next_cursor = has_more
        .then(|| members.last().map(|member| member.uid))
        .flatten();

    Ok(Json(ListMembersResponse {
        members,
        next_cursor,
        can_manage_members: requester_is_admin,
    }))
}

/// POST /group/:chat_id/members — Add a member to the chat (caller must be admin).
#[utoipa::path(
    post,
    path = "/",
    tag = "members",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    request_body = AddMemberBody,
    responses(
        (status = CREATED, body = MemberResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn post_add_member(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Json(body): Json<AddMemberBody>,
) -> Result<(StatusCode, Json<MemberResponse>), AppError> {
    let conn = &mut *conn;

    // Check if requester is admin
    require_admin_role(conn, chat_id, uid)?;

    let profiles = lookup_user_profiles(conn, &[body.uid])?;
    let profile = profiles.get(&body.uid);

    if profile.is_none() {
        return Err(AppError::BadRequest("User not found"));
    }

    // Check if already a member
    let already_member = {
        use crate::schema::group_membership::dsl as gm_dsl;
        schema::group_membership::table
            .filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(body.uid)))
            .count()
            .get_result::<i64>(conn)?
    };

    if already_member > 0 {
        return Err(AppError::Conflict("User is already a member"));
    }

    let role = body.role.unwrap_or(GroupRole::Member);

    let last_message_id: Option<i64> = crate::schema::groups::table
        .filter(crate::schema::groups::id.eq(chat_id))
        .select(crate::schema::groups::last_message_id)
        .first(conn)
        .optional()?
        .flatten();
    let now = Utc::now();
    let new_membership = NewGroupMembership {
        chat_id,
        uid: body.uid,
        role: role.clone(),
        joined_at: now,
        join_reason: GroupJoinReason::DirectInvite,
        join_reason_extra: Some(json!({ "inviter_uid": uid })),
        last_read_message_id: last_message_id,
    };

    diesel::insert_into(group_membership::table)
        .values(&new_membership)
        .execute(conn)?;

    let target_username = profile
        .and_then(|p| p.username.clone())
        .unwrap_or_else(|| "Someone".to_string());

    if let Ok(send_result) = crate::handlers::chats::send_prepared_message(
        conn,
        &state,
        crate::handlers::chats::PreparedMessageSend {
            chat_id,
            sender_uid: uid,
            message: Some(format!("added {}", target_username)),
            message_type: crate::models::MessageType::System,
            sticker_id: None,
            reply_to_id: None,
            reply_root_id: None,
            client_generated_id: uuid::Uuid::new_v4().to_string(),
            attachment_ids: vec![],
            publish_immediately: true,
        },
    )
    .await
    {
        send_result.side_effects.fire(&state);
    }

    let avatar_url = lookup_user_avatars(&state, &[body.uid])
        .remove(&body.uid)
        .flatten();

    Ok((
        StatusCode::CREATED,
        Json(MemberResponse {
            uid: body.uid,
            role,
            joined_at: now,
            username: profile.and_then(|profile| profile.username.clone()),
            avatar_url,
            gender: profile.map(|profile| profile.gender).unwrap_or(0),
            user_group: profile.and_then(|profile| profile.user_group.clone()),
        }),
    ))
}

/// Query parameters for the remove-member endpoint.
#[derive(serde::Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
struct RemoveMemberQuery {
    /// Optional: "last24h" to delete messages from last 24 hours, "all" to delete all messages.
    delete_messages: Option<String>,
}

/// DELETE /group/:chat_id/members/:uid — Remove a member from the chat (caller must be admin).
#[utoipa::path(
    delete,
    path = "/{uid}",
    tag = "members",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("uid" = i32, Path, description = "User ID of the member"),
        RemoveMemberQuery,
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn delete_remove_member(
    CurrentUid(uid): CurrentUid,
    Path(MemberPath {
        chat_id,
        uid: target_uid,
    }): Path<MemberPath>,
    Query(query): Query<RemoveMemberQuery>,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;

    // Allow if requester is admin OR removing themselves
    let is_admin_removing_other = uid != target_uid;
    if is_admin_removing_other {
        require_admin_role(conn, chat_id, uid)?;
    } else {
        check_membership(conn, chat_id, uid)?;
    }

    // Check if target is a member and whether deleting it would remove the final admin.
    use crate::schema::group_membership::dsl as gm_dsl;
    let target_role: Option<GroupRole> = group_membership::table
        .filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(target_uid)))
        .select(gm_dsl::role)
        .first(conn)
        .optional()?;

    let Some(target_role) = target_role else {
        return Err(AppError::NotFound("Member not found"));
    };

    let target_username = crate::services::user::lookup_user_profiles(conn, &[target_uid])
        .ok()
        .and_then(|mut profiles| profiles.remove(&target_uid))
        .and_then(|p| p.username)
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
        group_membership::table.filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(target_uid))),
    )
    .execute(conn)?;

    let (sys_sender_uid, sys_msg) = if is_admin_removing_other {
        (uid, format!("removed {}", target_username))
    } else {
        (target_uid, "left the chat".to_string())
    };

    if let Ok(send_result) = crate::handlers::chats::send_prepared_message(
        conn,
        &state,
        crate::handlers::chats::PreparedMessageSend {
            chat_id,
            sender_uid: sys_sender_uid,
            message: Some(sys_msg),
            message_type: crate::models::MessageType::System,
            sticker_id: None,
            reply_to_id: None,
            reply_root_id: None,
            client_generated_id: uuid::Uuid::new_v4().to_string(),
            attachment_ids: vec![],
            publish_immediately: true,
        },
    )
    .await
    {
        send_result.side_effects.fire(&state);
    }

    // Enqueue bulk message deletion if requested (only when admin removes someone else)
    if is_admin_removing_other {
        if let Some(ref scope_str) = query.delete_messages {
            use crate::services::background::{BackgroundJob, DeleteScope};
            let scope = match scope_str.as_str() {
                "last24h" => Some(DeleteScope::Last24Hours),
                "all" => Some(DeleteScope::All),
                _ => None,
            };
            if let Some(scope) = scope {
                state
                    .background_service
                    .enqueue(BackgroundJob::BulkDeleteMessages {
                        chat_id,
                        target_uid,
                        scope,
                    });
            }
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

/// PATCH /group/:chat_id/members/:uid — Update member role (admin only).
#[utoipa::path(
    patch,
    path = "/{uid}",
    tag = "members",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
        ("uid" = i32, Path, description = "User ID of the member"),
    ),
    request_body = UpdateMemberBody,
    responses(
        (status = OK, body = MemberResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn patch_member(
    CurrentUid(requester_uid): CurrentUid,
    State(state): State<AppState>,
    Path(MemberPath {
        chat_id,
        uid: target_uid,
    }): Path<MemberPath>,
    mut conn: DbConn,
    Json(body): Json<UpdateMemberBody>,
) -> Result<Json<MemberResponse>, AppError> {
    let conn = &mut *conn;

    // Check if requester is admin
    require_admin_role(conn, chat_id, requester_uid)?;

    // Prevent self-demotion
    if requester_uid == target_uid {
        return Err(AppError::BadRequest("Cannot change your own role"));
    }

    // Check if target is a member
    use crate::schema::group_membership::dsl as gm_dsl;
    let is_member = group_membership::table
        .filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(target_uid)))
        .count()
        .get_result::<i64>(conn)?;

    if is_member == 0 {
        return Err(AppError::NotFound("Member not found"));
    }

    // Update role
    diesel::update(
        group_membership::table.filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(target_uid))),
    )
    .set(gm_dsl::role.eq(&body.role))
    .execute(conn)?;

    // Get updated member info
    let (role, joined_at): (GroupRole, DateTime<Utc>) = group_membership::table
        .filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(target_uid)))
        .select((gm_dsl::role, gm_dsl::joined_at))
        .first(conn)?;

    let profiles = lookup_user_profiles(conn, &[target_uid])?;
    let profile = profiles.get(&target_uid);

    let avatar_url = lookup_user_avatars(&state, &[target_uid])
        .remove(&target_uid)
        .flatten();

    Ok(Json(MemberResponse {
        uid: target_uid,
        role,
        joined_at,
        username: profile.and_then(|profile| profile.username.clone()),
        avatar_url,
        gender: profile.map(|profile| profile.gender).unwrap_or(0),
        user_group: profile.and_then(|profile| profile.user_group.clone()),
    }))
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(get_members, post_add_member))
        .routes(utoipa_axum::routes!(delete_remove_member, patch_member))
}
