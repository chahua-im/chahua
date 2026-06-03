use chrono::Utc;
use diesel::{prelude::*, PgConnection};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::HashSet;

use crate::{
    dto::{
        messages::MentionInfo,
        saved_messages::{
            ListSavedMessagesResponse, SavedAttachmentSnapshot, SavedChatSnapshot,
            SavedMessageResponse, SavedSenderSnapshot, SavedStickerSnapshot,
        },
        users::UserGroupTagInfo,
    },
    errors::AppError,
    handlers::chats::{build_mention_info, extract_mention_uids},
    models::{
        Attachment, Group, Media, Message, MessageType, NewSavedMessage, SavedMessage, Sticker,
    },
    schema::{attachments, group_membership, groups, media, messages, saved_messages, stickers},
    services::{
        media::build_public_object_url,
        user::{lookup_user_avatars, lookup_user_profiles},
    },
    utils::{ids, pagination::validate_limit},
    AppState,
};

pub const DEFAULT_SAVED_MESSAGES_LIMIT: i64 = 30;
pub const MAX_SAVED_MESSAGES_LIMIT: i64 = 100;
const INVALID_SAVED_MESSAGE_SNAPSHOT: &str = "Saved message snapshot is invalid";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedMentionSnapshot {
    uid: i32,
    username: Option<String>,
    avatar_url: Option<String>,
    gender: i16,
    #[serde(default)]
    user_group: Option<UserGroupTagInfo>,
}

impl From<SavedMentionSnapshot> for MentionInfo {
    fn from(snapshot: SavedMentionSnapshot) -> Self {
        MentionInfo {
            uid: snapshot.uid,
            username: snapshot.username,
            avatar_url: snapshot.avatar_url,
            gender: snapshot.gender,
            user_group: snapshot.user_group,
        }
    }
}

pub fn ensure_message_can_be_saved(message: &Message) -> Result<(), AppError> {
    if message.deleted_at.is_some() {
        return Err(AppError::BadRequest("Cannot save deleted message"));
    }

    if !message.is_published {
        return Err(AppError::BadRequest("Cannot save unpublished message"));
    }

    if matches!(&message.message_type, MessageType::System) {
        return Err(AppError::BadRequest("Cannot save system message"));
    }

    Ok(())
}

pub fn saved_messages_limit(limit: Option<i64>) -> i64 {
    validate_limit(
        Some(limit.unwrap_or(DEFAULT_SAVED_MESSAGES_LIMIT)),
        MAX_SAVED_MESSAGES_LIMIT,
    )
}

pub(crate) fn split_saved_messages_page<T, F>(
    rows: Vec<T>,
    limit: i64,
    id_for: F,
) -> (Vec<T>, Option<i64>)
where
    F: Fn(&T) -> i64,
{
    let has_more = rows.len() as i64 > limit;
    let page = rows.into_iter().take(limit as usize).collect::<Vec<_>>();
    let next_cursor = has_more.then(|| page.last().map(id_for)).flatten();
    (page, next_cursor)
}

pub(crate) fn saved_message_row_to_response(
    row: SavedMessage,
    can_locate_context: bool,
) -> Result<SavedMessageResponse, AppError> {
    let attachments = deserialize_snapshot::<Vec<SavedAttachmentSnapshot>>(
        row.snapshot_attachments,
        "attachments",
    )?;
    let sticker = row
        .snapshot_sticker
        .map(|value| deserialize_snapshot::<SavedStickerSnapshot>(value, "sticker"))
        .transpose()?;
    let mentions =
        deserialize_snapshot::<Vec<SavedMentionSnapshot>>(row.snapshot_mentions, "mentions")?
            .into_iter()
            .map(Into::into)
            .collect();
    let sender = deserialize_snapshot::<SavedSenderSnapshot>(row.snapshot_sender, "sender")?;
    let chat = deserialize_snapshot::<SavedChatSnapshot>(row.snapshot_chat, "chat")?;

    Ok(SavedMessageResponse {
        id: row.id,
        original_chat_id: row.original_chat_id,
        original_thread_root_id: row.original_thread_root_id,
        original_message_id: row.original_message_id,
        original_reply_to_message_id: row.original_reply_to_message_id,
        original_sender_uid: row.original_sender_uid,
        original_created_at: row.original_created_at,
        saved_at: row.saved_at,
        message: row.snapshot_message,
        message_type: row.snapshot_message_type,
        attachments,
        sticker,
        mentions,
        sender,
        chat,
        can_locate_context,
    })
}

fn deserialize_snapshot<T: DeserializeOwned>(
    value: serde_json::Value,
    field: &'static str,
) -> Result<T, AppError> {
    serde_json::from_value(value).map_err(|err| {
        tracing::error!(
            field,
            error = ?err,
            "failed to deserialize saved message snapshot"
        );
        AppError::Internal(INVALID_SAVED_MESSAGE_SNAPSHOT)
    })
}

fn snapshot_json<T: Serialize>(
    value: &T,
    field: &'static str,
) -> Result<serde_json::Value, AppError> {
    serde_json::to_value(value).map_err(|err| {
        tracing::error!(
            field,
            error = ?err,
            "failed to serialize saved message snapshot"
        );
        AppError::Internal(INVALID_SAVED_MESSAGE_SNAPSHOT)
    })
}

fn ensure_current_chat_membership(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
) -> Result<(), AppError> {
    let exists = diesel::select(diesel::dsl::exists(
        group_membership::table.filter(
            group_membership::chat_id
                .eq(chat_id)
                .and(group_membership::uid.eq(uid)),
        ),
    ))
    .get_result::<bool>(conn)?;

    if !exists {
        return Err(AppError::Forbidden("Not a member of this group"));
    }

    Ok(())
}

fn load_existing_saved_message(
    conn: &mut PgConnection,
    uid: i32,
    message_id: i64,
) -> Result<Option<SavedMessage>, AppError> {
    saved_messages::table
        .filter(
            saved_messages::uid
                .eq(uid)
                .and(saved_messages::original_message_id.eq(message_id)),
        )
        .select(SavedMessage::as_select())
        .first::<SavedMessage>(conn)
        .optional()
        .map_err(Into::into)
}

fn load_attachment_snapshots(
    conn: &mut PgConnection,
    state: &AppState,
    message: &Message,
) -> Result<Vec<SavedAttachmentSnapshot>, AppError> {
    if !message.has_attachments {
        return Ok(Vec::new());
    }

    let rows = attachments::table
        .filter(
            attachments::message_id
                .eq(message.id)
                .and(attachments::deleted_at.is_null()),
        )
        .order((attachments::order.asc(), attachments::id.asc()))
        .select(Attachment::as_select())
        .load::<Attachment>(conn)?;

    Ok(rows
        .into_iter()
        .map(|attachment| SavedAttachmentSnapshot {
            id: attachment.id,
            external_reference: attachment.external_reference.clone(),
            url: build_public_object_url(state, &attachment.external_reference),
            kind: attachment.kind,
            size: attachment.size,
            file_name: attachment.file_name,
            width: attachment.width,
            height: attachment.height,
            order: attachment.order,
        })
        .collect())
}

fn load_sender_and_mentions_snapshots(
    conn: &mut PgConnection,
    state: &AppState,
    message: &Message,
) -> Result<(SavedSenderSnapshot, Vec<MentionInfo>), AppError> {
    let mention_uids = message
        .message
        .as_deref()
        .map(extract_mention_uids)
        .unwrap_or_default();

    let mut lookup_uids = Vec::with_capacity(mention_uids.len() + 1);
    lookup_uids.push(message.sender_uid);
    for uid in &mention_uids {
        if !lookup_uids.contains(uid) {
            lookup_uids.push(*uid);
        }
    }

    let user_profiles = lookup_user_profiles(conn, &lookup_uids)?;
    let user_avatars = lookup_user_avatars(state, &lookup_uids);
    let sender_profile = user_profiles.get(&message.sender_uid);
    let sender = SavedSenderSnapshot {
        uid: message.sender_uid,
        name: sender_profile.and_then(|profile| profile.username.clone()),
        avatar_url: user_avatars.get(&message.sender_uid).cloned().flatten(),
        gender: sender_profile.map(|profile| profile.gender).unwrap_or(0),
        user_group: sender_profile.and_then(|profile| profile.user_group.clone()),
    };
    let mentions = mention_uids
        .into_iter()
        .map(|uid| build_mention_info(uid, &user_avatars, &user_profiles))
        .collect();

    Ok((sender, mentions))
}

fn load_chat_snapshot(
    conn: &mut PgConnection,
    state: &AppState,
    chat_id: i64,
) -> Result<SavedChatSnapshot, AppError> {
    let group = groups::table
        .filter(groups::id.eq(chat_id))
        .select(Group::as_select())
        .first::<Group>(conn)?;

    let avatar_url = match group.avatar_image_id {
        Some(avatar_image_id) => media::table
            .filter(
                media::id
                    .eq(avatar_image_id)
                    .and(media::deleted_at.is_null()),
            )
            .select(media::storage_key)
            .first::<String>(conn)
            .optional()?
            .map(|storage_key| build_public_object_url(state, &storage_key)),
        None => None,
    };

    Ok(SavedChatSnapshot {
        id: group.id,
        name: group.name,
        avatar_url,
    })
}

fn load_sticker_snapshot(
    conn: &mut PgConnection,
    state: &AppState,
    sticker_id: Option<i64>,
) -> Result<Option<SavedStickerSnapshot>, AppError> {
    let Some(sticker_id) = sticker_id else {
        return Ok(None);
    };

    let row = stickers::table
        .inner_join(media::table)
        .filter(stickers::id.eq(sticker_id))
        .select((Sticker::as_select(), Media::as_select()))
        .first::<(Sticker, Media)>(conn)
        .optional()?;

    Ok(row.map(|(sticker, media_row)| SavedStickerSnapshot {
        id: sticker.id,
        emoji: sticker.emoji,
        name: sticker.name,
        media_url: build_public_object_url(state, &media_row.storage_key),
        media_content_type: media_row.content_type,
    }))
}

struct SavedMessageSnapshotParts {
    attachments: Vec<SavedAttachmentSnapshot>,
    sticker: Option<SavedStickerSnapshot>,
    mentions: Vec<MentionInfo>,
    sender: SavedSenderSnapshot,
    chat: SavedChatSnapshot,
}

fn build_new_saved_message(
    id: i64,
    uid: i32,
    message: &Message,
    snapshots: SavedMessageSnapshotParts,
) -> Result<NewSavedMessage, AppError> {
    Ok(NewSavedMessage {
        id,
        uid,
        original_chat_id: message.chat_id,
        original_thread_root_id: message.reply_root_id,
        original_message_id: message.id,
        original_reply_to_message_id: message.reply_to_id,
        original_sender_uid: message.sender_uid,
        original_created_at: message.created_at,
        saved_at: Utc::now(),
        snapshot_message: message.message.clone(),
        snapshot_message_type: message.message_type.clone(),
        snapshot_attachments: snapshot_json(&snapshots.attachments, "attachments")?,
        snapshot_sticker: snapshots
            .sticker
            .map(|snapshot| snapshot_json(&snapshot, "sticker"))
            .transpose()?,
        snapshot_mentions: snapshot_json(&snapshots.mentions, "mentions")?,
        snapshot_sender: snapshot_json(&snapshots.sender, "sender")?,
        snapshot_chat: snapshot_json(&snapshots.chat, "chat")?,
    })
}

fn load_locatable_chat_ids(
    conn: &mut PgConnection,
    uid: i32,
    rows: &[SavedMessage],
) -> Result<HashSet<i64>, AppError> {
    let chat_ids = rows
        .iter()
        .map(|row| row.original_chat_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    if chat_ids.is_empty() {
        return Ok(HashSet::new());
    }

    group_membership::table
        .filter(
            group_membership::uid
                .eq(uid)
                .and(group_membership::chat_id.eq_any(chat_ids)),
        )
        .select(group_membership::chat_id)
        .load::<i64>(conn)
        .map(|rows| rows.into_iter().collect())
        .map_err(Into::into)
}

pub async fn save_message_snapshot(
    conn: &mut PgConnection,
    state: &AppState,
    uid: i32,
    message_id: i64,
) -> Result<SavedMessageResponse, AppError> {
    let message = messages::table
        .filter(messages::id.eq(message_id))
        .select(Message::as_select())
        .first::<Message>(conn)
        .optional()?
        .ok_or(AppError::NotFound("Message not found"))?;

    ensure_message_can_be_saved(&message)?;
    ensure_current_chat_membership(conn, message.chat_id, uid)?;

    if let Some(existing) = load_existing_saved_message(conn, uid, message_id)? {
        return saved_message_row_to_response(existing, true);
    }

    let attachments = load_attachment_snapshots(conn, state, &message)?;
    let sticker = load_sticker_snapshot(conn, state, message.sticker_id)?;
    let (sender, mentions) = load_sender_and_mentions_snapshots(conn, state, &message)?;
    let chat = load_chat_snapshot(conn, state, message.chat_id)?;

    if let Some(existing) = load_existing_saved_message(conn, uid, message_id)? {
        return saved_message_row_to_response(existing, true);
    }

    let id = match ids::next_message_id(state.id_gen.as_ref()).await {
        Ok(id) => id,
        Err(err) => {
            tracing::error!(error = ?err, "failed to generate saved message id");
            if let Some(existing) = load_existing_saved_message(conn, uid, message_id)? {
                return saved_message_row_to_response(existing, true);
            }
            return Err(AppError::Internal("ID generation failed"));
        }
    };

    let new_saved_message = build_new_saved_message(
        id,
        uid,
        &message,
        SavedMessageSnapshotParts {
            attachments,
            sticker,
            mentions,
            sender,
            chat,
        },
    )?;

    let inserted = diesel::insert_into(saved_messages::table)
        .values(&new_saved_message)
        .on_conflict((saved_messages::uid, saved_messages::original_message_id))
        .do_nothing()
        .returning(SavedMessage::as_returning())
        .get_result::<SavedMessage>(conn)
        .optional()?;

    let row = match inserted {
        Some(row) => row,
        None => load_existing_saved_message(conn, uid, message_id)?
            .ok_or(AppError::Internal("Saved message insert failed"))?,
    };

    saved_message_row_to_response(row, true)
}

pub fn delete_saved_message_by_original(
    conn: &mut PgConnection,
    uid: i32,
    message_id: i64,
) -> Result<(), AppError> {
    diesel::delete(
        saved_messages::table.filter(
            saved_messages::uid
                .eq(uid)
                .and(saved_messages::original_message_id.eq(message_id)),
        ),
    )
    .execute(conn)?;

    Ok(())
}

pub fn delete_saved_message_by_id(
    conn: &mut PgConnection,
    uid: i32,
    saved_message_id: i64,
) -> Result<(), AppError> {
    diesel::delete(
        saved_messages::table.filter(
            saved_messages::uid
                .eq(uid)
                .and(saved_messages::id.eq(saved_message_id)),
        ),
    )
    .execute(conn)?;

    Ok(())
}

pub fn list_saved_messages(
    conn: &mut PgConnection,
    uid: i32,
    chat_id: Option<i64>,
    before: Option<i64>,
    limit: Option<i64>,
) -> Result<ListSavedMessagesResponse, AppError> {
    let limit = saved_messages_limit(limit);
    let mut query = saved_messages::table
        .filter(saved_messages::uid.eq(uid))
        .into_boxed();

    if let Some(chat_id) = chat_id {
        query = query.filter(saved_messages::original_chat_id.eq(chat_id));
    }

    if let Some(before) = before {
        query = query.filter(saved_messages::id.lt(before));
    }

    let rows = query
        .order(saved_messages::id.desc())
        .limit(limit + 1)
        .select(SavedMessage::as_select())
        .load::<SavedMessage>(conn)?;

    let (page_rows, next_cursor) = split_saved_messages_page(rows, limit, |row| row.id);
    let locatable_chat_ids = if chat_id.is_some() {
        page_rows
            .iter()
            .map(|row| row.original_chat_id)
            .collect::<HashSet<_>>()
    } else {
        load_locatable_chat_ids(conn, uid, &page_rows)?
    };
    let saved_messages = page_rows
        .into_iter()
        .map(|row| {
            let can_locate_context = locatable_chat_ids.contains(&row.original_chat_id);
            saved_message_row_to_response(row, can_locate_context)
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(ListSavedMessagesResponse {
        saved_messages,
        next_cursor,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_message_can_be_saved, saved_message_row_to_response, saved_messages_limit,
        split_saved_messages_page, DEFAULT_SAVED_MESSAGES_LIMIT, MAX_SAVED_MESSAGES_LIMIT,
    };
    use crate::{
        errors::AppError,
        models::{Message, MessageType, SavedMessage, TranscodeStatus},
    };
    use chrono::Utc;
    use serde_json::json;

    fn message_for_save() -> Message {
        Message {
            id: 10,
            message: Some("hello".to_string()),
            message_type: MessageType::Text,
            reply_to_id: None,
            reply_root_id: None,
            client_generated_id: "client-id".to_string(),
            sender_uid: 7,
            chat_id: 100,
            created_at: Utc::now(),
            updated_at: None,
            deleted_at: None,
            has_attachments: false,
            has_thread: false,
            has_reactions: false,
            sticker_id: None,
            is_published: true,
            transcode_status: TranscodeStatus::None,
            forwarded_from_message_id: None,
            forwarded_from_chat_id: None,
            forwarded_from_sender_uid: None,
        }
    }

    fn saved_row() -> SavedMessage {
        SavedMessage {
            id: 500,
            uid: 7,
            original_chat_id: 100,
            original_thread_root_id: None,
            original_message_id: 10,
            original_reply_to_message_id: None,
            original_sender_uid: 7,
            original_created_at: Utc::now(),
            saved_at: Utc::now(),
            snapshot_message: Some("hello".to_string()),
            snapshot_message_type: MessageType::Text,
            snapshot_attachments: json!([]),
            snapshot_sticker: None,
            snapshot_mentions: json!([]),
            snapshot_sender: json!({
                "uid": 7,
                "name": "Alice",
                "avatarUrl": "https://example.com/avatar.jpg",
                "gender": 1
            }),
            snapshot_chat: json!({
                "id": "100",
                "name": "General",
                "avatarUrl": null
            }),
        }
    }

    #[test]
    fn ensure_message_can_be_saved_rejects_deleted_messages() {
        let mut message = message_for_save();
        message.deleted_at = Some(Utc::now());

        let err = ensure_message_can_be_saved(&message).expect_err("deleted message rejected");

        assert!(matches!(
            err,
            AppError::BadRequest("Cannot save deleted message")
        ));
    }

    #[test]
    fn ensure_message_can_be_saved_rejects_unpublished_messages() {
        let mut message = message_for_save();
        message.is_published = false;

        let err = ensure_message_can_be_saved(&message).expect_err("unpublished message rejected");

        assert!(matches!(
            err,
            AppError::BadRequest("Cannot save unpublished message")
        ));
    }

    #[test]
    fn ensure_message_can_be_saved_rejects_system_messages() {
        let mut message = message_for_save();
        message.message_type = MessageType::System;

        let err = ensure_message_can_be_saved(&message).expect_err("system message rejected");

        assert!(matches!(
            err,
            AppError::BadRequest("Cannot save system message")
        ));
    }

    #[test]
    fn ensure_message_can_be_saved_allows_published_non_system_messages() {
        for message_type in [
            MessageType::Text,
            MessageType::Audio,
            MessageType::File,
            MessageType::Sticker,
            MessageType::Invite,
        ] {
            let mut message = message_for_save();
            message.message_type = message_type;

            ensure_message_can_be_saved(&message).expect("message can be saved");
        }
    }

    #[test]
    fn saved_messages_limit_defaults_to_thirty_and_caps_to_max() {
        assert_eq!(saved_messages_limit(None), DEFAULT_SAVED_MESSAGES_LIMIT);
        assert_eq!(saved_messages_limit(Some(500)), MAX_SAVED_MESSAGES_LIMIT);
        assert_eq!(saved_messages_limit(Some(0)), 1);
    }

    #[test]
    fn split_saved_messages_page_has_no_cursor_without_extra_row() {
        let (page, next_cursor) = split_saved_messages_page(vec![30, 20], 2, |id| *id);

        assert_eq!(page, vec![30, 20]);
        assert_eq!(next_cursor, None);
    }

    #[test]
    fn split_saved_messages_page_uses_last_returned_id_when_extra_row_exists() {
        let (page, next_cursor) = split_saved_messages_page(vec![30, 20, 10], 2, |id| *id);

        assert_eq!(page, vec![30, 20]);
        assert_eq!(next_cursor, Some(20));
    }

    #[test]
    fn saved_message_row_to_response_returns_internal_error_for_malformed_snapshot_json() {
        let mut row = saved_row();
        row.snapshot_attachments = json!({"not": "a list"});

        let err = saved_message_row_to_response(row, true)
            .expect_err("malformed JSON returns controlled error");

        assert!(matches!(
            err,
            AppError::Internal("Saved message snapshot is invalid")
        ));
    }
}
