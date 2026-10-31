use axum::{
    extract::{Json, Path, Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::friends::{
    CreateFriendRequestBody, FriendAddInfoResponse, FriendPresenceSettingsResponse,
    FriendReadReceiptSettingsResponse, FriendRelationshipResponse, FriendRequestResponse,
    FriendSettingsResponse, ListFriendRequestHistoryResponse, ListFriendRequestsQuery,
    ListFriendsResponse, PendingFriendRequestCountResponse, PresenceSettingsResponse,
    PrivacyExceptionsQuery, PrivacyExceptionsResponse, ReadReceiptSettingsResponse,
    UpdateFriendPresenceSettingsBody, UpdateFriendReadReceiptSettingsBody,
    UpdateFriendSettingsBody, UpdatePresenceSettingsBody, UpdateReadReceiptSettingsBody,
};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::services::api::friends::{
    self, AcceptFriendRequestDeps, CreateFriendRequestDeps, CreateFriendRequestResult,
    RejectFriendRequestDeps,
};
use crate::services::authentication::Principal;
use crate::utils::auth::CurrentUid;
use crate::AppState;

#[derive(Deserialize)]
struct FriendPath {
    uid: i32,
}

#[derive(Deserialize)]
struct RequestIdPath {
    request_id: i64,
}

#[utoipa::path(
    get,
    path = "/",
    tag = "friends",
    responses((status = 200, description = "Current user's friends", body = ListFriendsResponse)),
    security(("bearer_jwt" = []), ("service_token_bearer" = [])),
    params(("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth"))
)]
async fn get_friends(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<Json<ListFriendsResponse>, AppError> {
    Ok(Json(
        friends::get_friends(
            principal,
            &mut conn,
            &state.authz_service,
            state.avatars.as_ref(),
        )
        .await?,
    ))
}

/// GET /friends/:uid — The current user's relationship with one profile user.
#[utoipa::path(
    get,
    path = "/{uid}",
    tag = "friends",
    params(
        ("uid" = i32, Path, description = "Profile user UID"),
        ("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth")
    ),
    responses((status = 200, description = "Relationship with the profile user", body = FriendRelationshipResponse)),
    security(("bearer_jwt" = []), ("service_token_bearer" = []))
)]
async fn get_friend_relationship(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Path(FriendPath { uid: peer_uid }): Path<FriendPath>,
) -> Result<Json<FriendRelationshipResponse>, AppError> {
    Ok(Json(
        friends::get_friend_relationship(principal, peer_uid, &mut conn, &state.authz_service)
            .await?,
    ))
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
    security(("bearer_jwt" = []), ("service_token_bearer" = []))
)]
async fn delete_friend(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Path(FriendPath { uid: other }): Path<FriendPath>,
) -> Result<StatusCode, AppError> {
    friends::delete_friend(
        principal,
        other,
        &mut conn,
        &state.authz_service,
        state.presence_service.as_ref(),
        &state.ws_registry,
    )
    .await?;
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
    security(("bearer_jwt" = []), ("service_token_bearer" = [])),
    params(("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth"))
)]
async fn create_friend_request(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<CreateFriendRequestBody>,
) -> Result<(StatusCode, Json<FriendRequestResponse>), AppError> {
    match friends::create_friend_request(
        principal,
        body,
        &mut conn,
        CreateFriendRequestDeps {
            authz_service: &state.authz_service,
            avatars: &state.avatars,
            id_gen: &state.id_gen,
            media: &state.media,
            metrics: &state.metrics,
            ws_registry: &state.ws_registry,
            presence_service: &state.presence_service,
            push_service: &state.push_service,
        },
    )
    .await?
    {
        CreateFriendRequestResult::Created(response) => Ok((StatusCode::CREATED, Json(response))),
        CreateFriendRequestResult::AutoAccepted(response) => Ok((StatusCode::OK, Json(response))),
    }
}

#[utoipa::path(
    get,
    path = "/requests/pending/count",
    tag = "friends",
    responses((status = 200, description = "Number of pending incoming friend requests", body = PendingFriendRequestCountResponse)),
    security(("bearer_jwt" = []), ("service_token_bearer" = [])),
    params(("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth"))
)]
async fn count_pending_incoming_requests(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<Json<PendingFriendRequestCountResponse>, AppError> {
    Ok(Json(
        friends::count_pending_incoming_requests(principal, &mut conn, &state.authz_service)
            .await?,
    ))
}

#[utoipa::path(
    get,
    path = "/requests",
    tag = "friends",
    responses((status = 200, description = "Friend requests in the selected archive view, newest first", body = ListFriendRequestHistoryResponse)),
    security(("bearer_jwt" = []), ("service_token_bearer" = [])),
    params(
        ("archived" = Option<bool>, Query, description = "False returns active incoming requests; true returns outgoing and archived or resolved incoming requests; omit for all"),
        ("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth")
    )
)]
async fn list_friend_request_history(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(query): Query<ListFriendRequestsQuery>,
) -> Result<Json<ListFriendRequestHistoryResponse>, AppError> {
    Ok(Json(
        friends::list_friend_request_history(
            principal,
            query,
            &mut conn,
            &state.authz_service,
            state.avatars.as_ref(),
        )
        .await?,
    ))
}

#[utoipa::path(
    post,
    path = "/requests/{request_id}/accept",
    tag = "friends",
    params(
        ("request_id" = String, Path, description = "Friend request ID"),
        ("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth")
    ),
    responses((status = 200, description = "Request accepted", body = FriendRequestResponse)),
    security(("bearer_jwt" = []), ("service_token_bearer" = []))
)]
async fn accept_friend_request(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Path(RequestIdPath { request_id }): Path<RequestIdPath>,
) -> Result<Json<FriendRequestResponse>, AppError> {
    Ok(Json(
        friends::accept_friend_request(
            principal,
            request_id,
            &mut conn,
            AcceptFriendRequestDeps {
                authz_service: &state.authz_service,
                avatars: &state.avatars,
                id_gen: &state.id_gen,
                media: &state.media,
                metrics: &state.metrics,
                ws_registry: &state.ws_registry,
                presence_service: &state.presence_service,
                push_service: &state.push_service,
            },
        )
        .await?,
    ))
}

#[utoipa::path(
    post,
    path = "/requests/{request_id}/reject",
    tag = "friends",
    params(
        ("request_id" = String, Path, description = "Friend request ID"),
        ("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth")
    ),
    responses(
        (status = 200, description = "Request rejected", body = FriendRequestResponse),
        (status = 409, description = "Already friends; the request was dismissed")
    ),
    security(("bearer_jwt" = []), ("service_token_bearer" = []))
)]
async fn reject_friend_request(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Path(RequestIdPath { request_id }): Path<RequestIdPath>,
) -> Result<Json<FriendRequestResponse>, AppError> {
    Ok(Json(
        friends::reject_friend_request(
            principal,
            request_id,
            &mut conn,
            RejectFriendRequestDeps {
                authz_service: &state.authz_service,
                avatars: &state.avatars,
                id_gen: &state.id_gen,
                media: &state.media,
                metrics: &state.metrics,
                ws_registry: &state.ws_registry,
                presence_service: &state.presence_service,
                push_service: &state.push_service,
            },
        )
        .await?,
    ))
}

#[utoipa::path(
    put,
    path = "/requests/{request_id}/archive",
    tag = "friends",
    params(
        ("request_id" = String, Path, description = "Friend request ID"),
        ("X-On-Behalf-Of" = Option<i32>, Header, description = "Acting user UID; required with a service token, forbidden with user auth")
    ),
    responses((status = 204, description = "Request archived")),
    security(("bearer_jwt" = []), ("service_token_bearer" = []))
)]
async fn archive_friend_request(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Path(RequestIdPath { request_id }): Path<RequestIdPath>,
) -> Result<StatusCode, AppError> {
    friends::archive_friend_request(principal, request_id, &mut conn, &state.authz_service).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/me/settings",
    tag = "friends",
    responses((status = 200, description = "Current user's friend-acceptance settings", body = FriendSettingsResponse)),
    security(("bearer_jwt" = []))
)]
async fn get_my_friend_settings(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<Json<FriendSettingsResponse>, AppError> {
    Ok(Json(friends::get_my_friend_settings(uid, &mut conn).await?))
}

#[utoipa::path(
    put,
    path = "/me/settings",
    tag = "friends",
    request_body = UpdateFriendSettingsBody,
    responses((status = 200, description = "Updated friend-acceptance settings", body = FriendSettingsResponse)),
    security(("bearer_jwt" = []))
)]
async fn update_my_friend_settings(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
    Json(body): Json<UpdateFriendSettingsBody>,
) -> Result<Json<FriendSettingsResponse>, AppError> {
    Ok(Json(
        friends::update_my_friend_settings(uid, body, &mut conn).await?,
    ))
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
    security(("bearer_jwt" = []), ("service_token_bearer" = []))
)]
async fn get_user_friend_add_info(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Path(FriendPath { uid }): Path<FriendPath>,
) -> Result<Json<FriendAddInfoResponse>, AppError> {
    Ok(Json(
        friends::get_user_friend_add_info(principal, uid, &mut conn, &state.authz_service).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/me/presence-settings",
    operation_id = "get_my_presence_settings",
    tag = "friends",
    responses((status = 200, description = "Current user's global presence policy", body = PresenceSettingsResponse)),
    security(("bearer_jwt" = []))
)]
async fn get_my_presence_settings(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<Json<PresenceSettingsResponse>, AppError> {
    Ok(Json(
        friends::get_my_presence_settings(uid, &mut conn).await?,
    ))
}

#[utoipa::path(
    put,
    path = "/me/presence-settings",
    operation_id = "update_my_presence_settings",
    tag = "friends",
    request_body = UpdatePresenceSettingsBody,
    responses((status = 200, description = "Updated global presence policy", body = PresenceSettingsResponse)),
    security(("bearer_jwt" = []))
)]
async fn update_my_presence_settings(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<UpdatePresenceSettingsBody>,
) -> Result<Json<PresenceSettingsResponse>, AppError> {
    Ok(Json(
        friends::update_my_presence_settings(uid, body, &mut conn, state.presence_service.as_ref())
            .await?,
    ))
}

#[utoipa::path(
    get,
    path = "/me/read-receipt-settings",
    operation_id = "get_my_read_receipt_settings",
    tag = "friends",
    responses((status = 200, description = "Current user's global read-receipt policy", body = ReadReceiptSettingsResponse)),
    security(("bearer_jwt" = []))
)]
async fn get_my_read_receipt_settings(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
) -> Result<Json<ReadReceiptSettingsResponse>, AppError> {
    Ok(Json(
        friends::get_my_read_receipt_settings(uid, &mut conn).await?,
    ))
}

#[utoipa::path(
    put,
    path = "/me/read-receipt-settings",
    operation_id = "update_my_read_receipt_settings",
    tag = "friends",
    request_body = UpdateReadReceiptSettingsBody,
    responses((status = 200, description = "Updated global read-receipt policy", body = ReadReceiptSettingsResponse)),
    security(("bearer_jwt" = []))
)]
async fn update_my_read_receipt_settings(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<UpdateReadReceiptSettingsBody>,
) -> Result<Json<ReadReceiptSettingsResponse>, AppError> {
    Ok(Json(
        friends::update_my_read_receipt_settings(uid, body, &mut conn, &state.ws_registry).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/{uid}/presence-settings",
    operation_id = "get_friend_presence_settings",
    tag = "friends",
    params(("uid" = i32, Path, description = "Current friend UID")),
    responses(
        (status = 200, description = "Current user's presence override for this friend", body = FriendPresenceSettingsResponse),
        (status = 404, description = "Friendship not found")
    ),
    security(("bearer_jwt" = []))
)]
async fn get_friend_presence_settings(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
    Path(FriendPath { uid: peer_uid }): Path<FriendPath>,
) -> Result<Json<FriendPresenceSettingsResponse>, AppError> {
    Ok(Json(
        friends::get_friend_presence_settings(uid, peer_uid, &mut conn).await?,
    ))
}

#[utoipa::path(
    put,
    path = "/{uid}/presence-settings",
    operation_id = "update_friend_presence_settings",
    tag = "friends",
    params(("uid" = i32, Path, description = "Current friend UID")),
    request_body = UpdateFriendPresenceSettingsBody,
    responses(
        (status = 200, description = "Updated presence override", body = FriendPresenceSettingsResponse),
        (status = 404, description = "Friendship not found")
    ),
    security(("bearer_jwt" = []))
)]
async fn update_friend_presence_settings(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Path(FriendPath { uid: peer_uid }): Path<FriendPath>,
    Json(body): Json<UpdateFriendPresenceSettingsBody>,
) -> Result<Json<FriendPresenceSettingsResponse>, AppError> {
    Ok(Json(
        friends::update_friend_presence_settings(
            uid,
            peer_uid,
            body,
            &mut conn,
            state.presence_service.as_ref(),
        )
        .await?,
    ))
}

#[utoipa::path(
    get,
    path = "/{uid}/read-receipt-settings",
    operation_id = "get_friend_read_receipt_settings",
    tag = "friends",
    params(("uid" = i32, Path, description = "Current friend UID")),
    responses(
        (status = 200, description = "Current user's read-receipt override for this friend", body = FriendReadReceiptSettingsResponse),
        (status = 404, description = "Friendship not found")
    ),
    security(("bearer_jwt" = []))
)]
async fn get_friend_read_receipt_settings(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
    Path(FriendPath { uid: peer_uid }): Path<FriendPath>,
) -> Result<Json<FriendReadReceiptSettingsResponse>, AppError> {
    Ok(Json(
        friends::get_friend_read_receipt_settings(uid, peer_uid, &mut conn).await?,
    ))
}

#[utoipa::path(
    put,
    path = "/{uid}/read-receipt-settings",
    operation_id = "update_friend_read_receipt_settings",
    tag = "friends",
    params(("uid" = i32, Path, description = "Current friend UID")),
    request_body = UpdateFriendReadReceiptSettingsBody,
    responses(
        (status = 200, description = "Updated read-receipt override", body = FriendReadReceiptSettingsResponse),
        (status = 404, description = "Friendship not found")
    ),
    security(("bearer_jwt" = []))
)]
async fn update_friend_read_receipt_settings(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Path(FriendPath { uid: peer_uid }): Path<FriendPath>,
    Json(body): Json<UpdateFriendReadReceiptSettingsBody>,
) -> Result<Json<FriendReadReceiptSettingsResponse>, AppError> {
    Ok(Json(
        friends::update_friend_read_receipt_settings(
            uid,
            peer_uid,
            body,
            &mut conn,
            &state.ws_registry,
        )
        .await?,
    ))
}

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(get_friends))
        .routes(routes!(get_friend_relationship))
        .routes(routes!(get_friend_presence_settings))
        .routes(routes!(update_friend_presence_settings))
        .routes(routes!(get_friend_read_receipt_settings))
        .routes(routes!(update_friend_read_receipt_settings))
        .routes(routes!(delete_friend))
        .routes(routes!(create_friend_request))
        .routes(routes!(count_pending_incoming_requests))
        .routes(routes!(list_friend_request_history))
        .routes(routes!(accept_friend_request))
        .routes(routes!(reject_friend_request))
        .routes(routes!(archive_friend_request))
        .routes(routes!(get_my_friend_settings))
        .routes(routes!(update_my_friend_settings))
        .routes(routes!(get_user_friend_add_info))
}

#[utoipa::path(
    get, path = "/me/privacy-exceptions", operation_id = "get_privacy_exceptions", tag = "friends",
    params(PrivacyExceptionsQuery),
    responses((status = 200, description = "Caller-owned overrides for current friends", body = PrivacyExceptionsResponse)),
    security(("bearer_jwt" = []))
)]
async fn get_privacy_exceptions(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(query): Query<PrivacyExceptionsQuery>,
) -> Result<Json<PrivacyExceptionsResponse>, AppError> {
    Ok(Json(
        friends::get_privacy_exceptions(uid, query.kind, &mut conn, state.avatars.as_ref()).await?,
    ))
}

#[utoipa::path(
    delete, path = "/me/privacy-exceptions", operation_id = "clear_privacy_exceptions", tag = "friends",
    params(PrivacyExceptionsQuery),
    responses((status = 204, description = "Restored caller-owned overrides to the global policy")),
    security(("bearer_jwt" = []))
)]
async fn clear_privacy_exceptions(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(query): Query<PrivacyExceptionsQuery>,
) -> Result<StatusCode, AppError> {
    friends::clear_privacy_exceptions(
        uid,
        query.kind,
        &mut conn,
        state.presence_service.as_ref(),
        &state.ws_registry,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn presence_settings_router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(get_privacy_exceptions))
        .routes(routes!(clear_privacy_exceptions))
        .routes(routes!(get_my_presence_settings))
        .routes(routes!(update_my_presence_settings))
        .routes(routes!(get_my_read_receipt_settings))
        .routes(routes!(update_my_read_receipt_settings))
}
