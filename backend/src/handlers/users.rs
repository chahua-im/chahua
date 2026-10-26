use axum::{
    extract::{Query, State},
    Json,
};
use serde::Deserialize;
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::auth::AuthTokenResponse;
use crate::dto::users::{
    ChatSettings, MeResponse, MemberSummary, SearchUsersResponse, StickerPackOrderItem,
    UpdateChatSettings, UpdateStickerPackOrderRequest,
};
use crate::dto::ws::{ServerWsMessage, StickerPackOrderUpdatePayload};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::models::UserExtra;
use crate::schema::{group_membership, user_extra};
use crate::services::authz::{Action as AuthzAction, Resource as AuthzResource};
use crate::services::sticker_order;
use crate::services::user::{lookup_user_profiles, search_user_uids_by_prefix};
use crate::utils::auth::{BearerSession, CurrentUid};
use crate::AppState;
use diesel::prelude::*;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

const DEFAULT_USER_SEARCH_LIMIT: i64 = 20;
const MAX_USER_SEARCH_LIMIT: i64 = 50;

#[utoipa::path(
    put,
    path = "/me/stickerpack-order",
    tag = "users",
    request_body = UpdateStickerPackOrderRequest,
    responses(
        (status = 200, description = "Order updated successfully")
    ),
    security(("bearer_jwt" = []))
)]
async fn put_stickerpack_order(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(req): Json<UpdateStickerPackOrderRequest>,
) -> Result<Json<()>, AppError> {
    let current_order = sticker_order::update_order(&mut conn, uid, req.order)?;

    let msg = Arc::new(ServerWsMessage::StickerPackOrderUpdated(
        StickerPackOrderUpdatePayload {
            order: current_order,
        },
    ));
    state.ws_registry.broadcast_to_uids(&[uid], msg);

    Ok(Json(()))
}

#[derive(Debug, Deserialize, ToSchema, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct SearchUsersQuery {
    q: Option<String>,
    limit: Option<i64>,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    exclude_member_of: Option<i64>,
}

fn normalize_user_search_limit(limit: Option<i64>) -> i64 {
    limit
        .unwrap_or(DEFAULT_USER_SEARCH_LIMIT)
        .clamp(1, MAX_USER_SEARCH_LIMIT)
}

pub fn build_member_summary_map(
    conn: &mut PgConnection,
    state: &AppState,
    uids: &[i32],
) -> Result<HashMap<i32, MemberSummary>, AppError> {
    let profiles = lookup_user_profiles(conn, uids)?;
    let mut avatars = state.avatars.lookup(uids);

    Ok(uids
        .iter()
        .filter_map(|uid| {
            profiles.get(uid).map(|profile| {
                (
                    *uid,
                    MemberSummary {
                        uid: *uid,
                        username: profile.username.clone(),
                        avatar_url: avatars.remove(uid).flatten(),
                        gender: profile.gender,
                        user_group: profile.user_group.clone(),
                    },
                )
            })
        })
        .collect())
}

fn can_exclude_members_of_chat(
    conn: &mut PgConnection,
    requester_uid: i32,
    chat_id: i64,
) -> Result<bool, AppError> {
    use crate::schema::group_membership::dsl as gm_dsl;

    let count = group_membership::table
        .filter(
            gm_dsl::chat_id
                .eq(chat_id)
                .and(gm_dsl::uid.eq(requester_uid)),
        )
        .count()
        .get_result::<i64>(conn)?;

    Ok(count > 0)
}

fn split_excluded_member_summaries(
    summaries: Vec<MemberSummary>,
    member_uid_set: &HashSet<i32>,
) -> (Vec<MemberSummary>, Vec<MemberSummary>) {
    let mut members = Vec::new();
    let mut excluded = Vec::new();
    for summary in summaries {
        if member_uid_set.contains(&summary.uid) {
            excluded.push(summary);
        } else {
            members.push(summary);
        }
    }

    (members, excluded)
}

fn load_excluded_member_uids(
    conn: &mut PgConnection,
    chat_id: i64,
    uids: &[i32],
) -> Result<HashSet<i32>, AppError> {
    if uids.is_empty() {
        return Ok(HashSet::new());
    }

    use crate::schema::group_membership::dsl as gm_dsl;

    Ok(group_membership::table
        .filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq_any(uids)))
        .select(gm_dsl::uid)
        .load::<i32>(conn)?
        .into_iter()
        .collect())
}

/// GET /users/me — Get the current logged in user's information
#[utoipa::path(
    get,
    path = "/me",
    tag = "users",
    responses(
        (status = 200, description = "Current user info", body = MeResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn get_me(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<Json<MeResponse>, AppError> {
    let conn = &mut *conn;

    let profiles = lookup_user_profiles(conn, &[uid])?;
    let profile = profiles.get(&uid);
    let username = profile
        .and_then(|profile| profile.username.clone())
        .unwrap_or_else(|| "Unknown".to_string());

    let mut avatars = state.avatars.lookup(&[uid]);
    let avatar_url = avatars.remove(&uid).flatten();

    let extra = user_extra::table
        .filter(user_extra::uid.eq(uid))
        .select(UserExtra::as_select())
        .first::<UserExtra>(conn)
        .optional()?;

    let notification_defaults = extra
        .as_ref()
        .map(
            |extra| crate::services::notification_preferences::NotificationDefaults {
                group_chats_muted: extra.mute_group_chats_by_default,
                direct_chats_muted: extra.mute_direct_chats_by_default,
            },
        )
        .unwrap_or_default();
    let show_membership_messages = extra
        .as_ref()
        .is_none_or(|extra| extra.show_membership_messages);
    let sticker_pack_order = extra
        .and_then(|e| {
            serde_json::from_value::<Vec<StickerPackOrderItem>>(e.sticker_pack_order).ok()
        })
        .unwrap_or_default();
    let permissions = state.authz_service.list_permissions(
        conn,
        uid,
        crate::services::authz::Resource::Global,
    )?;

    Ok(Json(MeResponse {
        uid,
        username,
        avatar_url,
        gender: profile.map(|profile| profile.gender).unwrap_or(0),
        user_group: profile.and_then(|profile| profile.user_group.clone()),
        sticker_pack_order,
        permissions,
        mute_group_chats_by_default: notification_defaults.group_chats_muted,
        mute_direct_chats_by_default: notification_defaults.direct_chats_muted,
        show_membership_messages,
    }))
}

#[utoipa::path(
    put, path = "/me/chat-settings", tag = "users", request_body = UpdateChatSettings,
    responses((status = 200, description = "Saved account chat settings", body = ChatSettings)),
    security(("bearer_jwt" = []))
)]
async fn put_chat_settings(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(settings): Json<UpdateChatSettings>,
) -> Result<Json<ChatSettings>, AppError> {
    let settings = crate::services::user::save_chat_settings(&mut conn, uid, settings)?;
    state.ws_registry.invalidate_unread(&[uid]);
    Ok(Json(settings))
}

/// GET /users/search — Search global users for targeted invites.
#[utoipa::path(
    get,
    path = "/search",
    tag = "users",
    params(SearchUsersQuery),
    responses(
        (status = 200, description = "User search results", body = SearchUsersResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn get_user_search(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(query): Query<SearchUsersQuery>,
) -> Result<Json<SearchUsersResponse>, AppError> {
    let conn = &mut *conn;
    let q = query.q.as_deref().map(str::trim).unwrap_or("");
    let limit = normalize_user_search_limit(query.limit);

    let mut merged_uids = Vec::new();
    let mut seen_uids = HashSet::new();

    if let Ok(exact_uid) = q.parse::<i32>() {
        seen_uids.insert(exact_uid);
        merged_uids.push(exact_uid);
    }

    if !q.is_empty()
        && state.authz_service.has_permission(
            conn,
            uid,
            AuthzAction::MemberViewAll,
            AuthzResource::Global,
        )?
    {
        for found_uid in search_user_uids_by_prefix(conn, q, limit)? {
            if seen_uids.insert(found_uid) {
                merged_uids.push(found_uid);
            }
        }
    }

    let summaries_by_uid = build_member_summary_map(conn, &state, &merged_uids)?;
    let summaries: Vec<MemberSummary> = merged_uids
        .into_iter()
        .filter_map(|member_uid| summaries_by_uid.get(&member_uid).cloned())
        .collect();

    let exclude_member_of = match query.exclude_member_of {
        Some(chat_id) if can_exclude_members_of_chat(conn, uid, chat_id)? => Some(chat_id),
        _ => None,
    };
    let excluded_uids = match exclude_member_of {
        Some(chat_id) => {
            let summary_uids: Vec<i32> = summaries.iter().map(|summary| summary.uid).collect();
            load_excluded_member_uids(conn, chat_id, &summary_uids)?
        }
        None => HashSet::new(),
    };
    let (members, excluded) = split_excluded_member_summaries(summaries, &excluded_uids);

    Ok(Json(SearchUsersResponse { members, excluded }))
}

#[utoipa::path(
    get,
    path = "/auth-token",
    tag = "users",
    responses(
        (status = 200, description = "Auth token", body = AuthTokenResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn get_auth_token(
    State(state): State<AppState>,
    BearerSession(session): BearerSession,
) -> Result<Json<AuthTokenResponse>, AppError> {
    let token = state.auth_token_service.issue_legacy_session(
        session.uid,
        &session.client_id,
        session.generation,
    )?;

    Ok(Json(AuthTokenResponse { token }))
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .merge(super::notification_preferences::router())
        .routes(routes!(get_me))
        .routes(routes!(put_chat_settings))
        .routes(routes!(get_user_search))
        .routes(routes!(get_auth_token))
        .routes(routes!(put_stickerpack_order))
}

#[cfg(test)]
mod tests {
    use super::{normalize_user_search_limit, split_excluded_member_summaries, MemberSummary};
    use std::collections::HashSet;

    fn make_summary(uid: i32) -> MemberSummary {
        MemberSummary {
            uid,
            username: Some(format!("user{uid}")),
            avatar_url: None,
            gender: 0,
            user_group: None,
        }
    }

    #[test]
    fn normalize_user_search_limit_clamps_to_max() {
        assert_eq!(normalize_user_search_limit(None), 20);
        assert_eq!(normalize_user_search_limit(Some(999)), 50);
        assert_eq!(normalize_user_search_limit(Some(5)), 5);
        assert_eq!(normalize_user_search_limit(Some(0)), 1);
    }

    #[test]
    fn split_excluded_uses_membership_set() {
        let summaries = vec![make_summary(1), make_summary(2), make_summary(3)];
        let excluded_uids = HashSet::from([2, 3]);
        let result = split_excluded_member_summaries(summaries, &excluded_uids);

        assert_eq!(
            result
                .0
                .iter()
                .map(|summary| summary.uid)
                .collect::<Vec<_>>(),
            vec![1]
        );
        assert_eq!(
            result
                .1
                .iter()
                .map(|summary| summary.uid)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
    }
}
