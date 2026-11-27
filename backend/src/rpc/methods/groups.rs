use crate::dto::rpc::groups::{
    GroupsAddMemberParams, GroupsCreateAvatarUploadUrlParams, GroupsCreateParams, GroupsGetParams,
    GroupsListMembersParams, GroupsListParams, GroupsMuteParams, GroupsRemoveMemberParams,
    GroupsUnmuteParams, GroupsUpdateMemberParams, GroupsUpdateMemberSpeakingModeParams,
    GroupsUpdateNotificationSettingParams, GroupsUpdateParams, GroupsUpdateSpeakingModeParams,
};
use crate::dto::{
    groups::{
        AvatarUploadUrlResponse, ChatNotificationSettingResponse, CreateChatResponse,
        GroupInfoResponse, ListGroupsResponse, MuteResponse,
    },
    members::{ListMembersResponse, MemberResponse},
    speaking::{GroupSpeakingModeResponse, MemberSpeakingModeResponse},
};
use crate::errors::AppError;
use crate::rpc::{AppState, RpcCallContext};
use crate::services::api::groups;

pub async fn list(
    context: &RpcCallContext,
    services: &AppState,
    params: GroupsListParams,
) -> Result<ListGroupsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    groups::get_groups(uid, params.query, &mut conn, &services.media).await
}

pub async fn create(
    context: &RpcCallContext,
    services: &AppState,
    params: GroupsCreateParams,
) -> Result<CreateChatResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    groups::post_group(
        uid,
        params.body,
        &mut conn,
        &services.authz_service,
        &services.id_gen,
        &services.ws_registry,
    )
    .await
}

pub async fn get(
    context: &RpcCallContext,
    services: &AppState,
    params: GroupsGetParams,
) -> Result<GroupInfoResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    groups::get_group(
        uid,
        params.chat_id,
        &mut conn,
        &services.media,
        services.avatars.as_ref(),
    )
    .await
}

pub async fn update(
    context: &RpcCallContext,
    services: &AppState,
    params: GroupsUpdateParams,
) -> Result<GroupInfoResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    groups::patch_group(
        uid,
        params.chat_id,
        params.body,
        &mut conn,
        &services.media,
        services.avatars.as_ref(),
        services.ws_registry.as_ref(),
    )
    .await
}

pub async fn create_avatar_upload_url(
    context: &RpcCallContext,
    services: &AppState,
    params: GroupsCreateAvatarUploadUrlParams,
) -> Result<AvatarUploadUrlResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    groups::post_avatar_upload_url(
        uid,
        params.chat_id,
        params.body,
        &mut conn,
        &services.id_gen,
        &services.media,
    )
    .await
}

pub async fn mute(
    context: &RpcCallContext,
    services: &AppState,
    params: GroupsMuteParams,
) -> Result<MuteResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    groups::put_mute(
        uid,
        params.chat_id,
        params.body,
        &mut conn,
        services.ws_registry.as_ref(),
    )
    .await
}

pub async fn unmute(
    context: &RpcCallContext,
    services: &AppState,
    params: GroupsUnmuteParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    groups::delete_mute(
        uid,
        params.chat_id,
        &mut conn,
        services.ws_registry.as_ref(),
    )
    .await
}

pub async fn update_notification_setting(
    context: &RpcCallContext,
    services: &AppState,
    params: GroupsUpdateNotificationSettingParams,
) -> Result<ChatNotificationSettingResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    groups::put_notification_setting(
        uid,
        params.chat_id,
        params.body,
        &mut conn,
        services.ws_registry.as_ref(),
    )
    .await
}

pub async fn update_speaking_mode(
    context: &RpcCallContext,
    services: &AppState,
    params: GroupsUpdateSpeakingModeParams,
) -> Result<GroupSpeakingModeResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    groups::put_speaking_mode(
        uid,
        params.chat_id,
        params.body,
        &mut conn,
        services.ws_registry.as_ref(),
    )
    .await
}

pub async fn list_members(
    context: &RpcCallContext,
    services: &AppState,
    params: GroupsListMembersParams,
) -> Result<ListMembersResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .members
        .get_members(uid, params.chat_id, params.query, &mut conn)
}

pub async fn add_member(
    context: &RpcCallContext,
    services: &AppState,
    params: GroupsAddMemberParams,
) -> Result<MemberResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .members
        .post_add_member(uid, params.chat_id, params.body, &mut conn)
        .await
}

pub async fn remove_member(
    context: &RpcCallContext,
    services: &AppState,
    params: GroupsRemoveMemberParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .members
        .delete_remove_member(uid, params.chat_id, params.uid, params.query, &mut conn)
        .await
}

pub async fn update_member(
    context: &RpcCallContext,
    services: &AppState,
    params: GroupsUpdateMemberParams,
) -> Result<MemberResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services
        .members
        .patch_member(uid, params.chat_id, params.uid, params.body, &mut conn)
}

pub async fn update_member_speaking_mode(
    context: &RpcCallContext,
    services: &AppState,
    params: GroupsUpdateMemberSpeakingModeParams,
) -> Result<MemberSpeakingModeResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    services.members.put_member_speaking_mode(
        uid,
        params.chat_id,
        params.uid,
        params.body,
        &mut conn,
    )
}
