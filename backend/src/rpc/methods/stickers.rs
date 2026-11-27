use crate::dto::rpc::stickers::*;
use crate::dto::stickers::{
    FavoriteStickerListResponse, StickerDetailResponse, StickerPackDetailResponse,
    StickerPackDiscoveryResponse, StickerPackListResponse, StickerPackSummary,
};
use crate::errors::AppError;
use crate::rpc::{AppState, RpcCallContext};
use crate::services::api::stickers;

pub async fn list_packs(
    context: &RpcCallContext,
    services: &AppState,
    params: StickersListPacksParams,
) -> Result<StickerPackDiscoveryResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::get_packs(uid, params.query, &mut conn, &services.media)
}

pub async fn create_pack(
    context: &RpcCallContext,
    services: &AppState,
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
    services: &AppState,
    params: StickersGetPackParams,
) -> Result<StickerPackDetailResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::get_pack(uid, params.pack_id, &mut conn, &services.media)
}

pub async fn update_pack(
    context: &RpcCallContext,
    services: &AppState,
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
    services: &AppState,
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
    services: &AppState,
    _: StickersListSubscribedPacksParams,
) -> Result<StickerPackListResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::get_my_subscribed_packs(uid, &mut conn, &services.media)
}

pub async fn list_owned_packs(
    context: &RpcCallContext,
    services: &AppState,
    _: StickersListOwnedPacksParams,
) -> Result<StickerPackListResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::get_my_owned_packs(uid, &mut conn, &services.media)
}

pub async fn subscribe_to_pack(
    context: &RpcCallContext,
    services: &AppState,
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
    services: &AppState,
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
    services: &AppState,
    params: StickersAddToPackParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::put_pack_sticker(uid, params.pack_id, params.sticker_id, &mut conn)
}

pub async fn remove_from_pack(
    context: &RpcCallContext,
    services: &AppState,
    params: StickersRemoveFromPackParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::delete_pack_sticker(uid, params.pack_id, params.sticker_id, &mut conn)
}

pub async fn get(
    context: &RpcCallContext,
    services: &AppState,
    params: StickersGetParams,
) -> Result<StickerDetailResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::get_sticker(uid, params.sticker_id, &mut conn, &services.media)
}

pub async fn favorite(
    context: &RpcCallContext,
    services: &AppState,
    params: StickersFavoriteParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::put_favorite(uid, params.sticker_id, &mut conn)
}

pub async fn unfavorite(
    context: &RpcCallContext,
    services: &AppState,
    params: StickersUnfavoriteParams,
) -> Result<(), AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::delete_favorite(uid, params.sticker_id, &mut conn)
}

pub async fn list_favorites(
    context: &RpcCallContext,
    services: &AppState,
    _: StickersListFavoritesParams,
) -> Result<FavoriteStickerListResponse, AppError> {
    let uid = context.uid()?;
    let mut conn = services.db.get()?;
    stickers::get_my_favorites(uid, &mut conn, &services.media)
}

pub async fn create_from_message(
    context: &RpcCallContext,
    services: &AppState,
    params: StickersCreateFromMessageParams,
) -> Result<crate::dto::stickers::StickerSummary, AppError> {
    stickers::post_pack_sticker_from_message(
        context.uid()?,
        params.pack_id,
        params.body,
        &services.db,
        &services.media,
        services.id_gen.as_ref(),
    )
    .await
}
