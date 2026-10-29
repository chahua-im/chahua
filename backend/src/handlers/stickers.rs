use axum::{
    extract::{Json, Multipart, Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json as AxumJson,
};
use utoipa_axum::router::OpenApiRouter;

use crate::dto::stickers::{
    CreateStickerFromMessageBody, CreateStickerPackBody, FavoriteStickerListResponse,
    PostStickerMultipart, StickerDetailResponse, StickerPackDetailResponse,
    StickerPackDiscoveryQuery, StickerPackDiscoveryResponse, StickerPackListResponse,
    StickerPackSummary, StickerSummary, UpdateStickerPackBody,
};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::services::api::stickers::{self, StickerUpload};
use crate::utils::auth::CurrentUid;
use crate::AppState;

use crate::services::stickers::creation::MAX_STICKER_UPLOAD_BYTES;

#[utoipa::path(get, path = "/packs", tag = "stickers", params(StickerPackDiscoveryQuery), responses((status = 200, description = "Public nonempty sticker packs", body = StickerPackDiscoveryResponse), (status = 400, description = "Invalid search or pagination parameters")), security(("bearer_jwt" = [])))]
async fn get_packs(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(query): Query<StickerPackDiscoveryQuery>,
) -> Result<AxumJson<StickerPackDiscoveryResponse>, AppError> {
    Ok(AxumJson(stickers::get_packs(
        uid,
        query,
        &mut conn,
        &state.media,
    )?))
}

#[utoipa::path(post, path = "/packs", tag = "stickers", request_body = CreateStickerPackBody, responses((status = 200, description = "Sticker pack created", body = StickerPackSummary)), security(("bearer_jwt" = [])))]
async fn post_pack(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<CreateStickerPackBody>,
) -> Result<AxumJson<StickerPackSummary>, AppError> {
    Ok(AxumJson(
        stickers::post_pack(
            uid,
            body,
            &mut conn,
            state.id_gen.as_ref(),
            &state.media,
            state.ws_registry.as_ref(),
        )
        .await?,
    ))
}

#[utoipa::path(patch, path = "/packs/{pack_id}", tag = "stickers", request_body = UpdateStickerPackBody, params(("pack_id" = String, Path, description = "Sticker pack ID")), responses((status = 200, description = "Sticker pack updated", body = StickerPackSummary)), security(("bearer_jwt" = [])))]
async fn patch_pack(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(pack_id): Path<i64>,
    mut conn: DbConn,
    Json(body): Json<UpdateStickerPackBody>,
) -> Result<AxumJson<StickerPackSummary>, AppError> {
    Ok(AxumJson(stickers::patch_pack(
        uid,
        pack_id,
        body,
        &mut conn,
        &state.media,
        state.ws_registry.as_ref(),
    )?))
}

#[utoipa::path(delete, path = "/packs/{pack_id}", tag = "stickers", params(("pack_id" = String, Path, description = "Sticker pack ID")), responses((status = 204, description = "Sticker pack deleted")), security(("bearer_jwt" = [])))]
async fn delete_pack(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(pack_id): Path<i64>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    stickers::delete_pack(uid, pack_id, &mut conn, state.ws_registry.as_ref())?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(get, path = "/packs/{pack_id}", tag = "stickers", params(("pack_id" = String, Path, description = "Sticker pack ID")), responses((status = 200, description = "Sticker pack details", body = StickerPackDetailResponse), (status = 404, description = "Sticker pack not found or private")), security(("bearer_jwt" = [])))]
async fn get_pack(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(pack_id): Path<i64>,
    mut conn: DbConn,
) -> Result<AxumJson<StickerPackDetailResponse>, AppError> {
    Ok(AxumJson(stickers::get_pack(
        uid,
        pack_id,
        &mut conn,
        &state.media,
    )?))
}

#[utoipa::path(get, path = "/packs/mine/subscribed", tag = "stickers", responses((status = 200, description = "Subscribed sticker packs", body = StickerPackListResponse)), security(("bearer_jwt" = [])))]
async fn get_my_subscribed_packs(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<AxumJson<StickerPackListResponse>, AppError> {
    Ok(AxumJson(stickers::get_my_subscribed_packs(
        uid,
        &mut conn,
        &state.media,
    )?))
}

#[utoipa::path(get, path = "/packs/mine/owned", tag = "stickers", responses((status = 200, description = "Owned sticker packs", body = StickerPackListResponse)), security(("bearer_jwt" = [])))]
async fn get_my_owned_packs(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<AxumJson<StickerPackListResponse>, AppError> {
    Ok(AxumJson(stickers::get_my_owned_packs(
        uid,
        &mut conn,
        &state.media,
    )?))
}

#[utoipa::path(put, path = "/packs/{pack_id}/subscription", tag = "stickers", params(("pack_id" = String, Path, description = "Sticker pack ID")), responses((status = 204, description = "Subscribed to sticker pack"), (status = 404, description = "Sticker pack not found or private")), security(("bearer_jwt" = [])))]
async fn put_subscription(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(pack_id): Path<i64>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    stickers::put_subscription(uid, pack_id, &mut conn, state.ws_registry.as_ref())?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(delete, path = "/packs/{pack_id}/subscription", tag = "stickers", params(("pack_id" = String, Path, description = "Sticker pack ID")), responses((status = 204, description = "Unsubscribed from sticker pack")), security(("bearer_jwt" = [])))]
async fn delete_subscription(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(pack_id): Path<i64>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    stickers::delete_subscription(uid, pack_id, &mut conn, state.ws_registry.as_ref())?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/packs/{pack_id}/stickers", tag = "stickers", params(("pack_id" = String, Path, description = "Sticker pack ID")), request_body(content = PostStickerMultipart, content_type = "multipart/form-data"), responses((status = 201, description = "Sticker created", body = StickerSummary)), security(("bearer_jwt" = [])))]
async fn post_pack_sticker(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(pack_id): Path<i64>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, AppError> {
    stickers::check_upload_pack_owner(uid, pack_id, &state.db).await?;
    let mut upload = StickerUpload {
        emoji: None,
        name: None,
        description: None,
        file_bytes: None,
        file_name: None,
        content_type: None,
    };
    while let Some(field) = multipart.next_field().await.map_err(|error| {
        tracing::error!("read sticker multipart field: {:?}", error);
        AppError::BadRequest("Invalid multipart request")
    })? {
        let field_name = field.name().unwrap_or_default().to_string();
        match field_name.as_str() {
            "emoji" => {
                upload.emoji = Some(
                    field
                        .text()
                        .await
                        .map_err(|_| AppError::BadRequest("Invalid emoji"))?,
                )
            }
            "name" => {
                upload.name = Some(
                    field
                        .text()
                        .await
                        .map_err(|_| AppError::BadRequest("Invalid name"))?,
                )
            }
            "description" => {
                upload.description = Some(
                    field
                        .text()
                        .await
                        .map_err(|_| AppError::BadRequest("Invalid description"))?,
                )
            }
            "file" => {
                upload.content_type = field.content_type().map(ToString::to_string);
                upload.file_name = field.file_name().map(ToString::to_string);
                let bytes = field.bytes().await.map_err(|error| {
                    tracing::error!("read sticker file bytes: {:?}", error);
                    AppError::BadRequest("Invalid sticker file")
                })?;
                if bytes.len() > MAX_STICKER_UPLOAD_BYTES {
                    return Err(AppError::BadRequest("Sticker file too large"));
                }
                upload.file_bytes = Some(bytes.to_vec());
            }
            _ => {}
        }
    }
    let summary = stickers::post_pack_sticker(
        uid,
        pack_id,
        upload,
        &state.db,
        &state.media,
        state.id_gen.as_ref(),
    )
    .await?;
    Ok((StatusCode::CREATED, AxumJson(summary)))
}

/// Copy the stored image into an owned pack. The source message is unchanged.
/// Each successful request creates a new sticker, as with a multipart upload.
#[utoipa::path(
    post,
    path = "/packs/{pack_id}/stickers/from-message",
    tag = "stickers",
    params(("pack_id" = String, Path, description = "Existing sticker pack owned by the current user")),
    request_body = CreateStickerFromMessageBody,
    responses(
        (status = 201, description = "Sticker created from the stored image", body = StickerSummary),
        (status = 400, description = "Message is not a single image without text, or sticker input is invalid or exceeds 10 MiB"),
        (status = 403, description = "Chat membership or sticker pack ownership required"),
        (status = 404, description = "Pack or published message not found"),
        (status = 409, description = "Source image changed during processing")
    ),
    security(("bearer_jwt" = []))
)]
async fn post_pack_sticker_from_message(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(pack_id): Path<i64>,
    Json(body): Json<CreateStickerFromMessageBody>,
) -> Result<impl IntoResponse, AppError> {
    let summary = stickers::post_pack_sticker_from_message(
        uid,
        pack_id,
        body,
        &state.db,
        &state.media,
        state.id_gen.as_ref(),
    )
    .await?;
    Ok((StatusCode::CREATED, AxumJson(summary)))
}

#[utoipa::path(put, path = "/packs/{pack_id}/stickers/{sticker_id}", tag = "stickers", params(("pack_id" = String, Path, description = "Sticker pack ID"), ("sticker_id" = String, Path, description = "Sticker ID")), responses((status = 204, description = "Sticker added to pack")), security(("bearer_jwt" = [])))]
async fn put_pack_sticker(
    CurrentUid(uid): CurrentUid,
    Path((pack_id, sticker_id)): Path<(i64, i64)>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    stickers::put_pack_sticker(uid, pack_id, sticker_id, &mut conn)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(delete, path = "/packs/{pack_id}/stickers/{sticker_id}", tag = "stickers", params(("pack_id" = String, Path, description = "Sticker pack ID"), ("sticker_id" = String, Path, description = "Sticker ID")), responses((status = 204, description = "Sticker removed from pack")), security(("bearer_jwt" = [])))]
async fn delete_pack_sticker(
    CurrentUid(uid): CurrentUid,
    Path((pack_id, sticker_id)): Path<(i64, i64)>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    stickers::delete_pack_sticker(uid, pack_id, sticker_id, &mut conn)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(get, path = "/{sticker_id}", tag = "stickers", params(("sticker_id" = String, Path, description = "Sticker ID")), responses((status = 200, description = "Sticker details", body = StickerDetailResponse)), security(("bearer_jwt" = [])))]
async fn get_sticker(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(sticker_id): Path<i64>,
    mut conn: DbConn,
) -> Result<AxumJson<StickerDetailResponse>, AppError> {
    Ok(AxumJson(stickers::get_sticker(
        uid,
        sticker_id,
        &mut conn,
        &state.media,
    )?))
}

#[utoipa::path(put, path = "/{sticker_id}/favorite", tag = "stickers", params(("sticker_id" = String, Path, description = "Sticker ID")), responses((status = 204, description = "Sticker favorited")), security(("bearer_jwt" = [])))]
async fn put_favorite(
    CurrentUid(uid): CurrentUid,
    Path(sticker_id): Path<i64>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    stickers::put_favorite(uid, sticker_id, &mut conn)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(delete, path = "/{sticker_id}/favorite", tag = "stickers", params(("sticker_id" = String, Path, description = "Sticker ID")), responses((status = 204, description = "Sticker unfavorited")), security(("bearer_jwt" = [])))]
async fn delete_favorite(
    CurrentUid(uid): CurrentUid,
    Path(sticker_id): Path<i64>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    stickers::delete_favorite(uid, sticker_id, &mut conn)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(get, path = "/mine/favorites", tag = "stickers", responses((status = 200, description = "Favorite stickers", body = FavoriteStickerListResponse)), security(("bearer_jwt" = [])))]
async fn get_my_favorites(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<AxumJson<FavoriteStickerListResponse>, AppError> {
    Ok(AxumJson(stickers::get_my_favorites(
        uid,
        &mut conn,
        &state.media,
    )?))
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(post_pack, get_packs))
        .routes(utoipa_axum::routes!(get_my_subscribed_packs))
        .routes(utoipa_axum::routes!(get_my_owned_packs))
        .routes(utoipa_axum::routes!(get_my_favorites))
        .routes(utoipa_axum::routes!(get_pack, patch_pack, delete_pack))
        .routes(utoipa_axum::routes!(put_subscription, delete_subscription))
        .routes(utoipa_axum::routes!(post_pack_sticker))
        .routes(utoipa_axum::routes!(post_pack_sticker_from_message))
        .routes(utoipa_axum::routes!(put_pack_sticker, delete_pack_sticker))
        .routes(utoipa_axum::routes!(get_sticker))
        .routes(utoipa_axum::routes!(put_favorite, delete_favorite))
        .layer(axum::extract::DefaultBodyLimit::max(
            MAX_STICKER_UPLOAD_BYTES,
        ))
}
