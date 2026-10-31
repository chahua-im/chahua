use crate::dto::attachments::{
    AttachmentConfigResponse, ListChatAttachmentsResponse, UploadUrlResponse,
};
use crate::dto::rpc::attachments::*;
use crate::errors::AppError;
use crate::rpc::{RpcCallContext, RpcServices};

pub async fn list_for_chat(
    context: &RpcCallContext,
    services: &RpcServices,
    params: AttachmentsListForChatParams,
) -> Result<ListChatAttachmentsResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::chats::chat_attachments::get_chat_attachments(
        uid,
        params.chat_id,
        params.query,
        &mut conn,
        &services.media,
        services.avatars.as_ref(),
    )
}

pub async fn create_upload_url(
    context: &RpcCallContext,
    services: &RpcServices,
    params: AttachmentsCreateUploadUrlParams,
) -> Result<UploadUrlResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    crate::services::api::attachments::post_upload_url(
        uid,
        params.body,
        &mut conn,
        services.id_gen.as_ref(),
        &services.media,
        services.config.media.max_attachment_file_size_bytes,
    )
    .await
}

pub async fn get_config(
    context: &RpcCallContext,
    services: &RpcServices,
    _params: AttachmentsGetConfigParams,
) -> Result<AttachmentConfigResponse, AppError> {
    Ok(crate::services::api::attachments::get_config(
        context.uid()?,
        services.config.media.max_attachment_file_size_bytes,
    ))
}
