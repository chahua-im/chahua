use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use aws_sdk_s3::primitives::ByteStream;
use chrono::Utc;
use diesel::prelude::*;
use diesel::PgConnection;

use crate::dto::stickers::{
    CreateStickerPackBody, FavoriteStickerListResponse, StickerDetailResponse,
    StickerMediaResponse, StickerPackDetailResponse, StickerPackDiscoveryItem,
    StickerPackDiscoveryQuery, StickerPackDiscoveryResponse, StickerPackListResponse,
    StickerPackPreviewSticker, StickerPackSummary, StickerSummary, UpdateStickerPackBody,
};
use crate::dto::ws::{ServerWsMessage, StickerPackOrderUpdatePayload};
use crate::errors::AppError;
use crate::models::{
    Media, MediaPurpose, NewMedia, NewSticker, NewStickerPack, Sticker, StickerPack,
    StickerPackSticker, UpdateStickerPack, UserFavoriteSticker,
};
use crate::schema::{
    media, sticker_pack_stickers, sticker_packs, stickers, user_favorite_stickers,
    user_sticker_pack_subscriptions,
};
use crate::services::{
    image_processing::process_sticker,
    media::{build_storage_key, MediaStore},
    sticker_discovery, stickers as packs_service,
    user::lookup_user_profiles,
    ws_registry::ConnectionRegistry,
};
use crate::utils::ids::{self, IdGen};

const STICKER_STORAGE_PREFIX: &str = "stickers";
const MAX_STICKER_EMOJI_GRAPHEMES: usize = 4;
pub struct StickerUpload {
    pub emoji: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub file_bytes: Option<Vec<u8>>,
    pub file_name: Option<String>,
    pub content_type: Option<String>,
}

pub fn get_packs(
    uid: i32,
    query: StickerPackDiscoveryQuery,
    conn: &mut PgConnection,
    media_store: &MediaStore,
) -> Result<StickerPackDiscoveryResponse, AppError> {
    conn.build_transaction()
        .read_only()
        .repeatable_read()
        .run(|conn| {
            let ranking = sticker_discovery::discover_packs(conn, &query, Utc::now())?;
            let ids: Vec<i64> = ranking.rows.iter().map(|row| row.pack_id).collect();
            let packs = sticker_packs::table
                .filter(sticker_packs::id.eq_any(&ids))
                .select(StickerPack::as_select())
                .load(conn)?;
            let mut previews = sticker_discovery::load_preview_stickers(conn, media_store, &ids)?;
            let first_previews = previews
                .iter()
                .filter_map(|(&id, stickers)| {
                    stickers.first().cloned().map(|sticker| (id, sticker))
                })
                .collect();
            let mut summaries: HashMap<_, _> =
                build_pack_summaries_with_previews(conn, uid, packs, first_previews)?
                    .into_iter()
                    .map(|pack| (pack.id, pack))
                    .collect();
            let packs = ranking
                .rows
                .into_iter()
                .map(|row| {
                    let pack = summaries.remove(&row.pack_id).ok_or(AppError::Internal(
                        "Sticker pack missing from discovery snapshot",
                    ))?;
                    Ok(StickerPackDiscoveryItem {
                        pack,
                        subscriber_count: row.subscriber_count,
                        recent_subscriber_count: row.recent_subscriber_count,
                        preview_stickers: previews.remove(&row.pack_id).unwrap_or_default(),
                    })
                })
                .collect::<Result<Vec<_>, AppError>>()?;
            Ok(StickerPackDiscoveryResponse {
                packs,
                has_more: ranking.has_more,
                recent_window_days: sticker_discovery::RECENT_WINDOW_DAYS,
                stats_updated_at: ranking.stats_updated_at,
            })
        })
}

pub async fn post_pack(
    uid: i32,
    body: CreateStickerPackBody,
    conn: &mut PgConnection,
    id_gen: &IdGen,
    media_store: &MediaStore,
    ws_registry: &ConnectionRegistry,
) -> Result<StickerPackSummary, AppError> {
    let name = normalize_required_name(&body.name)?;
    let now = Utc::now();
    let pack_id = ids::next_id(id_gen).await.map_err(|e| {
        tracing::error!("next_id for sticker pack: {:?}", e);
        AppError::Internal("Failed to generate ID")
    })?;
    let change = packs_service::create_pack(
        conn,
        NewStickerPack {
            id: pack_id,
            owner_uid: uid,
            name,
            description: body.description,
            created_at: now,
            updated_at: now,
            visibility: body.visibility,
        },
    )?;
    broadcast_orders(ws_registry, change.orders);
    Ok(
        build_pack_summaries(conn, media_store, uid, vec![change.pack])?
            .into_iter()
            .next()
            .unwrap(),
    )
}

pub fn patch_pack(
    uid: i32,
    pack_id: i64,
    body: UpdateStickerPackBody,
    conn: &mut PgConnection,
    media_store: &MediaStore,
    ws_registry: &ConnectionRegistry,
) -> Result<StickerPackSummary, AppError> {
    let name = body
        .name
        .as_deref()
        .map(normalize_required_name)
        .transpose()?;
    let change = packs_service::update_pack(
        conn,
        uid,
        pack_id,
        UpdateStickerPack {
            name,
            description: body.description,
            updated_at: Utc::now(),
            visibility: body.visibility,
        },
    )?;
    broadcast_orders(ws_registry, change.orders);
    Ok(
        build_pack_summaries(conn, media_store, uid, vec![change.pack])?
            .into_iter()
            .next()
            .unwrap(),
    )
}

pub fn delete_pack(
    uid: i32,
    pack_id: i64,
    conn: &mut PgConnection,
    ws_registry: &ConnectionRegistry,
) -> Result<(), AppError> {
    broadcast_orders(ws_registry, packs_service::delete_pack(conn, uid, pack_id)?);
    Ok(())
}

pub fn get_pack(
    uid: i32,
    pack_id: i64,
    conn: &mut PgConnection,
    media_store: &MediaStore,
) -> Result<StickerPackDetailResponse, AppError> {
    conn.build_transaction()
        .read_only()
        .repeatable_read()
        .run(|conn| {
            let pack = packs_service::visible_pack(conn, uid, pack_id)?;
            let rows = load_sticker_rows_for_pack(conn, pack_id)?;
            let stickers = build_sticker_summaries(conn, media_store, uid, rows)?;
            let pack = build_pack_summaries(conn, media_store, uid, vec![pack])?
                .into_iter()
                .next()
                .unwrap();
            Ok(StickerPackDetailResponse { pack, stickers })
        })
}

pub fn get_my_subscribed_packs(
    uid: i32,
    conn: &mut PgConnection,
    media_store: &MediaStore,
) -> Result<StickerPackListResponse, AppError> {
    conn.build_transaction()
        .read_only()
        .repeatable_read()
        .run(|conn| {
            let packs = packs_service::subscribed_packs(conn, uid)?;
            Ok(StickerPackListResponse {
                packs: build_pack_summaries(conn, media_store, uid, packs)?,
            })
        })
}

pub fn get_my_owned_packs(
    uid: i32,
    conn: &mut PgConnection,
    media_store: &MediaStore,
) -> Result<StickerPackListResponse, AppError> {
    let packs = sticker_packs::table
        .filter(sticker_packs::owner_uid.eq(uid))
        .order(sticker_packs::created_at.desc())
        .select(StickerPack::as_select())
        .load(conn)?;
    Ok(StickerPackListResponse {
        packs: build_pack_summaries(conn, media_store, uid, packs)?,
    })
}

pub fn put_subscription(
    uid: i32,
    pack_id: i64,
    conn: &mut PgConnection,
    ws_registry: &ConnectionRegistry,
) -> Result<(), AppError> {
    let order = packs_service::subscribe(conn, uid, pack_id)?;
    broadcast_orders(ws_registry, vec![packs_service::OrderUpdate { uid, order }]);
    Ok(())
}

pub fn delete_subscription(
    uid: i32,
    pack_id: i64,
    conn: &mut PgConnection,
    ws_registry: &ConnectionRegistry,
) -> Result<(), AppError> {
    let order = packs_service::unsubscribe(conn, uid, pack_id)?;
    broadcast_orders(ws_registry, vec![packs_service::OrderUpdate { uid, order }]);
    Ok(())
}

pub async fn post_pack_sticker(
    uid: i32,
    pack_id: i64,
    upload: StickerUpload,
    conn: &mut PgConnection,
    media_store: &MediaStore,
    id_gen: &IdGen,
) -> Result<StickerSummary, AppError> {
    require_pack_owner(conn, pack_id, uid)?;
    let emoji = validate_sticker_emoji(
        upload
            .emoji
            .as_deref()
            .ok_or(AppError::BadRequest("Missing emoji"))?,
    )?;
    let content_type = upload
        .content_type
        .as_deref()
        .ok_or(AppError::BadRequest("Missing sticker file content type"))?;
    if !is_allowed_sticker_content_type(content_type) {
        return Err(AppError::BadRequest("Unsupported sticker content type"));
    }
    let file_bytes = upload
        .file_bytes
        .as_deref()
        .ok_or(AppError::BadRequest("Missing sticker file"))?;
    let file_name = upload
        .file_name
        .unwrap_or_else(|| "sticker.bin".to_string());
    let sticker_name = upload
        .name
        .and_then(|value| (!value.trim().is_empty()).then(|| value.trim().to_string()));
    let sticker_description = upload
        .description
        .and_then(|value| (!value.trim().is_empty()).then(|| value.trim().to_string()));
    let processed = process_sticker(content_type, file_bytes)
        .map_err(|_| AppError::BadRequest("Invalid or corrupted sticker image"))?;
    let media_id = ids::next_id(id_gen).await.map_err(|e| {
        tracing::error!("next_id for sticker media: {:?}", e);
        AppError::Internal("Failed to generate ID")
    })?;
    let sticker_id = ids::next_id(id_gen).await.map_err(|e| {
        tracing::error!("next_id for sticker: {:?}", e);
        AppError::Internal("Failed to generate ID")
    })?;
    let storage_key = build_storage_key(
        STICKER_STORAGE_PREFIX,
        &file_name,
        &uuid::Uuid::new_v4().to_string(),
    );
    media_store
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
        Ok((
            stickers::table
                .filter(stickers::id.eq(sticker_id))
                .select(Sticker::as_select())
                .first(conn)?,
            media::table
                .filter(media::id.eq(media_id))
                .select(Media::as_select())
                .first(conn)?,
        ))
    });
    let (sticker, media_row) = match create_result {
        Ok(value) => value,
        Err(error) => {
            tracing::error!("create sticker: {:?}", error);
            media_store.delete_object(&storage_key).await;
            return Err(AppError::Internal("Failed to create sticker"));
        }
    };
    Ok(StickerSummary {
        id: sticker.id,
        media: media_response(media_store, &media_row),
        emoji: sticker.emoji,
        name: sticker.name,
        description: sticker.description,
        created_at: sticker.created_at,
        is_favorited: false,
    })
}

pub fn put_pack_sticker(
    uid: i32,
    pack_id: i64,
    sticker_id: i64,
    conn: &mut PgConnection,
) -> Result<(), AppError> {
    require_pack_owner(conn, pack_id, uid)?;
    stickers::table
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
    Ok(())
}

pub fn delete_pack_sticker(
    uid: i32,
    pack_id: i64,
    sticker_id: i64,
    conn: &mut PgConnection,
) -> Result<(), AppError> {
    require_pack_owner(conn, pack_id, uid)?;
    diesel::delete(
        sticker_pack_stickers::table
            .filter(sticker_pack_stickers::pack_id.eq(pack_id))
            .filter(sticker_pack_stickers::sticker_id.eq(sticker_id)),
    )
    .execute(conn)?;
    Ok(())
}

pub fn get_sticker(
    uid: i32,
    sticker_id: i64,
    conn: &mut PgConnection,
    media_store: &MediaStore,
) -> Result<StickerDetailResponse, AppError> {
    conn.build_transaction()
        .read_only()
        .repeatable_read()
        .run(|conn| {
            let row = stickers::table
                .inner_join(media::table)
                .filter(stickers::id.eq(sticker_id))
                .select((Sticker::as_select(), Media::as_select()))
                .first(conn)
                .optional()?
                .ok_or(AppError::NotFound("Sticker not found"))?;
            let sticker = build_sticker_summaries(conn, media_store, uid, vec![row])?
                .into_iter()
                .next()
                .unwrap();
            let rows = packs_service::packs_for_sticker(conn, uid, sticker_id)?;
            let packs = build_pack_summaries(conn, media_store, uid, rows)?;
            Ok(StickerDetailResponse { sticker, packs })
        })
}

pub fn put_favorite(uid: i32, sticker_id: i64, conn: &mut PgConnection) -> Result<(), AppError> {
    stickers::table
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
    Ok(())
}

pub fn delete_favorite(uid: i32, sticker_id: i64, conn: &mut PgConnection) -> Result<(), AppError> {
    diesel::delete(
        user_favorite_stickers::table
            .filter(user_favorite_stickers::uid.eq(uid))
            .filter(user_favorite_stickers::sticker_id.eq(sticker_id)),
    )
    .execute(conn)?;
    Ok(())
}

pub fn get_my_favorites(
    uid: i32,
    conn: &mut PgConnection,
    media_store: &MediaStore,
) -> Result<FavoriteStickerListResponse, AppError> {
    let rows = user_favorite_stickers::table
        .inner_join(stickers::table.inner_join(media::table))
        .filter(user_favorite_stickers::uid.eq(uid))
        .order(user_favorite_stickers::created_at.desc())
        .select((Sticker::as_select(), Media::as_select()))
        .load(conn)?;
    Ok(FavoriteStickerListResponse {
        stickers: build_sticker_summaries(conn, media_store, uid, rows)?,
    })
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
    if !graphemes
        .iter()
        .all(|grapheme| emojis::get(grapheme).is_some())
    {
        return Err(AppError::BadRequest("Invalid emoji"));
    }
    Ok(input.to_string())
}

fn is_allowed_sticker_content_type(content_type: &str) -> bool {
    content_type.starts_with("image/") || content_type == "video/webm"
}

fn media_response(media_store: &MediaStore, media_row: &Media) -> StickerMediaResponse {
    StickerMediaResponse {
        id: media_row.id,
        url: media_store.public_url(&media_row.storage_key),
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
    let pack = sticker_packs::table
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
    Ok(sticker_pack_stickers::table
        .filter(sticker_pack_stickers::pack_id.eq_any(pack_ids))
        .group_by(sticker_pack_stickers::pack_id)
        .select((sticker_pack_stickers::pack_id, diesel::dsl::count_star()))
        .load(conn)?
        .into_iter()
        .collect())
}

fn load_subscribed_pack_ids(
    conn: &mut PgConnection,
    uid: i32,
    pack_ids: &[i64],
) -> QueryResult<HashSet<i64>> {
    if pack_ids.is_empty() {
        return Ok(HashSet::new());
    }
    Ok(user_sticker_pack_subscriptions::table
        .filter(user_sticker_pack_subscriptions::uid.eq(uid))
        .filter(user_sticker_pack_subscriptions::pack_id.eq_any(pack_ids))
        .select(user_sticker_pack_subscriptions::pack_id)
        .load(conn)?
        .into_iter()
        .collect())
}

fn load_favorited_sticker_ids(
    conn: &mut PgConnection,
    uid: i32,
    sticker_ids: &[i64],
) -> QueryResult<HashSet<i64>> {
    if sticker_ids.is_empty() {
        return Ok(HashSet::new());
    }
    Ok(user_favorite_stickers::table
        .filter(user_favorite_stickers::uid.eq(uid))
        .filter(user_favorite_stickers::sticker_id.eq_any(sticker_ids))
        .select(user_favorite_stickers::sticker_id)
        .load(conn)?
        .into_iter()
        .collect())
}

fn load_first_stickers_for_packs(
    conn: &mut PgConnection,
    media_store: &MediaStore,
    pack_ids: &[i64],
) -> QueryResult<HashMap<i64, StickerPackPreviewSticker>> {
    if pack_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(i64, Sticker, Media)> = sticker_pack_stickers::table
        .inner_join(stickers::table.inner_join(media::table))
        .filter(sticker_pack_stickers::pack_id.eq_any(pack_ids))
        .order((
            sticker_pack_stickers::pack_id.asc(),
            sticker_pack_stickers::added_at.asc(),
            sticker_pack_stickers::sticker_id.asc(),
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
                    media: media_response(media_store, &media_row),
                    emoji: sticker.emoji,
                },
            )
        })
        .collect())
}

fn build_pack_summaries(
    conn: &mut PgConnection,
    media_store: &MediaStore,
    uid: i32,
    packs: Vec<StickerPack>,
) -> Result<Vec<StickerPackSummary>, AppError> {
    let pack_ids = packs.iter().map(|pack| pack.id).collect::<Vec<_>>();
    let previews = load_first_stickers_for_packs(conn, media_store, &pack_ids)?;
    build_pack_summaries_with_previews(conn, uid, packs, previews)
}

fn build_pack_summaries_with_previews(
    conn: &mut PgConnection,
    uid: i32,
    packs: Vec<StickerPack>,
    mut previews: HashMap<i64, StickerPackPreviewSticker>,
) -> Result<Vec<StickerPackSummary>, AppError> {
    let pack_ids = packs.iter().map(|pack| pack.id).collect::<Vec<_>>();
    let owner_uids = packs
        .iter()
        .map(|pack| pack.owner_uid)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let counts = load_pack_counts(conn, &pack_ids)?;
    let subscribed = load_subscribed_pack_ids(conn, uid, &pack_ids)?;
    let owner_profiles = lookup_user_profiles(conn, &owner_uids).unwrap_or_default();
    Ok(packs
        .into_iter()
        .map(|pack| StickerPackSummary {
            id: pack.id,
            owner_uid: pack.owner_uid,
            owner_name: owner_profiles
                .get(&pack.owner_uid)
                .and_then(|profile| profile.username.clone()),
            name: pack.name,
            description: pack.description,
            created_at: pack.created_at,
            updated_at: pack.updated_at,
            visibility: pack.visibility,
            sticker_count: *counts.get(&pack.id).unwrap_or(&0),
            is_subscribed: subscribed.contains(&pack.id),
            preview_sticker: previews.remove(&pack.id),
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
    media_store: &MediaStore,
    uid: i32,
    rows: Vec<(Sticker, Media)>,
) -> Result<Vec<StickerSummary>, AppError> {
    let sticker_ids = rows
        .iter()
        .map(|(sticker, _)| sticker.id)
        .collect::<Vec<_>>();
    let favorites = load_favorited_sticker_ids(conn, uid, &sticker_ids)?;
    Ok(rows
        .into_iter()
        .map(|(sticker, media_row)| StickerSummary {
            id: sticker.id,
            media: media_response(media_store, &media_row),
            emoji: sticker.emoji,
            name: sticker.name,
            description: sticker.description,
            created_at: sticker.created_at,
            is_favorited: favorites.contains(&sticker.id),
        })
        .collect())
}

fn broadcast_orders(ws_registry: &ConnectionRegistry, orders: Vec<packs_service::OrderUpdate>) {
    for update in orders {
        ws_registry.broadcast_to_uids(
            &[update.uid],
            Arc::new(ServerWsMessage::StickerPackOrderUpdated(
                StickerPackOrderUpdatePayload {
                    order: update.order,
                },
            )),
        );
    }
}

#[cfg(test)]
mod tests;
