use diesel::PgConnection;

use crate::dto::saved_messages::{ListSavedMessagesQuery, ListSavedMessagesResponse};
use crate::errors::AppError;
use crate::services::api::members::check_membership;
use crate::services::saved_messages;

pub fn list_chat_saved_messages(
    uid: i32,
    chat_id: i64,
    query: ListSavedMessagesQuery,
    conn: &mut PgConnection,
) -> Result<ListSavedMessagesResponse, AppError> {
    check_membership(conn, chat_id, uid)?;
    saved_messages::list_saved_messages(conn, uid, Some(chat_id), query.before, query.limit)
}
