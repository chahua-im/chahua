use aws_sdk_s3::primitives::ByteStream;
use axum::{
    extract::{Json, Multipart, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json as AxumJson,
};
use chrono::Utc;
use diesel::prelude::*;
use diesel::PgConnection;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use utoipa_axum::router::OpenApiRouter;

use crate::dto::stickers::{
    FavoriteStickerListResponse, StickerDetailResponse, StickerMediaResponse,
    StickerPackDetailResponse, StickerPackListResponse, StickerPackPreviewSticker,
    StickerPackSummary, StickerSummary,
};
use crate::dto::users::StickerPackOrderItem;
use crate::dto::ws::{ServerWsMessage, StickerPackOrderUpdatePayload};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::{
    models::{
        Media, MediaPurpose, NewMedia, NewSticker, NewStickerPack, Sticker, StickerPack,
        StickerPackSticker, UpdateStickerPack, UserFavoriteSticker, UserStickerPackSubscription,
    },
    schema::{
        media, sticker_pack_stickers, sticker_packs, stickers, user_favorite_stickers,
        user_sticker_pack_subscriptions,
    },
    services::{image_processing::process_sticker, media::build_storage_key},
    utils::{auth::CurrentUid, ids},
    AppState,
};

const MAX_STICKER_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
const STICKER_STORAGE_PREFIX: &str = "stickers";
const MAX_STICKER_EMOJI_GRAPHEMES: usize = 4;

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct CreateStickerPackBody {
    name: String,
    description: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct UpdateStickerPackBody {
    name: Option<String>,
    description: Option<String>,
}

fn normalize_required_name(input: &str) -> Result<String, AppError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("Name is required"));
    }
    Ok(trimmed.to_string())
}

fn validate_sticker_emoji(input: &str) -> Result<String, AppError> {
    use unicode_segmentation::UnicodeSegmentation;

    if input.is_empty() {
        return Err(AppError::BadRequest("Invalid emoji"));
    }

    let graphemes: Vec<&str> = input.graphemes(true).collect();

    if graphemes.len() > MAX_STICKER_EMOJI_GRAPHEMES {
        return Err(AppError::BadRequest("Too many emoji"));
    }

    if !graphemes.iter().all(|g| emojis::get(g).is_some()) {
        return Err(AppError::BadRequest("Invalid emoji"));
    }

    Ok(input.to_string())
}

fn is_allowed_sticker_content_type(content_type: &str) -> bool {
    content_type.starts_with("image/") || content_type == "video/webm"
}

fn media_response(state: &AppState, media_row: &Media) -> StickerMediaResponse {
    StickerMediaResponse {
        id: media_row.id,
        url: state.media.public_url(&media_row.storage_key),
        content_type: media_row.content_type.clone(),
        size: media_row.size,
        width: media_row.width,
        height: media_row.height,
    }
}

fn require_pack_owner(
    conn: &mut PgConnection,
    pack_id: i64,
    uid: i32,
) -> Result<StickerPack, AppError> {
    let pack: StickerPack = sticker_packs::table
        .filter(sticker_packs::id.eq(pack_id))
        .select(StickerPack::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Sticker pack not found"))?;

    if pack.owner_uid != uid {
        return Err(AppError::Forbidden("Sticker pack owner required"));
    }

    Ok(pack)
}

fn load_pack_counts(conn: &mut PgConnection, pack_ids: &[i64]) -> QueryResult<HashMap<i64, i64>> {
    if pack_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows: Vec<(i64, i64)> = sticker_pack_stickers::table
        .filter(sticker_pack_stickers::pack_id.eq_any(pack_ids))
        .group_by(sticker_pack_stickers::pack_id)
        .select((sticker_pack_stickers::pack_id, diesel::dsl::count_star()))
        .load(conn)?;

    Ok(rows.into_iter().collect())
}

fn load_subscribed_pack_ids(
    conn: &mut PgConnection,
    uid: i32,
    pack_ids: &[i64],
) -> QueryResult<HashSet<i64>> {
    if pack_ids.is_empty() {
        return Ok(HashSet::new());
    }

    let rows: Vec<i64> = user_sticker_pack_subscriptions::table
        .filter(user_sticker_pack_subscriptions::uid.eq(uid))
        .filter(user_sticker_pack_subscriptions::pack_id.eq_any(pack_ids))
        .select(user_sticker_pack_subscriptions::pack_id)
        .load(conn)?;

    Ok(rows.into_iter().collect())
}

fn load_favorited_sticker_ids(
    conn: &mut PgConnection,
    uid: i32,
    sticker_ids: &[i64],
) -> QueryResult<HashSet<i64>> {
    if sticker_ids.is_empty() {
        return Ok(HashSet::new());
    }

    let rows: Vec<i64> = user_favorite_stickers::table
        .filter(user_favorite_stickers::uid.eq(uid))
        .filter(user_favorite_stickers::sticker_id.eq_any(sticker_ids))
        .select(user_favorite_stickers::sticker_id)
        .load(conn)?;

    Ok(rows.into_iter().collect())
}

fn load_first_stickers_for_packs(
    conn: &mut PgConnection,
    state: &AppState,
    pack_ids: &[i64],
) -> QueryResult<HashMap<i64, StickerPackPreviewSticker>> {
    if pack_ids.is_empty() {
        return Ok(HashMap::new());
    }

    // For each pack, find the sticker with the earliest added_at
    // Using DISTINCT ON (PostgreSQL) to get one row per pack
    let rows: Vec<(i64, Sticker, Media)> = sticker_pack_stickers::table
        .inner_join(stickers::table.inner_join(media::table))
        .filter(sticker_pack_stickers::pack_id.eq_any(pack_ids))
        .order((
            sticker_pack_stickers::pack_id.asc(),
            sticker_pack_stickers::added_at.asc(),
        ))
        .distinct_on(sticker_pack_stickers::pack_id)
        .select((
            sticker_pack_stickers::pack_id,
            Sticker::as_select(),
            Media::as_select(),
        ))
        .load(conn)?;

    Ok(rows
        .into_iter()
        .map(|(pack_id, sticker, media_row)| {
            (
                pack_id,
                StickerPackPreviewSticker {
                    id: sticker.id,
                    media: media_response(state, &media_row),
                    emoji: sticker.emoji,
                },
            )
        })
        .collect())
}

async fn build_pack_summaries(
    conn: &mut PgConnection,
    state: &AppState,
    uid: i32,
    packs: Vec<StickerPack>,
) -> Result<Vec<StickerPackSummary>, AppError> {
    let pack_ids: Vec<i64> = packs.iter().map(|pack| pack.id).collect();
    let owner_uids: Vec<i32> = packs
        .iter()
        .map(|pack| pack.owner_uid)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    let counts = load_pack_counts(conn, &pack_ids)?;
    let subscribed = load_subscribed_pack_ids(conn, uid, &pack_ids)?;
    let mut previews = load_first_stickers_for_packs(conn, state, &pack_ids)?;
    let owner_profiles = state
        .users
        .lookup_profiles(&owner_uids)
        .await
        .unwrap_or_default();

    Ok(packs
        .into_iter()
        .map(|pack| {
            let preview_sticker = previews.remove(&pack.id);
            StickerPackSummary {
                id: pack.id,
                owner_uid: pack.owner_uid,
                owner_name: owner_profiles
                    .get(&pack.owner_uid)
                    .and_then(|profile| profile.username.clone()),
                name: pack.name,
                description: pack.description,
                created_at: pack.created_at,
                updated_at: pack.updated_at,
                sticker_count: *counts.get(&pack.id).unwrap_or(&0),
                is_subscribed: subscribed.contains(&pack.id),
                preview_sticker,
            }
        })
        .collect())
}

fn load_sticker_rows_for_pack(
    conn: &mut PgConnection,
    pack_id: i64,
) -> Result<Vec<(Sticker, Media)>, AppError> {
    sticker_pack_stickers::table
        .inner_join(stickers::table.inner_join(media::table))
        .filter(sticker_pack_stickers::pack_id.eq(pack_id))
        .order((
            sticker_pack_stickers::added_at.asc(),
            sticker_pack_stickers::sticker_id.asc(),
        ))
        .select((Sticker::as_select(), Media::as_select()))
        .load(conn)
        .map_err(AppError::from)
}

fn build_sticker_summaries(
    conn: &mut PgConnection,
    state: &AppState,
    uid: i32,
    rows: Vec<(Sticker, Media)>,
) -> Result<Vec<StickerSummary>, AppError> {
    let sticker_ids: Vec<i64> = rows.iter().map(|(sticker, _)| sticker.id).collect();
    let favorites = load_favorited_sticker_ids(conn, uid, &sticker_ids)?;

    Ok(rows
        .into_iter()
        .map(|(sticker, media_row)| StickerSummary {
            id: sticker.id,
            media: media_response(state, &media_row),
            emoji: sticker.emoji,
            name: sticker.name,
            description: sticker.description,
            created_at: sticker.created_at,
            is_favorited: favorites.contains(&sticker.id),
        })
        .collect())
}

#[utoipa::path(
    post,
    path = "/packs",
    tag = "stickers",
    request_body = CreateStickerPackBody,
    responses(
        (status = 201, description = "Sticker pack created", body = StickerPackDetailResponse)
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn post_pack(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<CreateStickerPackBody>,
) -> Result<AxumJson<StickerPackSummary>, AppError> {
    let conn = &mut *conn;

    let name = normalize_required_name(&body.name)?;
    let now = Utc::now();
    let pack_id = ids::next_id(state.id_gen.as_ref()).await.map_err(|e| {
        tracing::error!("next_id for sticker pack: {:?}", e);
        AppError::Internal("Failed to generate ID")
    })?;

    let pack = conn.transaction::<StickerPack, diesel::result::Error, _>(|conn| {
        diesel::insert_into(sticker_packs::table)
            .values(&NewStickerPack {
                id: pack_id,
                owner_uid: uid,
                name: name.clone(),
                description: body.description.clone(),
                created_at: now,
                updated_at: now,
            })
            .execute(conn)?;

        diesel::insert_into(user_sticker_pack_subscriptions::table)
            .values(&UserStickerPackSubscription {
                uid,
                pack_id,
                subscribed_at: now,
            })
            .execute(conn)?;

        sticker_packs::table
            .filter(sticker_packs::id.eq(pack_id))
            .select(StickerPack::as_select())
            .first(conn)
    })?;

    let summary = build_pack_summaries(conn, &state, uid, vec![pack])
        .await?
        .into_iter()
        .next()
        .unwrap();
    add_to_sticker_pack_order(conn, uid, pack_id, &state)?;
    Ok(AxumJson(summary))
}

#[utoipa::path(
    patch,
    path = "/packs/{pack_id}",
    tag = "stickers",
    request_body = UpdateStickerPackBody,
    params(
        ("pack_id" = i64, Path, description = "Sticker pack ID")
    ),
    responses(
        (status = 200, description = "Sticker pack updated", body = StickerPackDetailResponse)
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn patch_pack(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(pack_id): Path<i64>,
    mut conn: DbConn,
    Json(body): Json<UpdateStickerPackBody>,
) -> Result<AxumJson<StickerPackSummary>, AppError> {
    let conn = &mut *conn;
    let _pack = require_pack_owner(conn, pack_id, uid)?;

    let name = match body.name {
        Some(ref name) => Some(normalize_required_name(name)?),
        None => None,
    };

    diesel::update(sticker_packs::table.filter(sticker_packs::id.eq(pack_id)))
        .set(&UpdateStickerPack {
            name,
            description: body.description,
            updated_at: Utc::now(),
        })
        .execute(conn)?;

    let pack = sticker_packs::table
        .filter(sticker_packs::id.eq(pack_id))
        .select(StickerPack::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Sticker pack not found"))?;
    let summary = build_pack_summaries(conn, &state, uid, vec![pack])
        .await?
        .into_iter()
        .next()
        .unwrap();
    Ok(AxumJson(summary))
}

#[utoipa::path(
    delete,
    path = "/packs/{pack_id}",
    tag = "stickers",
    params(
        ("pack_id" = i64, Path, description = "Sticker pack ID")
    ),
    responses(
        (status = 204, description = "Sticker pack deleted")
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn delete_pack(
    CurrentUid(uid): CurrentUid,
    State(state): State<crate::AppState>,
    Path(pack_id): Path<i64>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;
    let _pack = require_pack_owner(conn, pack_id, uid)?;

    diesel::delete(sticker_packs::table.filter(sticker_packs::id.eq(pack_id))).execute(conn)?;
    remove_from_sticker_pack_order(conn, uid, pack_id, &state)?;

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/packs/{pack_id}",
    tag = "stickers",
    params(
        ("pack_id" = i64, Path, description = "Sticker pack ID")
    ),
    responses(
        (status = 200, description = "Sticker pack details", body = StickerPackDetailResponse)
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn get_pack(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(pack_id): Path<i64>,
    mut conn: DbConn,
) -> Result<AxumJson<StickerPackDetailResponse>, AppError> {
    let conn = &mut *conn;
    let pack = sticker_packs::table
        .filter(sticker_packs::id.eq(pack_id))
        .select(StickerPack::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Sticker pack not found"))?;

    let sticker_rows = load_sticker_rows_for_pack(conn, pack_id)?;
    let stickers = build_sticker_summaries(conn, &state, uid, sticker_rows)?;
    let pack = build_pack_summaries(conn, &state, uid, vec![pack])
        .await?
        .into_iter()
        .next()
        .unwrap();

    Ok(AxumJson(StickerPackDetailResponse { pack, stickers }))
}

#[utoipa::path(
    get,
    path = "/packs/mine/subscribed",
    tag = "stickers",
    responses(
        (status = 200, description = "Subscribed sticker packs", body = StickerPackListResponse)
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn get_my_subscribed_packs(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<AxumJson<StickerPackListResponse>, AppError> {
    let conn = &mut *conn;
    let packs: Vec<StickerPack> = user_sticker_pack_subscriptions::table
        .inner_join(sticker_packs::table)
        .filter(user_sticker_pack_subscriptions::uid.eq(uid))
        .order(user_sticker_pack_subscriptions::subscribed_at.desc())
        .select(StickerPack::as_select())
        .load(conn)?;

    Ok(AxumJson(StickerPackListResponse {
        packs: build_pack_summaries(conn, &state, uid, packs).await?,
    }))
}

#[utoipa::path(
    get,
    path = "/packs/mine/owned",
    tag = "stickers",
    responses(
        (status = 200, description = "Owned sticker packs", body = StickerPackListResponse)
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn get_my_owned_packs(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<AxumJson<StickerPackListResponse>, AppError> {
    let conn = &mut *conn;
    let packs: Vec<StickerPack> = sticker_packs::table
        .filter(sticker_packs::owner_uid.eq(uid))
        .order(sticker_packs::created_at.desc())
        .select(StickerPack::as_select())
        .load(conn)?;

    Ok(AxumJson(StickerPackListResponse {
        packs: build_pack_summaries(conn, &state, uid, packs).await?,
    }))
}

#[utoipa::path(
    put,
    path = "/packs/{pack_id}/subscription",
    tag = "stickers",
    params(
        ("pack_id" = i64, Path, description = "Sticker pack ID")
    ),
    responses(
        (status = 204, description = "Subscribed to sticker pack")
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn put_subscription(
    CurrentUid(uid): CurrentUid,
    State(state): State<crate::AppState>,
    Path(pack_id): Path<i64>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;
    let pack: StickerPack = sticker_packs::table
        .filter(sticker_packs::id.eq(pack_id))
        .select(StickerPack::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Sticker pack not found"))?;

    diesel::insert_into(user_sticker_pack_subscriptions::table)
        .values(&UserStickerPackSubscription {
            uid,
            pack_id,
            subscribed_at: Utc::now(),
        })
        .on_conflict_do_nothing()
        .execute(conn)?;

    // Also update order
    add_to_sticker_pack_order(conn, uid, pack.id, &state)?;

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete,
    path = "/packs/{pack_id}/subscription",
    tag = "stickers",
    params(
        ("pack_id" = i64, Path, description = "Sticker pack ID")
    ),
    responses(
        (status = 204, description = "Unsubscribed from sticker pack")
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn delete_subscription(
    CurrentUid(uid): CurrentUid,
    State(state): State<crate::AppState>,
    Path(pack_id): Path<i64>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;
    let pack: StickerPack = sticker_packs::table
        .filter(sticker_packs::id.eq(pack_id))
        .select(StickerPack::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Sticker pack not found"))?;

    if pack.owner_uid == uid {
        return Err(AppError::BadRequest("Pack owner cannot unsubscribe"));
    }

    diesel::delete(
        user_sticker_pack_subscriptions::table
            .filter(user_sticker_pack_subscriptions::uid.eq(uid))
            .filter(user_sticker_pack_subscriptions::pack_id.eq(pack_id)),
    )
    .execute(conn)?;
    remove_from_sticker_pack_order(conn, uid, pack_id, &state)?;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(utoipa::ToSchema)]
#[allow(dead_code)]
struct PostStickerMultipart {
    /// Sticker image file
    file: Vec<u8>,
    /// Emoji for the sticker
    emoji: String,
    /// Optional sticker name
    name: Option<String>,
    /// Optional sticker description
    description: Option<String>,
}

#[utoipa::path(
    post,
    path = "/packs/{pack_id}/stickers",
    tag = "stickers",
    params(
        ("pack_id" = i64, Path, description = "Sticker pack ID")
    ),
    request_body(content = PostStickerMultipart, content_type = "multipart/form-data"),
    responses(
        (status = 201, description = "Sticker created", body = StickerSummary)
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn post_pack_sticker(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(pack_id): Path<i64>,
    mut conn: DbConn,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, AppError> {
    let conn = &mut *conn;

    let _pack = require_pack_owner(conn, pack_id, uid)?;

    let mut emoji = None;
    let mut name = None;
    let mut description = None;
    let mut file_bytes = None;
    let mut file_name = None;
    let mut content_type = None;

    while let Some(field) = multipart.next_field().await.map_err(|e| {
        tracing::error!("read sticker multipart field: {:?}", e);
        AppError::BadRequest("Invalid multipart request")
    })? {
        let field_name = field.name().unwrap_or_default().to_string();
        match field_name.as_str() {
            "emoji" => {
                emoji = Some(
                    field
                        .text()
                        .await
                        .map_err(|_| AppError::BadRequest("Invalid emoji"))?,
                );
            }
            "name" => {
                name = Some(
                    field
                        .text()
                        .await
                        .map_err(|_| AppError::BadRequest("Invalid name"))?,
                );
            }
            "description" => {
                description = Some(
                    field
                        .text()
                        .await
                        .map_err(|_| AppError::BadRequest("Invalid description"))?,
                );
            }
            "file" => {
                content_type = field.content_type().map(ToString::to_string);
                file_name = field.file_name().map(ToString::to_string);
                let bytes = field.bytes().await.map_err(|e| {
                    tracing::error!("read sticker file bytes: {:?}", e);
                    AppError::BadRequest("Invalid sticker file")
                })?;
                if bytes.len() > MAX_STICKER_UPLOAD_BYTES {
                    return Err(AppError::BadRequest("Sticker file too large"));
                }
                file_bytes = Some(bytes);
            }
            _ => {}
        }
    }

    let emoji = validate_sticker_emoji(
        emoji
            .as_deref()
            .ok_or(AppError::BadRequest("Missing emoji"))?,
    )?;
    let content_type =
        content_type.ok_or(AppError::BadRequest("Missing sticker file content type"))?;
    if !is_allowed_sticker_content_type(&content_type) {
        return Err(AppError::BadRequest("Unsupported sticker content type"));
    }
    let file_bytes = file_bytes.ok_or(AppError::BadRequest("Missing sticker file"))?;
    let file_name = file_name.unwrap_or_else(|| "sticker.bin".to_string());
    let sticker_name = name.and_then(|value| {
        let trimmed = value.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    });
    let sticker_description = description.and_then(|value| {
        let trimmed = value.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    });

    let processed = process_sticker(&content_type, &file_bytes)
        .map_err(|_| AppError::BadRequest("Invalid or corrupted sticker image"))?;

    let media_id = ids::next_id(state.id_gen.as_ref()).await.map_err(|e| {
        tracing::error!("next_id for sticker media: {:?}", e);
        AppError::Internal("Failed to generate ID")
    })?;
    let sticker_id = ids::next_id(state.id_gen.as_ref()).await.map_err(|e| {
        tracing::error!("next_id for sticker: {:?}", e);
        AppError::Internal("Failed to generate ID")
    })?;
    let storage_object_id = uuid::Uuid::new_v4().to_string();
    let storage_key = build_storage_key(STICKER_STORAGE_PREFIX, &file_name, &storage_object_id);

    state
        .media
        .put_object(
            &storage_key,
            &processed.content_type,
            ByteStream::from(processed.data.clone()),
        )
        .await?;

    let now = Utc::now();

    let create_result = conn.transaction::<(Sticker, Media), diesel::result::Error, _>(|conn| {
        diesel::insert_into(media::table)
            .values(&NewMedia {
                id: media_id,
                content_type: processed.content_type.clone(),
                storage_key: storage_key.clone(),
                size: processed.data.len() as i64,
                created_at: now,
                deleted_at: None,
                file_name: file_name.clone(),
                width: processed.width,
                height: processed.height,
                purpose: MediaPurpose::Sticker,
                reference: None,
            })
            .execute(conn)?;

        diesel::insert_into(stickers::table)
            .values(&NewSticker {
                id: sticker_id,
                media_id,
                emoji: emoji.clone(),
                name: sticker_name.clone(),
                description: sticker_description.clone(),
                created_at: now,
            })
            .execute(conn)?;

        diesel::insert_into(sticker_pack_stickers::table)
            .values(&StickerPackSticker {
                pack_id,
                sticker_id,
                added_at: now,
            })
            .execute(conn)?;

        let sticker = stickers::table
            .filter(stickers::id.eq(sticker_id))
            .select(Sticker::as_select())
            .first(conn)?;
        let media_row = media::table
            .filter(media::id.eq(media_id))
            .select(Media::as_select())
            .first(conn)?;
        Ok((sticker, media_row))
    });

    let (sticker, media_row) = match create_result {
        Ok(value) => value,
        Err(e) => {
            tracing::error!("create sticker: {:?}", e);
            state.media.delete_object(&storage_key).await;
            return Err(AppError::Internal("Failed to create sticker"));
        }
    };

    let summary = StickerSummary {
        id: sticker.id,
        media: media_response(&state, &media_row),
        emoji: sticker.emoji,
        name: sticker.name,
        description: sticker.description,
        created_at: sticker.created_at,
        is_favorited: false,
    };

    Ok((StatusCode::CREATED, AxumJson(summary)))
}

#[utoipa::path(
    put,
    path = "/packs/{pack_id}/stickers/{sticker_id}",
    tag = "stickers",
    params(
        ("pack_id" = i64, Path, description = "Sticker pack ID"),
        ("sticker_id" = i64, Path, description = "Sticker ID")
    ),
    responses(
        (status = 204, description = "Sticker added to pack")
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn put_pack_sticker(
    CurrentUid(uid): CurrentUid,
    Path((pack_id, sticker_id)): Path<(i64, i64)>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;
    let _pack = require_pack_owner(conn, pack_id, uid)?;
    let _sticker: Sticker = stickers::table
        .filter(stickers::id.eq(sticker_id))
        .select(Sticker::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Sticker not found"))?;

    diesel::insert_into(sticker_pack_stickers::table)
        .values(&StickerPackSticker {
            pack_id,
            sticker_id,
            added_at: Utc::now(),
        })
        .on_conflict_do_nothing()
        .execute(conn)?;

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete,
    path = "/packs/{pack_id}/stickers/{sticker_id}",
    tag = "stickers",
    params(
        ("pack_id" = i64, Path, description = "Sticker pack ID"),
        ("sticker_id" = i64, Path, description = "Sticker ID")
    ),
    responses(
        (status = 204, description = "Sticker removed from pack")
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn delete_pack_sticker(
    CurrentUid(uid): CurrentUid,
    Path((pack_id, sticker_id)): Path<(i64, i64)>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;
    let _pack = require_pack_owner(conn, pack_id, uid)?;

    diesel::delete(
        sticker_pack_stickers::table
            .filter(sticker_pack_stickers::pack_id.eq(pack_id))
            .filter(sticker_pack_stickers::sticker_id.eq(sticker_id)),
    )
    .execute(conn)?;

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/{sticker_id}",
    tag = "stickers",
    params(
        ("sticker_id" = i64, Path, description = "Sticker ID")
    ),
    responses(
        (status = 200, description = "Sticker details", body = StickerDetailResponse)
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn get_sticker(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(sticker_id): Path<i64>,
    mut conn: DbConn,
) -> Result<AxumJson<StickerDetailResponse>, AppError> {
    let conn = &mut *conn;
    let (sticker, media_row): (Sticker, Media) = stickers::table
        .inner_join(media::table)
        .filter(stickers::id.eq(sticker_id))
        .select((Sticker::as_select(), Media::as_select()))
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Sticker not found"))?;

    let sticker_summary = build_sticker_summaries(conn, &state, uid, vec![(sticker, media_row)])?
        .into_iter()
        .next()
        .unwrap();

    let packs: Vec<StickerPack> = sticker_pack_stickers::table
        .inner_join(sticker_packs::table)
        .filter(sticker_pack_stickers::sticker_id.eq(sticker_id))
        .order((
            sticker_pack_stickers::added_at.asc(),
            sticker_packs::id.asc(),
        ))
        .select(StickerPack::as_select())
        .load(conn)?;

    Ok(AxumJson(StickerDetailResponse {
        sticker: sticker_summary,
        packs: build_pack_summaries(conn, &state, uid, packs).await?,
    }))
}

#[utoipa::path(
    put,
    path = "/{sticker_id}/favorite",
    tag = "stickers",
    params(
        ("sticker_id" = i64, Path, description = "Sticker ID")
    ),
    responses(
        (status = 204, description = "Sticker favorited")
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn put_favorite(
    CurrentUid(uid): CurrentUid,
    Path(sticker_id): Path<i64>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;
    let _sticker: Sticker = stickers::table
        .filter(stickers::id.eq(sticker_id))
        .select(Sticker::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Sticker not found"))?;

    diesel::insert_into(user_favorite_stickers::table)
        .values(&UserFavoriteSticker {
            uid,
            sticker_id,
            created_at: Utc::now(),
        })
        .on_conflict_do_nothing()
        .execute(conn)?;

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete,
    path = "/{sticker_id}/favorite",
    tag = "stickers",
    params(
        ("sticker_id" = i64, Path, description = "Sticker ID")
    ),
    responses(
        (status = 204, description = "Sticker unfavorited")
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn delete_favorite(
    CurrentUid(uid): CurrentUid,
    Path(sticker_id): Path<i64>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;

    diesel::delete(
        user_favorite_stickers::table
            .filter(user_favorite_stickers::uid.eq(uid))
            .filter(user_favorite_stickers::sticker_id.eq(sticker_id)),
    )
    .execute(conn)?;

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/mine/favorites",
    tag = "stickers",
    responses(
        (status = 200, description = "Favorite stickers", body = FavoriteStickerListResponse)
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn get_my_favorites(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<AxumJson<FavoriteStickerListResponse>, AppError> {
    let conn = &mut *conn;
    let rows: Vec<(Sticker, Media)> = user_favorite_stickers::table
        .inner_join(stickers::table.inner_join(media::table))
        .filter(user_favorite_stickers::uid.eq(uid))
        .order(user_favorite_stickers::created_at.desc())
        .select((Sticker::as_select(), Media::as_select()))
        .load(conn)?;

    Ok(AxumJson(FavoriteStickerListResponse {
        stickers: build_sticker_summaries(conn, &state, uid, rows)?,
    }))
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(post_pack))
        .routes(utoipa_axum::routes!(get_my_subscribed_packs))
        .routes(utoipa_axum::routes!(get_my_owned_packs))
        .routes(utoipa_axum::routes!(get_my_favorites))
        .routes(utoipa_axum::routes!(get_pack, patch_pack, delete_pack))
        .routes(utoipa_axum::routes!(put_subscription, delete_subscription))
        .routes(utoipa_axum::routes!(post_pack_sticker))
        .routes(utoipa_axum::routes!(put_pack_sticker, delete_pack_sticker))
        .routes(utoipa_axum::routes!(get_sticker))
        .routes(utoipa_axum::routes!(put_favorite, delete_favorite))
        .layer(axum::extract::DefaultBodyLimit::max(
            MAX_STICKER_UPLOAD_BYTES,
        ))
}

fn remove_from_sticker_pack_order(
    conn: &mut PgConnection,
    uid: i32,
    pack_id: i64,
    state: &crate::AppState,
) -> Result<(), AppError> {
    use crate::models::UserExtra;
    use crate::schema::user_extra;

    if let Ok(Some(extra)) = user_extra::table
        .filter(user_extra::uid.eq(uid))
        .first::<UserExtra>(conn)
        .optional()
    {
        if let Ok(mut order) =
            serde_json::from_value::<Vec<StickerPackOrderItem>>(extra.sticker_pack_order.clone())
        {
            let pack_id_str = pack_id.to_string();
            let original_len = order.len();
            order.retain(|item| item.sticker_pack_id != pack_id_str);
            if order.len() < original_len {
                let order_json = serde_json::to_value(&order).unwrap_or(serde_json::json!([]));
                diesel::update(user_extra::table.filter(user_extra::uid.eq(uid)))
                    .set(user_extra::sticker_pack_order.eq(&order_json))
                    .execute(conn)?;

                let msg = std::sync::Arc::new(ServerWsMessage::StickerPackOrderUpdated(
                    StickerPackOrderUpdatePayload { order },
                ));
                state.ws_registry.broadcast_to_uids(&[uid], msg);
            }
        }
    }
    Ok(())
}

fn add_to_sticker_pack_order(
    conn: &mut PgConnection,
    uid: i32,
    pack_id: i64,
    state: &crate::AppState,
) -> Result<(), AppError> {
    use crate::models::UserExtra;
    use crate::schema::user_extra;

    if let Ok(Some(extra)) = user_extra::table
        .filter(user_extra::uid.eq(uid))
        .first::<UserExtra>(conn)
        .optional()
    {
        if let Ok(mut order) =
            serde_json::from_value::<Vec<StickerPackOrderItem>>(extra.sticker_pack_order.clone())
        {
            let pack_id_str = pack_id.to_string();
            let mut changed = false;

            let now = chrono::Utc::now().timestamp_millis();

            if let Some(existing) = order.iter_mut().find(|i| i.sticker_pack_id == pack_id_str) {
                if existing.last_used_on != now {
                    existing.last_used_on = now;
                    changed = true;
                }
            } else {
                order.push(StickerPackOrderItem {
                    sticker_pack_id: pack_id_str,
                    last_used_on: now,
                });
                changed = true;
            }

            if changed {
                let order_json = serde_json::to_value(&order).unwrap_or(serde_json::json!([]));
                diesel::update(user_extra::table.filter(user_extra::uid.eq(uid)))
                    .set(user_extra::sticker_pack_order.eq(&order_json))
                    .execute(conn)?;

                let msg = std::sync::Arc::new(ServerWsMessage::StickerPackOrderUpdated(
                    StickerPackOrderUpdatePayload { order },
                ));
                state.ws_registry.broadcast_to_uids(&[uid], msg);
            }
        }
    }
    Ok(())
}
