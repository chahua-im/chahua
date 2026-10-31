use crate::dto::rpc::stickers::*;
use crate::dto::stickers::{
    FavoriteStickerListResponse, StickerDetailResponse, StickerPackDetailResponse,
    StickerPackDiscoveryResponse, StickerPackListResponse, StickerPackSummary,
};
use crate::errors::AppError;
use crate::rpc::{RpcCallContext, RpcServices};
use crate::services::api::stickers;

pub async fn list_packs(
    context: &RpcCallContext,
    services: &RpcServices,
    params: StickersListPacksParams,
) -> Result<StickerPackDiscoveryResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::get_packs(uid, params.query, &mut conn, &services.media)
}

pub async fn create_pack(
    context: &RpcCallContext,
    services: &RpcServices,
    params: StickersCreatePackParams,
) -> Result<StickerPackSummary, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::post_pack(
        uid,
        params.body,
        &mut conn,
        services.id_gen.as_ref(),
        &services.media,
        services.ws_registry.as_ref(),
    )
    .await
}

pub async fn get_pack(
    context: &RpcCallContext,
    services: &RpcServices,
    params: StickersGetPackParams,
) -> Result<StickerPackDetailResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::get_pack(uid, params.pack_id, &mut conn, &services.media)
}

pub async fn update_pack(
    context: &RpcCallContext,
    services: &RpcServices,
    params: StickersUpdatePackParams,
) -> Result<StickerPackSummary, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::patch_pack(
        uid,
        params.pack_id,
        params.body,
        &mut conn,
        &services.media,
        services.ws_registry.as_ref(),
    )
}

pub async fn delete_pack(
    context: &RpcCallContext,
    services: &RpcServices,
    params: StickersDeletePackParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::delete_pack(
        uid,
        params.pack_id,
        &mut conn,
        services.ws_registry.as_ref(),
    )
}

pub async fn list_subscribed_packs(
    context: &RpcCallContext,
    services: &RpcServices,
    _: StickersListSubscribedPacksParams,
) -> Result<StickerPackListResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::get_my_subscribed_packs(uid, &mut conn, &services.media)
}

pub async fn list_owned_packs(
    context: &RpcCallContext,
    services: &RpcServices,
    _: StickersListOwnedPacksParams,
) -> Result<StickerPackListResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::get_my_owned_packs(uid, &mut conn, &services.media)
}

pub async fn subscribe_to_pack(
    context: &RpcCallContext,
    services: &RpcServices,
    params: StickersSubscribeToPackParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::put_subscription(
        uid,
        params.pack_id,
        &mut conn,
        services.ws_registry.as_ref(),
    )
}

pub async fn unsubscribe_from_pack(
    context: &RpcCallContext,
    services: &RpcServices,
    params: StickersUnsubscribeFromPackParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::delete_subscription(
        uid,
        params.pack_id,
        &mut conn,
        services.ws_registry.as_ref(),
    )
}

pub async fn add_to_pack(
    context: &RpcCallContext,
    services: &RpcServices,
    params: StickersAddToPackParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::put_pack_sticker(uid, params.pack_id, params.sticker_id, &mut conn)
}

pub async fn remove_from_pack(
    context: &RpcCallContext,
    services: &RpcServices,
    params: StickersRemoveFromPackParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::delete_pack_sticker(uid, params.pack_id, params.sticker_id, &mut conn)
}

pub async fn get(
    context: &RpcCallContext,
    services: &RpcServices,
    params: StickersGetParams,
) -> Result<StickerDetailResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::get_sticker(uid, params.sticker_id, &mut conn, &services.media)
}

pub async fn favorite(
    context: &RpcCallContext,
    services: &RpcServices,
    params: StickersFavoriteParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::put_favorite(uid, params.sticker_id, &mut conn)
}

pub async fn unfavorite(
    context: &RpcCallContext,
    services: &RpcServices,
    params: StickersUnfavoriteParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::delete_favorite(uid, params.sticker_id, &mut conn)
}

pub async fn list_favorites(
    context: &RpcCallContext,
    services: &RpcServices,
    _: StickersListFavoritesParams,
) -> Result<FavoriteStickerListResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::get_my_favorites(uid, &mut conn, &services.media)
}
