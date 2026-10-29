use aws_sdk_s3::primitives::ByteStream;
use chrono::Utc;
use diesel::prelude::*;
use unicode_segmentation::UnicodeSegmentation;

use crate::{
    dto::stickers::CreateStickerFromMessageBody,
    errors::AppError,
    models::{
        Attachment, Media, MediaPurpose, Message, MessageType, NewMedia, NewSticker, Sticker,
        StickerPackSticker,
    },
    schema::{attachments, group_membership, media, messages, sticker_pack_stickers, stickers},
    services::{
        image_processing::{process_sticker, ProcessedMedia},
        media::{build_storage_key, MediaStore},
    },
    state::DbPool,
    utils::ids::{self, IdGen},
};

pub const MAX_STICKER_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
const MAX_STICKER_EMOJI_GRAPHEMES: usize = 4;

pub struct StickerInput {
    pub content_type: String,
    pub bytes: Vec<u8>,
    pub file_name: String,
    pub emoji: String,
    pub name: Option<String>,
    pub description: Option<String>,
}

pub fn validate_sticker_emoji(input: &str) -> Result<String, AppError> {
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

fn prepare(input: &StickerInput) -> Result<ProcessedMedia, AppError> {
    if input.bytes.len() > MAX_STICKER_UPLOAD_BYTES {
        return Err(AppError::BadRequest("Sticker file too large"));
    }
    if !input.content_type.starts_with("image/") && input.content_type != "video/webm" {
        return Err(AppError::BadRequest("Unsupported sticker content type"));
    }
    process_sticker(&input.content_type, &input.bytes)
        .map_err(|_| AppError::BadRequest("Invalid or corrupted sticker image"))
}

/// The snapshot is checked again before insertion; no locks span object storage I/O.
pub struct MessageImage {
    chat_id: i64,
    message_id: i64,
    attachment: Attachment,
}

fn load_message_image(
    conn: &mut PgConnection,
    uid: i32,
    chat_id: i64,
    message_id: i64,
) -> Result<MessageImage, AppError> {
    conn.transaction(|conn| {
        // Membership is checked at read time. Removal after this check may race
        // with a successful copy; do not block membership or read-pointer updates.
        group_membership::table
            .find((chat_id, uid))
            .select(group_membership::uid)
            .first::<i32>(conn)
            .optional()?
            .ok_or(AppError::Forbidden("Not a member of this chat"))?;
        let message = messages::table
            .filter(
                messages::id
                    .eq(message_id)
                    .and(messages::chat_id.eq(chat_id)),
            )
            .select(Message::as_select())
            .for_share()
            .first::<Message>(conn)
            .optional()?
            .ok_or(AppError::NotFound("Message not found"))?;
        if message.deleted_at.is_some() || !message.is_published {
            return Err(AppError::NotFound("Message not found"));
        }
        if message.message_type != MessageType::Text
            || message
                .message
                .as_deref()
                .is_some_and(|text| !text.trim().is_empty())
        {
            return Err(AppError::BadRequest(
                "Message must contain only one image and no text",
            ));
        }
        // The message_id index bounds the lookup; two rows suffice to reject an album.
        let mut rows = attachments::table
            .filter(attachments::message_id.eq(message_id))
            .filter(attachments::deleted_at.is_null())
            .order(attachments::id.asc())
            .limit(2)
            .select(Attachment::as_select())
            .for_share()
            .load::<Attachment>(conn)?;
        if rows.len() != 1 || !rows[0].kind.starts_with("image/") {
            return Err(AppError::BadRequest(
                "Message must contain only one image and no text",
            ));
        }
        let attachment = rows.remove(0);
        if attachment.size > MAX_STICKER_UPLOAD_BYTES as i64 {
            return Err(AppError::BadRequest("Sticker file too large"));
        }
        Ok(MessageImage {
            chat_id,
            message_id,
            attachment,
        })
    })
}

fn normalized_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn insert_sticker(
    conn: &mut PgConnection,
    uid: i32,
    pack_id: i64,
    new_media: &NewMedia,
    new_sticker: &NewSticker,
    source: Option<&MessageImage>,
) -> Result<(Sticker, Media), AppError> {
    conn.transaction(|conn| {
        if let Some(source) = source {
            let current = load_message_image(conn, uid, source.chat_id, source.message_id)?;
            if current.attachment.id != source.attachment.id
                || current.attachment.external_reference != source.attachment.external_reference
                || current.attachment.kind != source.attachment.kind
            {
                return Err(AppError::Conflict("Source image changed"));
            }
        }
        let pack = super::lock_pack(conn, pack_id)?;
        super::check_owner(&pack, uid)?;
        let media_row = diesel::insert_into(media::table)
            .values(new_media)
            .returning(Media::as_returning())
            .get_result(conn)?;
        let sticker = diesel::insert_into(stickers::table)
            .values(new_sticker)
            .returning(Sticker::as_returning())
            .get_result(conn)?;
        diesel::insert_into(sticker_pack_stickers::table)
            .values(StickerPackSticker {
                pack_id,
                sticker_id: new_sticker.id,
                added_at: new_sticker.created_at,
            })
            .execute(conn)?;
        Ok((sticker, media_row))
    })
}

pub async fn create_sticker(
    pool: &DbPool,
    store: &MediaStore,
    id_gen: &IdGen,
    uid: i32,
    pack_id: i64,
    input: StickerInput,
    source: Option<MessageImage>,
) -> Result<(Sticker, Media), AppError> {
    let emoji = validate_sticker_emoji(&input.emoji)?;
    // Decoding/resizing must not block an async executor thread.
    let (input, processed) =
        tokio::task::spawn_blocking(move || prepare(&input).map(|processed| (input, processed)))
            .await
            .map_err(|_| AppError::Internal("Sticker processing failed"))??;
    let media_id = ids::next_id(id_gen)
        .await
        .map_err(|_| AppError::Internal("Failed to generate ID"))?;
    let sticker_id = ids::next_id(id_gen)
        .await
        .map_err(|_| AppError::Internal("Failed to generate ID"))?;
    let storage_key = build_storage_key(
        "stickers",
        &input.file_name,
        &uuid::Uuid::new_v4().to_string(),
    );
    let size = processed.data.len() as i64;
    store
        .put_object(
            &storage_key,
            &processed.content_type,
            ByteStream::from(processed.data),
        )
        .await?;
    let now = Utc::now();
    let new_media = NewMedia {
        id: media_id,
        content_type: processed.content_type,
        storage_key: storage_key.clone(),
        size,
        created_at: now,
        deleted_at: None,
        file_name: input.file_name,
        width: processed.width,
        height: processed.height,
        purpose: MediaPurpose::Sticker,
        reference: None,
    };
    let new_sticker = NewSticker {
        id: sticker_id,
        media_id,
        emoji,
        name: normalized_optional(input.name),
        description: normalized_optional(input.description),
        created_at: now,
    };
    let pool = pool.clone();
    // Acquire the connection only after all media I/O and CPU work has finished.
    let result = tokio::task::spawn_blocking(move || {
        let mut conn = pool.get()?;
        insert_sticker(
            &mut conn,
            uid,
            pack_id,
            &new_media,
            &new_sticker,
            source.as_ref(),
        )
    })
    .await
    .map_err(|error| {
        tracing::error!(?error, "sticker database task failed");
        AppError::Internal("Failed to create sticker")
    })
    .and_then(|result| result);
    if result.is_err() {
        store.delete_object(&storage_key).await;
    }
    result
}

pub async fn create_sticker_from_message(
    pool: &DbPool,
    store: &MediaStore,
    id_gen: &IdGen,
    uid: i32,
    pack_id: i64,
    body: CreateStickerFromMessageBody,
) -> Result<(Sticker, Media), AppError> {
    let emoji = validate_sticker_emoji(&body.emoji)?;
    let read_pool = pool.clone();
    let source = tokio::task::spawn_blocking(move || {
        let mut conn = read_pool.get()?;
        super::require_pack_owner(&mut conn, pack_id, uid)?;
        load_message_image(&mut conn, uid, body.chat_id, body.message_id)
    })
    .await
    .map_err(|error| {
        tracing::error!(?error, "sticker source database task failed");
        AppError::Internal("Failed to read source image")
    })??;
    let bytes = store
        .get_object_limited(
            &source.attachment.external_reference,
            MAX_STICKER_UPLOAD_BYTES,
        )
        .await
        .map_err(|error| match error.0 {
            axum::http::StatusCode::PAYLOAD_TOO_LARGE => {
                AppError::BadRequest("Sticker file too large")
            }
            _ => AppError::from(error),
        })?;
    let input = StickerInput {
        content_type: source.attachment.kind.clone(),
        bytes,
        file_name: source.attachment.file_name.clone(),
        emoji,
        name: body.name,
        description: body.description,
    };
    create_sticker(pool, store, id_gen, uid, pack_id, input, Some(source)).await
}

#[cfg(test)]
mod tests;
