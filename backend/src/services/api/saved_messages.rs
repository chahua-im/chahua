use diesel::PgConnection;

use crate::dto::messages::ForwardedMessagesResponse;
use crate::dto::saved_messages::{
    ListSavedMessagesQuery, ListSavedMessagesResponse, SavedMessageResponse,
};
use crate::errors::AppError;
use crate::services::avatars::AvatarService;
use crate::services::media::MediaStore;
use crate::services::messages::{
    deserialize_forwarded_bundle_payload, forwarded_messages_response_from_items,
    load_forwarded_bundle, load_target_forwarded_bundle_from_root,
};
use crate::services::saved_messages;
use crate::utils::ids::IdGen;

pub fn list_saved_messages(
    uid: i32,
    query: ListSavedMessagesQuery,
    conn: &mut PgConnection,
) -> Result<ListSavedMessagesResponse, AppError> {
    saved_messages::list_saved_messages(conn, uid, None, query.before, query.limit)
}

pub async fn put_saved_message(
    uid: i32,
    message_id: i64,
    conn: &mut PgConnection,
    media: &MediaStore,
    avatars: &AvatarService,
    id_gen: &IdGen,
) -> Result<SavedMessageResponse, AppError> {
    saved_messages::save_message_snapshot(conn, media, avatars, id_gen, uid, message_id).await
}

pub fn delete_saved_message_by_original(
    uid: i32,
    message_id: i64,
    conn: &mut PgConnection,
) -> Result<(), AppError> {
    saved_messages::delete_saved_message_by_original(conn, uid, message_id)
}

pub fn delete_saved_message_by_id(
    uid: i32,
    saved_message_id: i64,
    conn: &mut PgConnection,
) -> Result<(), AppError> {
    saved_messages::delete_saved_message_by_id(conn, uid, saved_message_id)
}

pub fn get_saved_forwarded_messages(
    uid: i32,
    saved_message_id: i64,
    conn: &mut PgConnection,
    media: &MediaStore,
    avatars: &AvatarService,
) -> Result<ForwardedMessagesResponse, AppError> {
    let bundle_id = saved_messages::load_saved_forwarded_bundle_id(conn, uid, saved_message_id)?;
    let bundle = load_forwarded_bundle(conn, bundle_id)?;
    let (total, items) = deserialize_forwarded_bundle_payload(bundle)?;
    Ok(forwarded_messages_response_from_items(
        conn, media, avatars, uid, total, items,
    ))
}

pub fn get_saved_forwarded_bundle_messages(
    uid: i32,
    saved_message_id: i64,
    bundle_id: i64,
    conn: &mut PgConnection,
    media: &MediaStore,
    avatars: &AvatarService,
) -> Result<ForwardedMessagesResponse, AppError> {
    let root_bundle_id =
        saved_messages::load_saved_forwarded_bundle_id(conn, uid, saved_message_id)?;
    let bundle = load_target_forwarded_bundle_from_root(conn, root_bundle_id, bundle_id)?;
    let (total, items) = deserialize_forwarded_bundle_payload(bundle)?;
    Ok(forwarded_messages_response_from_items(
        conn, media, avatars, uid, total, items,
    ))
}
