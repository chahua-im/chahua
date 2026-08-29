use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
};
use diesel::PgConnection;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::friends::{
    FriendAddInfoResponse, FriendRequestDirection, FriendRequestHistoryEntry,
    FriendRequestResponse, FriendResponse, FriendSettingsResponse,
    ListFriendRequestHistoryResponse, ListFriendsResponse, PendingFriendRequestCountResponse,
    UpdateFriendSettingsBody,
};
use crate::dto::users::MemberSummary;
use crate::dto::ws::{
    FriendRequestReceivedPayload, FriendRequestResolvedPayload, FriendshipRemovedPayload,
    ServerWsMessage,
};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::handlers::users::build_member_summary_map;
use crate::models::{FriendRequest, FriendRequestStatus};
use crate::services::authz::Action as AuthzAction;
use crate::services::social::{self, CreateRequestOutcome, ResolveOutcome};
use crate::services::user::lookup_user_profiles;
use crate::utils::auth::{CurrentUid, Principal};
use crate::AppState;

const MAX_FRIEND_REQUEST_MESSAGE_CHARS: usize = 200;
const MAX_FRIEND_VERIFICATION_QUESTION_CHARS: usize = 100;

fn validate_friend_request_message(message: Option<&str>) -> Result<(), AppError> {
    if message.is_some_and(|value| value.chars().count() > MAX_FRIEND_REQUEST_MESSAGE_CHARS) {
        return Err(AppError::BadRequest(
            "Friend request message must not exceed 200 characters",
        ));
    }
    Ok(())
}

fn validate_friend_verification_question(question: Option<&str>) -> Result<(), AppError> {
    if question.is_some_and(|value| value.chars().count() > MAX_FRIEND_VERIFICATION_QUESTION_CHARS)
    {
        return Err(AppError::BadRequest(
            "Friend verification question must not exceed 100 characters",
        ));
    }
    Ok(())
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct CreateFriendRequestBody {
    to_uid: i32,
    /// Verification message (mode 1) or the answer to the target's question (mode 3).
    /// Ignored for `direct` mode; required for `need_message` / `question` modes.
    #[serde(default)]
    #[schema(max_length = 200)]
    message: Option<String>,
}

#[derive(Deserialize)]
struct FriendPath {
    uid: i32,
}

#[derive(Deserialize)]
struct RequestIdPath {
    request_id: i64,
}

fn fire_ws(state: &AppState, uids: &[i32], msg: ServerWsMessage) {
    state.ws_registry.broadcast_to_uids(uids, Arc::new(msg));
}

fn missing_user_summary(uid: i32) -> MemberSummary {
    MemberSummary {
        uid,
        username: None,
        avatar_url: None,
        gender: 0,
        user_group: None,
    }
}

fn build_request_response(
    conn: &mut PgConnection,
    state: &AppState,
    request: &FriendRequest,
) -> Result<FriendRequestResponse, AppError> {
    let summaries = build_member_summary_map(conn, state, &[request.from_uid, request.to_uid])?;
    Ok(FriendRequestResponse {
        id: request.id,
        from: summaries
            .get(&request.from_uid)
            .cloned()
            .unwrap_or_else(|| missing_user_summary(request.from_uid)),
        to: summaries
            .get(&request.to_uid)
            .cloned()
            .unwrap_or_else(|| missing_user_summary(request.to_uid)),
        status: request.status,
        created_at: request.created_at,
        decided_at: request.decided_at,
        message: request.message.clone(),
        question: request.question.clone(),
    })
}

fn build_request_responses(
    conn: &mut PgConnection,
    state: &AppState,
    requests: &[FriendRequest],
) -> Result<Vec<FriendRequestResponse>, AppError> {
    let mut uids: Vec<i32> = Vec::with_capacity(requests.len() * 2);
    for request in requests {
        uids.push(request.from_uid);
        uids.push(request.to_uid);
    }
    let summaries: HashMap<i32, MemberSummary> = build_member_summary_map(conn, state, &uids)?;
    Ok(requests
        .iter()
        .map(|request| FriendRequestResponse {
            id: request.id,
            from: summaries
                .get(&request.from_uid)
                .cloned()
                .unwrap_or_else(|| missing_user_summary(request.from_uid)),
            to: summaries
                .get(&request.to_uid)
                .cloned()
                .unwrap_or_else(|| missing_user_summary(request.to_uid)),
            status: request.status,
            created_at: request.created_at,
            decided_at: request.decided_at,
            message: request.message.clone(),
            question: request.question.clone(),
        })
        .collect())
}

#[utoipa::path(
    get,
    path = "/",
    tag = "friends",
    responses((status = 200, description = "Current user's friends", body = ListFriendsResponse)),
    security(("uid_header" = []), ("bearer_jwt" = []), ("service_token_bearer" = [])),
    params(("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth"))
)]
async fn get_friends(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<Json<ListFriendsResponse>, AppError> {
    let conn = &mut *conn;
    let uid = principal.require_user_action(conn, &state, AuthzAction::OnBehalfOfSocialRead)?;
    let friends = social::list_friends_with_since(conn, uid)?;
    let uids: Vec<i32> = friends.iter().map(|(uid, _)| *uid).collect();
    let summaries = build_member_summary_map(conn, &state, &uids)?;
    let friends = friends
        .into_iter()
        .filter_map(|(uid, since)| {
            summaries.get(&uid).map(|user| FriendResponse {
                user: user.clone(),
                since,
            })
        })
        .collect();
    Ok(Json(ListFriendsResponse { friends }))
}

#[utoipa::path(
    delete,
    path = "/{uid}",
    tag = "friends",
    params(
        ("uid" = i32, Path, description = "UID of the friend to remove"),
        ("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth")
    ),
    responses((status = 204, description = "Friend removed"), (status = 404, description = "Not friends")),
    security(("uid_header" = []), ("bearer_jwt" = []), ("service_token_bearer" = []))
)]
async fn delete_friend(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Path(FriendPath { uid: other }): Path<FriendPath>,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;
    let uid = principal.require_user_action(conn, &state, AuthzAction::OnBehalfOfSocialWrite)?;
    let removed = social::remove_friendship(conn, uid, other)?;
    if !removed {
        return Err(AppError::NotFound("Friendship not found"));
    }
    fire_ws(
        &state,
        &[uid, other],
        ServerWsMessage::FriendshipRemoved(FriendshipRemovedPayload { actor_uid: uid }),
    );
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/requests",
    tag = "friends",
    request_body = CreateFriendRequestBody,
    responses(
        (status = 201, description = "Friend request created", body = FriendRequestResponse),
        (status = 200, description = "Reciprocal request auto-accepted", body = FriendRequestResponse),
        (status = 409, description = "Already pending or already friends")
    ),
    security(("uid_header" = []), ("bearer_jwt" = []), ("service_token_bearer" = [])),
    params(("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth"))
)]
async fn create_friend_request(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<CreateFriendRequestBody>,
) -> Result<(StatusCode, Json<FriendRequestResponse>), AppError> {
    let conn = &mut *conn;
    let uid = principal.require_user_action(conn, &state, AuthzAction::OnBehalfOfSocialWrite)?;
    validate_friend_request_message(body.message.as_deref())?;

    let target_profiles = lookup_user_profiles(conn, &[body.to_uid])?;
    if !target_profiles.contains_key(&body.to_uid) {
        return Err(AppError::NotFound("User not found"));
    }

    let outcome =
        social::create_friend_request(conn, &state, uid, body.to_uid, body.message).await?;
    match outcome {
        CreateRequestOutcome::Created { request } => {
            fire_ws(
                &state,
                &[request.to_uid],
                ServerWsMessage::FriendRequestReceived(FriendRequestReceivedPayload {
                    from_uid: uid,
                }),
            );
            let response = build_request_response(conn, &state, &request)?;
            Ok((StatusCode::CREATED, Json(response)))
        }
        CreateRequestOutcome::AutoAccepted { request } => {
            // Notify the original requester that their request was accepted.
            fire_ws(
                &state,
                &[request.from_uid],
                ServerWsMessage::FriendRequestResolved(FriendRequestResolvedPayload {
                    request_id: request.id,
                    status: FriendRequestStatus::Accepted,
                    by_uid: uid,
                }),
            );
            let response = build_request_response(conn, &state, &request)?;
            Ok((StatusCode::OK, Json(response)))
        }
        CreateRequestOutcome::AlreadyPending => {
            Err(AppError::Conflict("Friend request already pending"))
        }
        CreateRequestOutcome::AlreadyFriends => Err(AppError::Conflict("Already friends")),
    }
}

#[utoipa::path(
    get,
    path = "/requests/pending/count",
    tag = "friends",
    responses((status = 200, description = "Number of pending incoming friend requests", body = PendingFriendRequestCountResponse)),
    security(("uid_header" = []), ("bearer_jwt" = []), ("service_token_bearer" = [])),
    params(("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth"))
)]
async fn count_pending_incoming_requests(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<Json<PendingFriendRequestCountResponse>, AppError> {
    let conn = &mut *conn;
    let uid = principal.require_user_action(conn, &state, AuthzAction::OnBehalfOfSocialRead)?;
    let pending_incoming_count = social::count_incoming_requests(conn, uid)?;
    Ok(Json(PendingFriendRequestCountResponse {
        pending_incoming_count,
    }))
}

#[utoipa::path(
    get,
    path = "/requests",
    tag = "friends",
    responses((status = 200, description = "Friend request history in both directions, newest first", body = ListFriendRequestHistoryResponse)),
    security(("uid_header" = []), ("bearer_jwt" = []), ("service_token_bearer" = [])),
    params(("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth"))
)]
async fn list_friend_request_history(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<Json<ListFriendRequestHistoryResponse>, AppError> {
    let conn = &mut *conn;
    let uid = principal.require_user_action(conn, &state, AuthzAction::OnBehalfOfSocialRead)?;
    let rows = social::list_friend_request_history(conn, uid)?;
    let directions: Vec<FriendRequestDirection> = rows
        .iter()
        .map(|row| {
            if row.to_uid == uid {
                FriendRequestDirection::Incoming
            } else {
                FriendRequestDirection::Outgoing
            }
        })
        .collect();
    let requests = build_request_responses(conn, &state, &rows)?
        .into_iter()
        .zip(directions)
        .map(|(request, direction)| FriendRequestHistoryEntry { request, direction })
        .collect();
    Ok(Json(ListFriendRequestHistoryResponse { requests }))
}

#[utoipa::path(
    post,
    path = "/requests/{request_id}/accept",
    tag = "friends",
    params(
        ("request_id" = i64, Path, description = "Friend request ID"),
        ("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth")
    ),
    responses((status = 200, description = "Request accepted", body = FriendRequestResponse)),
    security(("uid_header" = []), ("bearer_jwt" = []), ("service_token_bearer" = []))
)]
async fn accept_friend_request(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Path(RequestIdPath { request_id }): Path<RequestIdPath>,
) -> Result<Json<FriendRequestResponse>, AppError> {
    let conn = &mut *conn;
    let uid = principal.require_user_action(conn, &state, AuthzAction::OnBehalfOfSocialWrite)?;
    let outcome = social::resolve_friend_request(conn, &state, uid, request_id, true).await?;
    let request = outcome.request();
    fire_ws(
        &state,
        &[request.from_uid],
        ServerWsMessage::FriendRequestResolved(FriendRequestResolvedPayload {
            request_id: request.id,
            status: FriendRequestStatus::Accepted,
            by_uid: uid,
        }),
    );
    let response = build_request_response(conn, &state, request)?;
    Ok(Json(response))
}

#[utoipa::path(
    post,
    path = "/requests/{request_id}/reject",
    tag = "friends",
    params(
        ("request_id" = i64, Path, description = "Friend request ID"),
        ("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth")
    ),
    responses(
        (status = 200, description = "Request rejected", body = FriendRequestResponse),
        (status = 409, description = "Already friends; the request was dismissed")
    ),
    security(("uid_header" = []), ("bearer_jwt" = []), ("service_token_bearer" = []))
)]
async fn reject_friend_request(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Path(RequestIdPath { request_id }): Path<RequestIdPath>,
) -> Result<Json<FriendRequestResponse>, AppError> {
    let conn = &mut *conn;
    let uid = principal.require_user_action(conn, &state, AuthzAction::OnBehalfOfSocialWrite)?;
    let outcome = social::resolve_friend_request(conn, &state, uid, request_id, false).await?;
    let request = outcome.request();
    fire_ws(
        &state,
        &[request.from_uid],
        ServerWsMessage::FriendRequestResolved(FriendRequestResolvedPayload {
            request_id: request.id,
            status: FriendRequestStatus::Rejected,
            by_uid: uid,
        }),
    );
    if matches!(&outcome, ResolveOutcome::RejectedWhileFriends(_)) {
        return Err(AppError::Conflict("You are already friends with this user"));
    }
    let response = build_request_response(conn, &state, request)?;
    Ok(Json(response))
}

#[utoipa::path(
    get,
    path = "/me/settings",
    tag = "friends",
    responses((status = 200, description = "Current user's friend-acceptance settings", body = FriendSettingsResponse)),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn get_my_friend_settings(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<Json<FriendSettingsResponse>, AppError> {
    let conn = &mut *conn;
    let (mode, question) = social::get_friend_settings(conn, uid)?;
    Ok(Json(FriendSettingsResponse { mode, question }))
}

#[utoipa::path(
    put,
    path = "/me/settings",
    tag = "friends",
    request_body = UpdateFriendSettingsBody,
    responses((status = 200, description = "Updated friend-acceptance settings", body = FriendSettingsResponse)),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn update_my_friend_settings(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
    Json(body): Json<UpdateFriendSettingsBody>,
) -> Result<Json<FriendSettingsResponse>, AppError> {
    validate_friend_verification_question(body.question.as_deref())?;
    let conn = &mut *conn;
    let (mode, question) = social::upsert_friend_settings(conn, uid, body.mode, body.question)?;
    Ok(Json(FriendSettingsResponse { mode, question }))
}

#[utoipa::path(
    get,
    path = "/add-info/{uid}",
    tag = "friends",
    params(
        ("uid" = i32, Path, description = "Target user uid"),
        ("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth")
    ),
    responses((status = 200, description = "What a requester needs to add this user as a friend", body = FriendAddInfoResponse)),
    security(("uid_header" = []), ("bearer_jwt" = []), ("service_token_bearer" = []))
)]
async fn get_user_friend_add_info(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Path(FriendPath { uid }): Path<FriendPath>,
) -> Result<Json<FriendAddInfoResponse>, AppError> {
    let conn = &mut *conn;
    let _uid = principal.require_user_action(conn, &state, AuthzAction::OnBehalfOfSocialRead)?;
    let (mode, question) = social::get_friend_settings(conn, uid)?;
    Ok(Json(FriendAddInfoResponse { mode, question }))
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(get_friends))
        .routes(routes!(delete_friend))
        .routes(routes!(create_friend_request))
        .routes(routes!(count_pending_incoming_requests))
        .routes(routes!(list_friend_request_history))
        .routes(routes!(accept_friend_request))
        .routes(routes!(reject_friend_request))
        .routes(routes!(get_my_friend_settings))
        .routes(routes!(update_my_friend_settings))
        .routes(routes!(get_user_friend_add_info))
}

#[cfg(test)]
mod tests {
    use super::{
        validate_friend_request_message, validate_friend_verification_question,
        MAX_FRIEND_REQUEST_MESSAGE_CHARS, MAX_FRIEND_VERIFICATION_QUESTION_CHARS,
    };
    use crate::errors::AppError;

    fn assert_character_limit(
        validator: fn(Option<&str>) -> Result<(), AppError>,
        max: usize,
        expected_error: &'static str,
    ) {
        let at_limit = "界".repeat(max);
        let over_limit = "界".repeat(max + 1);
        assert!(validator(Some(&at_limit)).is_ok());
        assert!(
            matches!(validator(Some(&over_limit)), Err(AppError::BadRequest(message)) if message == expected_error)
        );
    }

    #[test]
    fn friend_request_message_has_a_200_character_limit() {
        assert_character_limit(
            validate_friend_request_message,
            MAX_FRIEND_REQUEST_MESSAGE_CHARS,
            "Friend request message must not exceed 200 characters",
        );
    }

    #[test]
    fn friend_verification_question_has_a_100_character_limit() {
        assert_character_limit(
            validate_friend_verification_question,
            MAX_FRIEND_VERIFICATION_QUESTION_CHARS,
            "Friend verification question must not exceed 100 characters",
        );
    }
}
