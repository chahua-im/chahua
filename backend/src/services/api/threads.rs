use std::sync::Arc;

use diesel::prelude::*;

use crate::dto::threads::{
    ListChatThreadsQuery, ListChatThreadsResponse, ListThreadParticipantsQuery, ListThreadsQuery,
    ListThreadsResponse, MarkThreadReadBody, MarkThreadReadResponse, ThreadReadStateResponse,
    ThreadSubscriptionStatusResponse, UnreadThreadCountResponse,
};
use crate::errors::AppError;
use crate::models::Message;
use crate::schema::messages;
use crate::services::api::members::check_membership;
use crate::services::avatars::AvatarService;
use crate::services::media::MediaStore;
use crate::services::threads as thread_svc;
use crate::services::unread::UnreadService;
use crate::services::ws_registry::ConnectionRegistry;
use crate::utils::pagination::validate_limit;

pub fn get_threads(
    uid: i32,
    query: ListThreadsQuery,
    conn: &mut PgConnection,
    media: &MediaStore,
    avatars: &AvatarService,
) -> Result<ListThreadsResponse, AppError> {
    let limit = validate_limit(query.limit.or(Some(20)), 50);
    let archived = query.archived.unwrap_or(false);
    let rows =
        thread_svc::get_user_threads(conn, uid, limit + 1, query.before, archived, query.root_id)?;

    let has_more = rows.len() as i64 > limit;
    let rows: Vec<_> = rows.into_iter().take(limit as usize).collect();
    let root_ids: Vec<i64> = rows.iter().map(|row| row.thread_root_id).collect();

    if root_ids.is_empty() {
        return Ok(ListThreadsResponse {
            threads: vec![],
            next_cursor: None,
        });
    }

    let root_messages: Vec<Message> = messages::table
        .filter(messages::id.eq_any(&root_ids))
        .filter(messages::reply_root_id.is_null())
        .filter(messages::has_thread.eq(true))
        .filter(messages::is_published.eq(true))
        .select(Message::as_select())
        .load(conn)?;

    Ok(thread_svc::enrich_thread_list(
        conn,
        rows,
        has_more,
        root_messages,
        uid,
        media,
        avatars,
    )?)
}

pub async fn get_chat_threads(
    uid: i32,
    chat_id: i64,
    query: ListChatThreadsQuery,
    conn: &mut PgConnection,
    media: &MediaStore,
    avatars: &AvatarService,
) -> Result<ListChatThreadsResponse, AppError> {
    check_membership(conn, chat_id, uid)?;
    let limit = validate_limit(query.limit.or(Some(20)), 100);
    let mut roots =
        thread_svc::get_chat_threads(conn, chat_id, query.cursor, query.order, limit + 1)?;
    let has_more = roots.len() as i64 > limit;
    roots.truncate(limit as usize);
    let next_cursor = has_more.then(|| roots.last().unwrap().id.to_string());
    let threads =
        crate::services::messages::attach_metadata(conn, roots, media, avatars, uid).await;
    Ok(ListChatThreadsResponse {
        threads,
        next_cursor,
    })
}

pub fn get_thread_participants(
    uid: i32,
    chat_id: i64,
    thread_root_id: i64,
    query: ListThreadParticipantsQuery,
    conn: &mut PgConnection,
    avatars: &AvatarService,
) -> Result<crate::dto::chats::ListParticipantsResponse, AppError> {
    authorize_thread_in_chat(conn, chat_id, thread_root_id, uid)?;
    let exists = diesel::select(diesel::dsl::exists(
        messages::table
            .filter(messages::id.eq(thread_root_id))
            .filter(messages::has_thread.eq(true))
            .filter(messages::is_published.eq(true)),
    ))
    .get_result::<bool>(conn)?;
    if !exists {
        return Err(AppError::NotFound("Thread root message not found"));
    }
    let limit = validate_limit(query.limit, 100);
    let uids = thread_svc::get_thread_participant_uids(
        conn,
        thread_root_id,
        query.q.as_deref(),
        query.cursor,
        limit + 1,
    )?;
    crate::services::api::chats::participants::build_participants_response(
        conn, avatars, uids, limit,
    )
}

/// Resolve `chat_id` from a thread root message ID, or return 404.
///
/// This only locates the thread's chat; it performs no authorization. Callers
/// MUST pass the resolved `chat_id` to `check_membership` before reading or
/// writing any thread state.
fn resolve_chat_id_for_thread(
    conn: &mut PgConnection,
    thread_root_id: i64,
) -> Result<i64, AppError> {
    messages::table
        .filter(messages::id.eq(thread_root_id))
        .select(messages::chat_id)
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Thread root message not found"))
}

/// Authorize `uid` for `thread_root_id` **within an explicitly supplied
/// `chat_id`**, rejecting a mismatch or a reply ID with 404.
///
/// Membership is verified before the thread lookup on purpose: a non-member
/// then receives 403 for every thread root alike, so the mismatch 404 cannot
/// be used to probe which chat a thread belongs to. Reversing the order would
/// let an outsider distinguish "root lives in this chat" (403) from "root
/// lives elsewhere" (404).
pub(crate) fn authorize_thread_in_chat(
    conn: &mut PgConnection,
    chat_id: i64,
    thread_root_id: i64,
    uid: i32,
) -> Result<(), AppError> {
    check_membership(conn, chat_id, uid)?;

    let belongs_to_chat: bool = diesel::select(diesel::dsl::exists(
        messages::table.filter(
            messages::id
                .eq(thread_root_id)
                .and(messages::chat_id.eq(chat_id))
                .and(messages::reply_root_id.is_null()),
        ),
    ))
    .get_result(conn)?;

    if !belongs_to_chat {
        return Err(AppError::NotFound("Thread root message not found"));
    }

    Ok(())
}

struct AppliedThreadRead {
    response: MarkThreadReadResponse,
    receipt_advanced: bool,
}

fn load_thread_read_state(
    conn: &mut PgConnection,
    unread_service: &UnreadService,
    chat_id: i64,
    thread_root_id: i64,
    uid: i32,
) -> Result<ThreadReadStateResponse, AppError> {
    let last_read_message_id =
        thread_svc::get_thread_last_read_message_id(conn, chat_id, thread_root_id, uid)?;
    Ok(ThreadReadStateResponse {
        last_read_message_id,
        unread_count: thread_svc::get_thread_unread_count(
            conn,
            thread_root_id,
            uid,
            last_read_message_id,
        )?,
        unread_mentions: unread_service.count_chat_unread_mentions(
            conn,
            uid,
            chat_id,
            last_read_message_id,
            Some(thread_root_id),
        )?,
        unread_reactions: unread_service.count_chat_unread_reactions(
            conn,
            uid,
            chat_id,
            Some(thread_root_id),
        )?,
    })
}

fn apply_thread_read(
    conn: &mut PgConnection,
    unread_service: &UnreadService,
    chat_id: i64,
    thread_root_id: i64,
    uid: i32,
    message_id: i64,
) -> Result<AppliedThreadRead, AppError> {
    if message_id == thread_root_id {
        crate::services::read_receipts::validate_thread_root_read_target(
            conn,
            chat_id,
            thread_root_id,
        )?;
        let unread_reactions =
            unread_service.count_chat_unread_reactions(conn, uid, chat_id, Some(thread_root_id))?;
        return Ok(AppliedThreadRead {
            response: MarkThreadReadResponse {
                last_read_message_id: None,
                unread_count: 0,
                unread_mentions: 0,
                unread_reactions,
            },
            receipt_advanced: false,
        });
    }

    crate::services::read_receipts::validate_thread_read_target(
        conn,
        chat_id,
        thread_root_id,
        message_id,
    )?;
    let _ = thread_svc::ensure_thread_user_state(conn, chat_id, thread_root_id, uid, false)?;
    let read_state = thread_svc::mark_thread_read(conn, chat_id, thread_root_id, uid, message_id)?;
    let unread_mentions = unread_service.count_chat_unread_mentions(
        conn,
        uid,
        chat_id,
        read_state.last_read_message_id,
        Some(thread_root_id),
    )?;
    let unread_reactions =
        unread_service.count_chat_unread_reactions(conn, uid, chat_id, Some(thread_root_id))?;

    Ok(AppliedThreadRead {
        response: MarkThreadReadResponse {
            last_read_message_id: read_state.last_read_message_id,
            unread_count: read_state.unread_count,
            unread_mentions,
            unread_reactions,
        },
        receipt_advanced: read_state.receipt_advanced,
    })
}

fn publish_thread_read(
    conn: &mut PgConnection,
    ws_registry: &Arc<ConnectionRegistry>,
    uid: i32,
    chat_id: i64,
    thread_root_id: i64,
    applied: AppliedThreadRead,
) -> Result<MarkThreadReadResponse, AppError> {
    if applied.receipt_advanced {
        crate::services::read_receipts::broadcast_read_receipt_changed_if_dm(
            conn,
            ws_registry,
            chat_id,
            false,
            Some(uid),
            Some(thread_root_id),
        )?;
    }
    ws_registry.invalidate_unread(&[uid]);
    Ok(applied.response)
}

/// Legacy top-level operation. It deliberately resolves the chat before its
/// membership check rather than applying chat-scoped root authorization.
pub fn mark_thread_read(
    uid: i32,
    thread_root_id: i64,
    body: MarkThreadReadBody,
    conn: &mut PgConnection,
    unread_service: &UnreadService,
    ws_registry: &Arc<ConnectionRegistry>,
) -> Result<MarkThreadReadResponse, AppError> {
    let chat_id = resolve_chat_id_for_thread(conn, thread_root_id)?;
    check_membership(conn, chat_id, uid)?;
    let applied = apply_thread_read(
        conn,
        unread_service,
        chat_id,
        thread_root_id,
        uid,
        body.message_id,
    )?;
    publish_thread_read(conn, ws_registry, uid, chat_id, thread_root_id, applied)
}

/// Legacy top-level operation. It deliberately resolves the chat before its
/// membership check rather than applying chat-scoped root authorization.
pub fn get_thread_read_state(
    uid: i32,
    thread_root_id: i64,
    conn: &mut PgConnection,
    unread_service: &UnreadService,
) -> Result<ThreadReadStateResponse, AppError> {
    let chat_id = resolve_chat_id_for_thread(conn, thread_root_id)?;
    check_membership(conn, chat_id, uid)?;
    load_thread_read_state(conn, unread_service, chat_id, thread_root_id, uid)
}

pub fn get_unread_thread_count(
    uid: i32,
    conn: &mut PgConnection,
) -> Result<UnreadThreadCountResponse, AppError> {
    let counts = thread_svc::get_unread_summary_counts(conn, uid)?;
    Ok(UnreadThreadCountResponse {
        unread_thread_count: counts.unread_thread_count,
        archived_unread_thread_count: counts.archived_unread_thread_count,
        unread_message_count: counts.unread_message_count,
        archived_unread_message_count: counts.archived_unread_message_count,
    })
}

pub fn mark_thread_read_in_chat(
    uid: i32,
    chat_id: i64,
    thread_root_id: i64,
    body: MarkThreadReadBody,
    conn: &mut PgConnection,
    unread_service: &UnreadService,
    ws_registry: &Arc<ConnectionRegistry>,
) -> Result<MarkThreadReadResponse, AppError> {
    authorize_thread_in_chat(conn, chat_id, thread_root_id, uid)?;
    let applied = apply_thread_read(
        conn,
        unread_service,
        chat_id,
        thread_root_id,
        uid,
        body.message_id,
    )?;
    publish_thread_read(conn, ws_registry, uid, chat_id, thread_root_id, applied)
}

pub fn get_thread_read_state_in_chat(
    uid: i32,
    chat_id: i64,
    thread_root_id: i64,
    conn: &mut PgConnection,
    unread_service: &UnreadService,
) -> Result<ThreadReadStateResponse, AppError> {
    authorize_thread_in_chat(conn, chat_id, thread_root_id, uid)?;
    load_thread_read_state(conn, unread_service, chat_id, thread_root_id, uid)
}

pub fn subscribe_thread(
    uid: i32,
    chat_id: i64,
    thread_root_id: i64,
    conn: &mut PgConnection,
    ws_registry: &Arc<ConnectionRegistry>,
) -> Result<(), AppError> {
    check_membership(conn, chat_id, uid)?;

    let exists: bool = diesel::select(diesel::dsl::exists(
        messages::table.filter(
            messages::id
                .eq(thread_root_id)
                .and(messages::chat_id.eq(chat_id))
                .and(messages::deleted_at.is_null())
                .and(messages::is_published.eq(true)),
        ),
    ))
    .get_result(conn)?;

    if !exists {
        return Err(AppError::NotFound("Thread root message not found"));
    }

    let inserted = thread_svc::ensure_thread_subscription(conn, chat_id, thread_root_id, uid)?;
    if inserted {
        thread_svc::broadcast_thread_membership_changed_to_user(
            conn,
            ws_registry,
            uid,
            chat_id,
            thread_root_id,
        )?;
        thread_svc::broadcast_thread_update_to_uids(
            conn,
            ws_registry,
            &[uid],
            chat_id,
            thread_root_id,
        )?;
    }

    Ok(())
}

pub fn unsubscribe_thread(
    uid: i32,
    chat_id: i64,
    thread_root_id: i64,
    conn: &mut PgConnection,
    ws_registry: &Arc<ConnectionRegistry>,
) -> Result<(), AppError> {
    check_membership(conn, chat_id, uid)?;

    let removed = thread_svc::unsubscribe_from_thread(conn, chat_id, thread_root_id, uid)?;
    if removed {
        thread_svc::broadcast_thread_membership_changed_to_user(
            conn,
            ws_registry,
            uid,
            chat_id,
            thread_root_id,
        )?;
    }

    Ok(())
}

pub fn get_subscription_status(
    uid: i32,
    chat_id: i64,
    thread_root_id: i64,
    conn: &mut PgConnection,
) -> Result<ThreadSubscriptionStatusResponse, AppError> {
    check_membership(conn, chat_id, uid)?;

    let state = thread_svc::get_subscription_state(conn, chat_id, thread_root_id, uid)?;
    let (subscribed, archived) = match state {
        Some((archived, subscribed)) => (subscribed, archived),
        None => (false, false),
    };

    Ok(ThreadSubscriptionStatusResponse {
        subscribed,
        archived,
    })
}

pub fn archive_thread(
    uid: i32,
    chat_id: i64,
    thread_root_id: i64,
    conn: &mut PgConnection,
    ws_registry: &Arc<ConnectionRegistry>,
) -> Result<(), AppError> {
    check_membership(conn, chat_id, uid)?;

    let updated = thread_svc::archive_thread(conn, chat_id, thread_root_id, uid)?;
    if updated {
        thread_svc::broadcast_thread_membership_changed_to_user(
            conn,
            ws_registry,
            uid,
            chat_id,
            thread_root_id,
        )?;
    }

    Ok(())
}

pub fn unarchive_thread(
    uid: i32,
    chat_id: i64,
    thread_root_id: i64,
    conn: &mut PgConnection,
    ws_registry: &Arc<ConnectionRegistry>,
) -> Result<(), AppError> {
    check_membership(conn, chat_id, uid)?;

    let updated = thread_svc::unarchive_thread(conn, chat_id, thread_root_id, uid)?;
    if updated {
        thread_svc::broadcast_thread_membership_changed_to_user(
            conn,
            ws_registry,
            uid,
            chat_id,
            thread_root_id,
        )?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::connection::SimpleConnection;

    #[test]
    fn thread_read_state_serializes_counters_without_losing_the_cursor() {
        let response = ThreadReadStateResponse {
            last_read_message_id: Some(9_007_199_254_740_993),
            unread_count: 3,
            unread_mentions: 1,
            unread_reactions: 0,
        };
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            serde_json::json!({
                "lastReadMessageId": "9007199254740993", "unreadCount": 3,
                "unreadMentions": 1, "unreadReactions": 0,
            })
        );
    }

    #[test]
    fn thread_authorization_rejects_replies_and_checks_membership_first() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        let result = conn.transaction::<(), diesel::result::Error, _>(|conn| {
            conn.batch_execute(
                "INSERT INTO groups (id, name) VALUES (9876720000, 'thread-auth-test'), (9876720003, 'other-chat');
                 INSERT INTO group_membership (chat_id, uid) VALUES (9876720000, 4307), (9876720003, 4307);
                 INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at)
                     VALUES (9876720001, 'text', 'thread-auth-root', 4307, 9876720000, NOW());
                 INSERT INTO messages (id, message_type, client_generated_id, sender_uid, chat_id, created_at, reply_root_id)
                     VALUES (9876720002, 'text', 'thread-auth-reply', 4307, 9876720000, NOW(), 9876720001);"
            )?;
            assert!(authorize_thread_in_chat(conn, 9876720000, 9876720001, 4307).is_ok());
            assert!(matches!(authorize_thread_in_chat(conn, 9876720000, 9876720002, 4307), Err(AppError::NotFound(_))));
            assert!(matches!(authorize_thread_in_chat(conn, 9876720003, 9876720001, 4307), Err(AppError::NotFound(_))));
            for id in [9876720001, 9876720002, 9876720099] {
                assert!(matches!(authorize_thread_in_chat(conn, 9876720000, id, 4308), Err(AppError::Forbidden(_))));
            }
            conn.batch_execute(
                "INSERT INTO thread_user_states (chat_id, thread_root_id, uid, last_read_message_id)
                    VALUES (9876720000, 9876720001, 4307, 9876720001);
                 INSERT INTO message_mentions (message_id, mentioned_uid, chat_id, thread_root_id, created_at)
                    VALUES (9876720002, 4307, 9876720000, 9876720001, NOW());"
            )?;
            let state = load_thread_read_state(conn, &UnreadService::new(), 9876720000, 9876720001, 4307).unwrap();
            assert_eq!((state.unread_count, state.unread_mentions, state.unread_reactions), (1, 1, 0));
            assert_eq!(state.last_read_message_id, Some(9876720001));
            assert_eq!(thread_svc::get_thread_last_read_message_id(conn, 9876720000, 9876720001, 4307)?, Some(9876720001));
            Err(diesel::result::Error::RollbackTransaction)
        });
        assert!(matches!(
            result,
            Err(diesel::result::Error::RollbackTransaction)
        ));
    }
}
