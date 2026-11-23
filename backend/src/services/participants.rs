//! Historical authors, independent of present membership and thread subscriptions.
use crate::{dto::chats::ChatParticipantScope, schema::messages};
use diesel::{prelude::*, query_dsl::positional_order_dsl::PositionalOrderDsl};

fn main_authors(chat_id: i64) -> messages::BoxedQuery<'static, diesel::pg::Pg> {
    messages::table.filter(messages::chat_id.eq(chat_id))
        .filter(diesel::dsl::sql::<diesel::sql_types::Bool>(
            "reply_root_id IS NULL AND deleted_at IS NULL AND is_published = TRUE AND message_type <> 'system'",
        )).into_boxed()
}

fn thread_authors(chat_id: i64) -> messages::BoxedQuery<'static, diesel::pg::Pg> {
    // Matches idx_messages_sender_participation, including deleted thread roots.
    messages::table.filter(messages::chat_id.eq(chat_id))
        .filter(diesel::dsl::sql::<diesel::sql_types::Bool>(
            "is_published = TRUE AND ((reply_root_id IS NOT NULL AND deleted_at IS NULL) OR (reply_root_id IS NULL AND has_thread = TRUE))",
        )).into_boxed()
}

fn author_sources(
    chat_id: i64,
    scope: ChatParticipantScope,
) -> Vec<messages::BoxedQuery<'static, diesel::pg::Pg>> {
    match scope {
        ChatParticipantScope::Main => vec![main_authors(chat_id)],
        ChatParticipantScope::Threads => vec![thread_authors(chat_id)],
        ChatParticipantScope::All => vec![main_authors(chat_id), thread_authors(chat_id)],
    }
}

pub fn is_chat_participant(
    conn: &mut PgConnection,
    chat_id: i64,
    scope: ChatParticipantScope,
    uid: i32,
) -> QueryResult<bool> {
    for query in author_sources(chat_id, scope) {
        if diesel::select(diesel::dsl::exists(
            query.filter(messages::sender_uid.eq(uid)),
        ))
        .get_result(conn)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn participant_uids(
    query: messages::BoxedQuery<'static, diesel::pg::Pg>,
    q: Option<&str>,
    cursor: Option<i32>,
    limit: i64,
) -> messages::BoxedQuery<'static, diesel::pg::Pg, diesel::sql_types::Integer> {
    let mut query = crate::services::user::filter_participant_names(query, q);
    if let Some(cursor) = cursor {
        query = query.filter(messages::sender_uid.gt(cursor));
    }
    query
        .select(messages::sender_uid)
        .distinct()
        .order(messages::sender_uid.asc())
        .limit(limit)
}

/// Bound each indexed source before merging. One statement keeps both sources in one snapshot.
pub fn list_chat_participant_uids(
    conn: &mut PgConnection,
    chat_id: i64,
    scope: ChatParticipantScope,
    q: Option<&str>,
    cursor: Option<i32>,
    limit: i64,
) -> QueryResult<Vec<i32>> {
    let mut sources = author_sources(chat_id, scope)
        .into_iter()
        .map(|query| participant_uids(query, q, cursor, limit));
    let first = sources
        .next()
        .expect("every participant scope has an author source");
    match sources.next() {
        Some(second) => first
            .union(second)
            .positional_order_by(1)
            .limit(limit)
            .load(conn),
        None => first.load(conn),
    }
}
