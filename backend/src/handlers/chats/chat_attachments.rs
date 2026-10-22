use axum::{
    extract::{Path, Query, State},
    Json,
};
use chrono::{DateTime, Utc};
use diesel::{pg::Pg, prelude::*};
use utoipa_axum::router::OpenApiRouter;

use crate::{
    dto::attachments::{
        ChatAttachmentKindFilter, ChatAttachmentResponse, ListChatAttachmentsResponse,
    },
    errors::AppError,
    extractors::DbConn,
    handlers::{chats::ChatIdPath, members::check_membership},
    models::Attachment,
    schema::{attachments, messages},
    services::user::lookup_user_profiles,
    utils::{auth::CurrentUid, pagination::validate_limit},
    AppState, MAX_CHAT_ATTACHMENTS_LIMIT,
};

use crate::services::messages::build_sender;

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListChatAttachmentsQuery {
    kind: ChatAttachmentKindFilter,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    before: Option<i64>,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    after: Option<i64>,
}

#[derive(Debug, Clone)]
struct AttachmentMessageRow {
    message_id: i64,
    sender_uid: i32,
    message_created_at: DateTime<Utc>,
}

type AttachmentBoxedQuery<'a> = attachments::BoxedQuery<'a, Pg>;

const MAX_ATTACHMENTS_PER_MESSAGE: i64 = 20;

fn apply_kind_filter<'a>(
    query: AttachmentBoxedQuery<'a>,
    kind: ChatAttachmentKindFilter,
) -> AttachmentBoxedQuery<'a> {
    use crate::schema::attachments::dsl as a_dsl;

    match kind {
        ChatAttachmentKindFilter::Image => query.filter(a_dsl::kind.like("image/%")),
        ChatAttachmentKindFilter::Video => query.filter(a_dsl::kind.like("video/%")),
        ChatAttachmentKindFilter::Other => query
            .filter(a_dsl::kind.not_like("image/%"))
            .filter(a_dsl::kind.not_like("video/%")),
        ChatAttachmentKindFilter::All => query,
    }
}

fn load_attachment_messages(
    conn: &mut PgConnection,
    chat_id: i64,
    kind: ChatAttachmentKindFilter,
    limit: i64,
    before: Option<i64>,
    after: Option<i64>,
) -> QueryResult<(Vec<AttachmentMessageRow>, bool)> {
    use crate::schema::attachments::dsl as a_dsl;
    use crate::schema::messages::dsl as m_dsl;

    let mut query = messages::table
        .inner_join(attachments::table.on(a_dsl::message_id.eq(m_dsl::id.nullable())))
        .into_boxed::<Pg>()
        .filter(m_dsl::chat_id.eq(chat_id))
        .filter(m_dsl::deleted_at.is_null())
        .filter(m_dsl::is_published.eq(true))
        .filter(m_dsl::has_attachments.eq(true))
        .filter(a_dsl::deleted_at.is_null());

    query = match kind {
        ChatAttachmentKindFilter::Image => query.filter(a_dsl::kind.like("image/%")),
        ChatAttachmentKindFilter::Video => query.filter(a_dsl::kind.like("video/%")),
        ChatAttachmentKindFilter::Other => query
            .filter(a_dsl::kind.not_like("image/%"))
            .filter(a_dsl::kind.not_like("video/%")),
        ChatAttachmentKindFilter::All => query,
    };

    // Bound both merge-join inputs so attachments can seek to the cursor too.
    if let Some(before) = before {
        query = query
            .filter(m_dsl::id.lt(before))
            .filter(a_dsl::message_id.lt(before));
    }
    if let Some(after) = after {
        query = query
            .filter(m_dsl::id.gt(after))
            .filter(a_dsl::message_id.gt(after));
    }

    let ascending = after.is_some();
    if ascending {
        query = query.order(m_dsl::id.asc());
    } else {
        query = query.order(m_dsl::id.desc());
    }

    let rows: Vec<(i64, i32, DateTime<Utc>, i64)> = query
        .limit(limit + MAX_ATTACHMENTS_PER_MESSAGE + 1)
        .select((m_dsl::id, m_dsl::sender_uid, m_dsl::created_at, a_dsl::id))
        .load(conn)?;

    let mut messages = Vec::new();
    let mut seen_message_ids = std::collections::HashSet::new();
    let mut selected_attachment_count = 0_i64;
    let mut final_message_id = None;
    let mut has_more = false;

    for (message_id, sender_uid, message_created_at, _attachment_id) in rows {
        if let Some(done_message_id) = final_message_id {
            if message_id != done_message_id {
                has_more = true;
                break;
            }
        }

        if seen_message_ids.insert(message_id) {
            messages.push(AttachmentMessageRow {
                message_id,
                sender_uid,
                message_created_at,
            });
        }
        selected_attachment_count += 1;

        if selected_attachment_count >= limit {
            final_message_id = Some(message_id);
        }
    }

    messages.sort_by_key(|message| std::cmp::Reverse(message.message_id));

    Ok((messages, has_more))
}

fn load_matching_attachments(
    conn: &mut PgConnection,
    message_ids: &[i64],
    kind: ChatAttachmentKindFilter,
) -> QueryResult<Vec<Attachment>> {
    use crate::schema::attachments::dsl as a_dsl;

    if message_ids.is_empty() {
        return Ok(Vec::new());
    }

    apply_kind_filter(
        attachments::table
            .into_boxed::<Pg>()
            .filter(a_dsl::message_id.eq_any(message_ids))
            .filter(a_dsl::deleted_at.is_null()),
        kind,
    )
    .order((
        a_dsl::message_id.desc(),
        a_dsl::order.asc(),
        a_dsl::id.asc(),
    ))
    .select(Attachment::as_select())
    .load(conn)
}

fn attachment_cursors(
    messages: &[AttachmentMessageRow],
    has_more: bool,
    before: Option<i64>,
    after: Option<i64>,
) -> (Option<i64>, Option<i64>) {
    let newest = messages.first().map(|message| message.message_id);
    let oldest = messages.last().map(|message| message.message_id);

    let older_cursor = if has_more || after.is_some() {
        oldest
    } else {
        None
    };
    let newer_cursor = if has_more && after.is_some() || before.is_some() {
        newest
    } else {
        None
    };

    (older_cursor, newer_cursor)
}

/// GET /chats/:chat_id/attachments — List chat attachments by media kind.
#[utoipa::path(
    get,
    path = "/",
    tag = "chats",
    params(
        ("chat_id" = String, Path, description = "Chat ID"),
        ("kind" = ChatAttachmentKindFilter, Query, description = "Required attachment kind filter: image, video, other, or all"),
        ("limit" = Option<i64>, Query, description = "Target minimum number of attachments to return. The response can exceed this value so attachments from one message are not split across pages."),
        ("before" = Option<String>, Query, description = "Fetch older attachments before this message ID cursor. Use olderCursor from the previous response."),
        ("after" = Option<String>, Query, description = "Fetch newer attachments after this message ID cursor. Use newerCursor from the previous response."),
    ),
    responses(
        (status = 200, description = "List of chat attachments. olderCursor fetches older pages via before; newerCursor fetches newer pages via after. A null cursor means no more currently known results in that direction.", body = ListChatAttachmentsResponse),
    ),
    security(("bearer_jwt" = [])),
)]
async fn get_chat_attachments(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Query(q): Query<ListChatAttachmentsQuery>,
) -> Result<Json<ListChatAttachmentsResponse>, AppError> {
    let conn = &mut *conn;

    if q.before.is_some() && q.after.is_some() {
        return Err(AppError::BadRequest(
            "before and after cursors are mutually exclusive",
        ));
    }

    check_membership(conn, chat_id, uid)?;

    let limit = validate_limit(q.limit, MAX_CHAT_ATTACHMENTS_LIMIT);
    let (message_rows, has_more) =
        load_attachment_messages(conn, chat_id, q.kind, limit, q.before, q.after)?;
    let message_ids: Vec<i64> = message_rows
        .iter()
        .map(|message| message.message_id)
        .collect();
    let attachments = load_matching_attachments(conn, &message_ids, q.kind)?;
    let (older_cursor, newer_cursor) =
        attachment_cursors(&message_rows, has_more, q.before, q.after);

    let sender_uids: Vec<i32> = message_rows
        .iter()
        .map(|message| message.sender_uid)
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    let user_avatars = state.avatars.lookup(&sender_uids);
    let user_profiles = lookup_user_profiles(conn, &sender_uids).unwrap_or_default();
    let message_map: std::collections::HashMap<i64, AttachmentMessageRow> = message_rows
        .into_iter()
        .map(|message| (message.message_id, message))
        .collect();

    let mut response_attachments = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        let Some(message_id) = attachment.message_id else {
            continue;
        };
        let Some(message) = message_map.get(&message_id) else {
            continue;
        };

        response_attachments.push(ChatAttachmentResponse {
            id: attachment.id,
            message_id,
            message_created_at: message.message_created_at,
            sender: build_sender(message.sender_uid, &user_avatars, &user_profiles),
            url: state.media.public_url(&attachment.external_reference),
            kind: attachment.kind,
            size: attachment.size,
            file_name: attachment.file_name,
            width: attachment.width,
            height: attachment.height,
            order: attachment.order,
        });
    }

    Ok(Json(ListChatAttachmentsResponse {
        attachments: response_attachments,
        older_cursor,
        newer_cursor,
    }))
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new().routes(utoipa_axum::routes!(get_chat_attachments))
}

#[cfg(test)]
mod tests {
    use super::{attachment_cursors, load_attachment_messages, AttachmentMessageRow};
    use crate::dto::attachments::ChatAttachmentKindFilter;
    use chrono::Utc;
    use diesel::{connection::SimpleConnection, Connection, PgConnection};

    fn row(message_id: i64) -> AttachmentMessageRow {
        AttachmentMessageRow {
            message_id,
            sender_uid: 1,
            message_created_at: Utc::now(),
        }
    }

    #[test]
    fn attachment_pages_preserve_message_groups_and_exclude_cursor_boundaries() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.begin_test_transaction().unwrap();
        conn.batch_execute(
            "CREATE TEMP TABLE messages (
                id bigint PRIMARY KEY, chat_id bigint NOT NULL, sender_uid int NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
                is_published boolean NOT NULL DEFAULT true,
                has_attachments boolean NOT NULL DEFAULT true
             ) ON COMMIT DROP;
             CREATE TEMP TABLE attachments (
                id bigint PRIMARY KEY, message_id bigint, kind text NOT NULL,
                deleted_at timestamptz
             ) ON COMMIT DROP;
             INSERT INTO messages (id, chat_id, sender_uid)
                VALUES (10, 1, 1), (20, 1, 1), (30, 1, 1), (40, 1, 1), (50, 1, 1),
                       (60, 2, 1);
             INSERT INTO attachments (id, message_id, kind, deleted_at) VALUES
                (1, 10, 'image/jpeg', NULL),
                (2, 20, 'image/jpeg', NULL),
                (3, 20, 'image/png', NULL),
                (4, 30, 'image/jpeg', now()),
                (5, 40, 'video/mp4', NULL),
                (6, 50, 'image/jpeg', NULL),
                (7, 60, 'image/jpeg', NULL);",
        )
        .unwrap();

        for (before, after, expected_ids, expected_more) in [
            (None, None, vec![50], true),
            (Some(50), None, vec![20], true),
            (Some(20), None, vec![10], false),
            (None, Some(10), vec![20], true),
            (None, Some(20), vec![50], false),
            (None, Some(50), vec![], false),
        ] {
            let (rows, has_more) = load_attachment_messages(
                &mut conn,
                1,
                ChatAttachmentKindFilter::Image,
                1,
                before,
                after,
            )
            .unwrap();
            let ids: Vec<_> = rows.iter().map(|row| row.message_id).collect();
            assert_eq!(ids, expected_ids, "before={before:?}, after={after:?}");
            assert_eq!(
                has_more, expected_more,
                "before={before:?}, after={after:?}"
            );
        }
    }

    #[test]
    fn cursors_for_initial_page_only_include_older_when_more_exists() {
        let rows = vec![row(30), row(20), row(10)];
        assert_eq!(
            attachment_cursors(&rows, true, None, None),
            (Some(10), None)
        );
        assert_eq!(attachment_cursors(&rows, false, None, None), (None, None));
    }

    #[test]
    fn cursors_for_before_page_include_newer_cursor() {
        let rows = vec![row(20), row(10)];
        assert_eq!(
            attachment_cursors(&rows, false, Some(30), None),
            (None, Some(20))
        );
    }

    #[test]
    fn cursors_for_after_page_include_older_cursor() {
        let rows = vec![row(30), row(20)];
        assert_eq!(
            attachment_cursors(&rows, false, None, Some(10)),
            (Some(20), None)
        );
        assert_eq!(
            attachment_cursors(&rows, true, None, Some(10)),
            (Some(20), Some(30))
        );
    }
}
