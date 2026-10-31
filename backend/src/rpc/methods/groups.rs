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
use crate::rpc::{RpcCallContext, RpcServices};
use crate::services::api::{groups, members};

pub async fn list(
    context: &RpcCallContext,
    services: &RpcServices,
    params: GroupsListParams,
) -> Result<ListGroupsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    groups::get_groups(uid, params.query, &mut conn, &services.media).await
}

pub async fn create(
    context: &RpcCallContext,
    services: &RpcServices,
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
    )
    .await
}

pub async fn get(
    context: &RpcCallContext,
    services: &RpcServices,
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
    services: &RpcServices,
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
    services: &RpcServices,
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
    services: &RpcServices,
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
    services: &RpcServices,
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
    services: &RpcServices,
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
    services: &RpcServices,
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
    services: &RpcServices,
    params: GroupsListMembersParams,
) -> Result<ListMembersResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    members::get_members(
        uid,
        params.chat_id,
        params.query,
        &mut conn,
        &services.avatars,
    )
}

pub async fn add_member(
    context: &RpcCallContext,
    services: &RpcServices,
    params: GroupsAddMemberParams,
) -> Result<MemberResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    members::post_add_member(
        uid,
        params.chat_id,
        params.body,
        &mut conn,
        members::PostAddMemberDeps {
            id_gen: &services.id_gen,
            media: &services.media,
            avatars: &services.avatars,
            metrics: &services.metrics,
            ws_registry: &services.ws_registry,
            push_service: &services.push_service,
        },
    )
    .await
}

pub async fn remove_member(
    context: &RpcCallContext,
    services: &RpcServices,
    params: GroupsRemoveMemberParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    members::delete_remove_member(
        uid,
        params.chat_id,
        params.uid,
        params.query,
        &mut conn,
        members::DeleteRemoveMemberDeps {
            id_gen: &services.id_gen,
            media: &services.media,
            avatars: &services.avatars,
            metrics: &services.metrics,
            ws_registry: &services.ws_registry,
            push_service: &services.push_service,
            background_service: &services.background_service,
        },
    )
    .await
}

pub async fn update_member(
    context: &RpcCallContext,
    services: &RpcServices,
    params: GroupsUpdateMemberParams,
) -> Result<MemberResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    members::patch_member(
        uid,
        params.chat_id,
        params.uid,
        params.body,
        &mut conn,
        &services.avatars,
        &services.ws_registry,
    )
}

pub async fn update_member_speaking_mode(
    context: &RpcCallContext,
    services: &RpcServices,
    params: GroupsUpdateMemberSpeakingModeParams,
) -> Result<MemberSpeakingModeResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    members::put_member_speaking_mode(
        uid,
        params.chat_id,
        params.uid,
        params.body,
        &mut conn,
        &services.ws_registry,
    )
}
