use crate::dto::friends::{
    FriendAddInfoResponse, FriendPresenceSettingsResponse, FriendReadReceiptSettingsResponse,
    FriendRelationshipResponse, FriendRequestResponse, FriendSettingsResponse,
    ListFriendRequestHistoryResponse, ListFriendsResponse, PendingFriendRequestCountResponse,
};
use crate::dto::rpc::friends::{
    FriendsAcceptRequestParams, FriendsArchiveRequestParams, FriendsCreateRequestParams,
    FriendsGetAddInfoParams, FriendsGetPendingRequestCountParams, FriendsGetPresenceSettingsParams,
    FriendsGetReadReceiptSettingsParams, FriendsGetRelationshipParams, FriendsGetSettingsParams,
    FriendsListParams, FriendsListRequestsParams, FriendsRejectRequestParams, FriendsRemoveParams,
    FriendsUpdatePresenceSettingsParams, FriendsUpdateReadReceiptSettingsParams,
    FriendsUpdateSettingsParams,
};
use crate::errors::AppError;
use crate::rpc::{RpcCallContext, RpcServices};
use crate::services::api::friends::{
    self, AcceptFriendRequestDeps, CreateFriendRequestDeps, CreateFriendRequestResult,
    RejectFriendRequestDeps,
};

pub async fn list(
    context: &RpcCallContext,
    services: &RpcServices,
    _: FriendsListParams,
) -> Result<ListFriendsResponse, AppError> {
    let principal = context.principal()?;
    let mut conn = services.db.get()?;
    friends::get_friends(
        principal,
        &mut conn,
        services.authz_service.as_ref(),
        services.avatars.as_ref(),
    )
    .await
}

pub async fn get_relationship(
    context: &RpcCallContext,
    services: &RpcServices,
    params: FriendsGetRelationshipParams,
) -> Result<FriendRelationshipResponse, AppError> {
    let principal = context.principal()?;
    let mut conn = services.db.get()?;
    friends::get_friend_relationship(
        principal,
        params.uid,
        &mut conn,
        services.authz_service.as_ref(),
    )
    .await
}

pub async fn remove(
    context: &RpcCallContext,
    services: &RpcServices,
    params: FriendsRemoveParams,
) -> Result<(), AppError> {
    let principal = context.principal()?;
    let mut conn = services.db.get()?;
    friends::delete_friend(
        principal,
        params.uid,
        &mut conn,
        services.authz_service.as_ref(),
        services.presence_service.as_ref(),
        &services.ws_registry,
    )
    .await
}

pub async fn create_request(
    context: &RpcCallContext,
    services: &RpcServices,
    params: FriendsCreateRequestParams,
) -> Result<FriendRequestResponse, AppError> {
    let principal = context.principal()?;
    let mut conn = services.db.get()?;
    let result = friends::create_friend_request(
        principal,
        params.body,
        &mut conn,
        CreateFriendRequestDeps {
            authz_service: &services.authz_service,
            avatars: &services.avatars,
            id_gen: &services.id_gen,
            media: &services.media,
            metrics: &services.metrics,
            ws_registry: &services.ws_registry,
            presence_service: &services.presence_service,
            push_service: &services.push_service,
        },
    )
    .await?;
    Ok(match result {
        CreateFriendRequestResult::Created(response)
        | CreateFriendRequestResult::AutoAccepted(response) => response,
    })
}

pub async fn list_requests(
    context: &RpcCallContext,
    services: &RpcServices,
    params: FriendsListRequestsParams,
) -> Result<ListFriendRequestHistoryResponse, AppError> {
    let principal = context.principal()?;
    let mut conn = services.db.get()?;
    friends::list_friend_request_history(
        principal,
        params.query,
        &mut conn,
        services.authz_service.as_ref(),
        services.avatars.as_ref(),
    )
    .await
}

pub async fn get_pending_request_count(
    context: &RpcCallContext,
    services: &RpcServices,
    _: FriendsGetPendingRequestCountParams,
) -> Result<PendingFriendRequestCountResponse, AppError> {
    let principal = context.principal()?;
    let mut conn = services.db.get()?;
    friends::count_pending_incoming_requests(principal, &mut conn, services.authz_service.as_ref())
        .await
}

pub async fn accept_request(
    context: &RpcCallContext,
    services: &RpcServices,
    params: FriendsAcceptRequestParams,
) -> Result<FriendRequestResponse, AppError> {
    let principal = context.principal()?;
    let mut conn = services.db.get()?;
    friends::accept_friend_request(
        principal,
        params.request_id,
        &mut conn,
        AcceptFriendRequestDeps {
            authz_service: &services.authz_service,
            avatars: &services.avatars,
            id_gen: &services.id_gen,
            media: &services.media,
            metrics: &services.metrics,
            ws_registry: &services.ws_registry,
            presence_service: &services.presence_service,
            push_service: &services.push_service,
        },
    )
    .await
}

pub async fn reject_request(
    context: &RpcCallContext,
    services: &RpcServices,
    params: FriendsRejectRequestParams,
) -> Result<FriendRequestResponse, AppError> {
    let principal = context.principal()?;
    let mut conn = services.db.get()?;
    friends::reject_friend_request(
        principal,
        params.request_id,
        &mut conn,
        RejectFriendRequestDeps {
            authz_service: &services.authz_service,
            avatars: &services.avatars,
            id_gen: &services.id_gen,
            media: &services.media,
            metrics: &services.metrics,
            ws_registry: &services.ws_registry,
            presence_service: &services.presence_service,
            push_service: &services.push_service,
        },
    )
    .await
}

pub async fn archive_request(
    context: &RpcCallContext,
    services: &RpcServices,
    params: FriendsArchiveRequestParams,
) -> Result<(), AppError> {
    let principal = context.principal()?;
    let mut conn = services.db.get()?;
    friends::archive_friend_request(
        principal,
        params.request_id,
        &mut conn,
        services.authz_service.as_ref(),
    )
    .await
}

pub async fn get_settings(
    context: &RpcCallContext,
    services: &RpcServices,
    _: FriendsGetSettingsParams,
) -> Result<FriendSettingsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    friends::get_my_friend_settings(uid, &mut conn).await
}

pub async fn update_settings(
    context: &RpcCallContext,
    services: &RpcServices,
    params: FriendsUpdateSettingsParams,
) -> Result<FriendSettingsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    friends::update_my_friend_settings(uid, params.body, &mut conn).await
}

pub async fn get_add_info(
    context: &RpcCallContext,
    services: &RpcServices,
    params: FriendsGetAddInfoParams,
) -> Result<FriendAddInfoResponse, AppError> {
    let principal = context.principal()?;
    let mut conn = services.db.get()?;
    friends::get_user_friend_add_info(
        principal,
        params.uid,
        &mut conn,
        services.authz_service.as_ref(),
    )
    .await
}

pub async fn get_presence_settings(
    context: &RpcCallContext,
    services: &RpcServices,
    params: FriendsGetPresenceSettingsParams,
) -> Result<FriendPresenceSettingsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    friends::get_friend_presence_settings(uid, params.uid, &mut conn).await
}

pub async fn update_presence_settings(
    context: &RpcCallContext,
    services: &RpcServices,
    params: FriendsUpdatePresenceSettingsParams,
) -> Result<FriendPresenceSettingsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    friends::update_friend_presence_settings(
        uid,
        params.uid,
        params.body,
        &mut conn,
        services.presence_service.as_ref(),
    )
    .await
}

pub async fn get_read_receipt_settings(
    context: &RpcCallContext,
    services: &RpcServices,
    params: FriendsGetReadReceiptSettingsParams,
) -> Result<FriendReadReceiptSettingsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    friends::get_friend_read_receipt_settings(uid, params.uid, &mut conn).await
}

pub async fn update_read_receipt_settings(
    context: &RpcCallContext,
    services: &RpcServices,
    params: FriendsUpdateReadReceiptSettingsParams,
) -> Result<FriendReadReceiptSettingsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    friends::update_friend_read_receipt_settings(
        uid,
        params.uid,
        params.body,
        &mut conn,
        &services.ws_registry,
    )
    .await
}
