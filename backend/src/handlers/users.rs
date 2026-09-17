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
    MeResponse, MemberSummary, PresenceVisibilityResponse, SearchUsersResponse,
    StickerPackOrderItem,
};
use crate::dto::ws::{ServerWsMessage, StickerPackOrderUpdatePayload};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::models::{FriendAddVerificationMode, NewUserExtra, PresenceVisibility, UserExtra};
use crate::schema::{group_membership, sticker_packs, user_extra, user_sticker_pack_subscriptions};
use crate::services::authz::{Action as AuthzAction, Resource as AuthzResource};
use crate::services::user::{lookup_user_profiles, search_user_uids_by_prefix};
use crate::utils::auth::{BearerSession, CurrentUid};
use crate::AppState;
use diesel::prelude::*;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

const DEFAULT_USER_SEARCH_LIMIT: i64 = 20;
const MAX_USER_SEARCH_LIMIT: i64 = 50;

#[derive(serde::Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStickerPackOrderItem {
    pub sticker_pack_id: String,
    pub last_used_on: i64,
    pub is_auto_sort: Option<bool>,
}

#[derive(serde::Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStickerPackOrderRequest {
    pub order: Vec<UpdateStickerPackOrderItem>,
}

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
    let conn = &mut *conn;
    let requested_order = req.order;

    let requested_pack_ids: Vec<i64> = requested_order
        .iter()
        .filter_map(|item| item.sticker_pack_id.parse::<i64>().ok())
        .collect();
    let accessible_pack_ids = load_accessible_sticker_pack_ids(conn, uid, &requested_pack_ids)?;

    let extra = user_extra::table
        .filter(user_extra::uid.eq(uid))
        .first::<UserExtra>(conn)
        .optional()?;

    let mut current_order = extra
        .and_then(|e| {
            serde_json::from_value::<Vec<StickerPackOrderItem>>(e.sticker_pack_order).ok()
        })
        .unwrap_or_default();

    // Sort descending by last_used_on to safely determine position
    let mut sorted_order = current_order.clone();
    sorted_order.sort_by_key(|o| -o.last_used_on);

    use crate::MAX_AUTO_SORT_LIMIT;
    let auto_sort_limit = MAX_AUTO_SORT_LIMIT;

    for inc in requested_order {
        let Ok(pack_id) = inc.sticker_pack_id.parse::<i64>() else {
            continue;
        };

        if !accessible_pack_ids.contains(&pack_id) {
            continue;
        }

        if inc.is_auto_sort.unwrap_or(false) {
            let current_pos = sorted_order
                .iter()
                .position(|o| o.sticker_pack_id == inc.sticker_pack_id);
            let Some(pos) = current_pos else {
                continue;
            };
            if pos >= auto_sort_limit {
                continue;
            }
        }

        if let Some(existing) = current_order
            .iter_mut()
            .find(|o| o.sticker_pack_id == inc.sticker_pack_id)
        {
            existing.last_used_on = inc.last_used_on;
        } else {
            current_order.push(StickerPackOrderItem {
                sticker_pack_id: inc.sticker_pack_id,
                last_used_on: inc.last_used_on,
            });
        }

        sorted_order = current_order.clone();
        sorted_order.sort_by_key(|item| -item.last_used_on);
    }

    let order_json = serde_json::to_value(&current_order).unwrap_or(serde_json::json!([]));

    let affected = diesel::update(user_extra::table.filter(user_extra::uid.eq(uid)))
        .set(user_extra::sticker_pack_order.eq(&order_json))
        .execute(conn)?;

    if affected == 0 {
        let now = chrono::Utc::now().naive_utc();
        diesel::insert_into(user_extra::table)
            .values(NewUserExtra {
                uid,
                first_seen_at: now,
                last_seen_at: None,
                presence_visibility: PresenceVisibility::Everyone,
                sticker_pack_order: order_json.clone(),
                verification_mode: FriendAddVerificationMode::Direct,
                verification_question: None,
            })
            .execute(conn)?;
    }

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
    viewer_uid: i32,
    uids: &[i32],
) -> Result<HashMap<i32, MemberSummary>, AppError> {
    let profiles = lookup_user_profiles(conn, uids)?;
    let mut avatars = state.avatars.lookup(uids);
    let presence = crate::services::social::visible_presence_records(conn, viewer_uid, uids)?;
    let online_flags = state.ws_registry.online_flags(uids);

    Ok(uids
        .iter()
        .filter_map(|uid| {
            profiles.get(uid).map(|profile| {
                let visible_presence = presence.get(uid).copied();
                let presence_view = presence_view(
                    visible_presence,
                    online_flags.get(uid).copied().unwrap_or(false),
                );
                (
                    *uid,
                    MemberSummary {
                        uid: *uid,
                        username: profile.username.clone(),
                        avatar_url: avatars.remove(uid).flatten(),
                        gender: profile.gender,
                        user_group: profile.user_group.clone(),
                        last_seen_at: presence_view.last_seen_at,
                        online: presence_view.online,
                    },
                )
            })
        })
        .collect())
}

/// The published presence fields shared by every REST DTO: `online` is only
/// true when the record is visible and the user's published state is online;
/// `last_seen_at` is only shown when offline, and only when visible.
///
/// These are the §7.1 return invariants:
/// visible + online      => { online: true,  lastSeenAt: null }
/// visible + offline     => { online: false, lastSeenAt: db value | null }
/// not visible           => { online: false, lastSeenAt: null }
pub(crate) fn presence_view(
    visible_presence: Option<crate::services::social::VisiblePresence>,
    published_online: bool,
) -> PresenceView {
    let visible = visible_presence.is_some_and(|record| record.visible);
    let online = visible && published_online;
    let last_seen_at = if online {
        None
    } else if visible {
        visible_presence.and_then(|record| record.last_seen_at)
    } else {
        None
    };
    PresenceView {
        online,
        last_seen_at: last_seen_at.map(|last_seen_at| {
            chrono::DateTime::from_naive_utc_and_offset(last_seen_at, chrono::Utc)
        }),
    }
}

/// The published presence portion of a REST DTO, in UTC.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PresenceView {
    pub online: bool,
    pub last_seen_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[utoipa::path(
    get,
    path = "/me/presence-visibility",
    tag = "users",
    responses((status = 200, body = PresenceVisibilityResponse)),
    security(("bearer_jwt" = []))
)]
async fn get_presence_visibility(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<Json<PresenceVisibilityResponse>, AppError> {
    Ok(Json(PresenceVisibilityResponse {
        visibility: crate::services::social::get_presence_visibility(&mut conn, uid)?,
    }))
}

#[utoipa::path(
    put,
    path = "/me/presence-visibility",
    tag = "users",
    request_body = PresenceVisibilityResponse,
    responses((status = 200, body = PresenceVisibilityResponse)),
    security(("bearer_jwt" = []))
)]
async fn put_presence_visibility(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<PresenceVisibilityResponse>,
) -> Result<Json<PresenceVisibilityResponse>, AppError> {
    let permit = state.ws_registry.reserve_reconciliation().await?;
    let mutation =
        crate::services::social::upsert_presence_visibility(&mut conn, uid, body.visibility)?;
    permit.send_visibility(mutation.reconciliation);
    Ok(Json(PresenceVisibilityResponse {
        visibility: mutation.visibility,
    }))
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
    }))
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

    let summaries_by_uid = build_member_summary_map(conn, &state, uid, &merged_uids)?;
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
        .routes(routes!(get_me))
        .routes(routes!(get_user_search))
        .routes(routes!(get_auth_token))
        .routes(routes!(put_stickerpack_order))
        .routes(routes!(get_presence_visibility))
        .routes(routes!(put_presence_visibility))
}

fn load_accessible_sticker_pack_ids(
    conn: &mut PgConnection,
    uid: i32,
    pack_ids: &[i64],
) -> Result<HashSet<i64>, AppError> {
    if pack_ids.is_empty() {
        return Ok(HashSet::new());
    }

    let owned_pack_ids: Vec<i64> = sticker_packs::table
        .filter(sticker_packs::owner_uid.eq(uid))
        .filter(sticker_packs::id.eq_any(pack_ids))
        .select(sticker_packs::id)
        .load(conn)?;

    let subscribed_pack_ids: Vec<i64> = user_sticker_pack_subscriptions::table
        .filter(user_sticker_pack_subscriptions::uid.eq(uid))
        .filter(user_sticker_pack_subscriptions::pack_id.eq_any(pack_ids))
        .select(user_sticker_pack_subscriptions::pack_id)
        .load(conn)?;

    Ok(owned_pack_ids
        .into_iter()
        .chain(subscribed_pack_ids)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_user_search_limit, presence_view, split_excluded_member_summaries, MemberSummary,
    };
    use crate::services::social::VisiblePresence;
    use chrono::{NaiveDate, NaiveDateTime};
    use std::collections::HashSet;

    fn visible(last_seen_at: Option<NaiveDateTime>) -> Option<VisiblePresence> {
        Some(VisiblePresence {
            visible: true,
            last_seen_at,
        })
    }

    fn hidden() -> Option<VisiblePresence> {
        Some(VisiblePresence {
            visible: false,
            last_seen_at: Some(
                NaiveDate::from_ymd_opt(2026, 1, 1)
                    .unwrap()
                    .and_hms_opt(0, 0, 0)
                    .unwrap(),
            ),
        })
    }

    fn stored_time() -> Option<NaiveDateTime> {
        Some(
            NaiveDate::from_ymd_opt(2026, 9, 15)
                .unwrap()
                .and_hms_opt(12, 0, 0)
                .unwrap(),
        )
    }

    #[test]
    fn presence_view_online_hides_last_seen() {
        // Visible + online => { online: true, lastSeenAt: null }, even though a
        // stored last-seen value exists.
        let view = presence_view(visible(stored_time()), true);
        assert!(view.online);
        assert_eq!(view.last_seen_at, None);
    }

    #[test]
    fn presence_view_offline_shows_stored_last_seen() {
        let view = presence_view(visible(stored_time()), false);
        assert!(!view.online);
        assert_eq!(
            view.last_seen_at,
            Some(chrono::DateTime::from_naive_utc_and_offset(
                stored_time().unwrap(),
                chrono::Utc
            ))
        );
    }

    #[test]
    fn presence_view_offline_without_history_shows_null() {
        // Visible, online=false, never confirmed Active => lastSeenAt: null.
        let view = presence_view(visible(None), false);
        assert!(!view.online);
        assert_eq!(view.last_seen_at, None);
    }

    #[test]
    fn presence_view_hidden_is_offline_with_null_last_seen() {
        // A hidden record must not leak its stored value even when the
        // subject's published state is online.
        let view = presence_view(hidden(), true);
        assert!(!view.online);
        assert_eq!(view.last_seen_at, None);
        let view = presence_view(hidden(), false);
        assert!(!view.online);
        assert_eq!(view.last_seen_at, None);
    }

    #[test]
    fn presence_view_missing_record_is_offline_with_null_last_seen() {
        // Missing user_extra row: defaults apply (everyone + null), and an
        // offline user has no last seen to show.
        let view = presence_view(None, false);
        assert!(!view.online);
        assert_eq!(view.last_seen_at, None);
    }

    fn make_summary(uid: i32) -> MemberSummary {
        MemberSummary {
            uid,
            username: Some(format!("user{uid}")),
            avatar_url: None,
            gender: 0,
            user_group: None,
            last_seen_at: None,
            online: false,
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
