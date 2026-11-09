//! Structured history filtering does not depend on the text search index.
use super::{MessageSearchFilters, MessageSearchRange};
use crate::{
    models::{Message, MessageType},
    schema::messages,
};
use diesel::{prelude::*, PgConnection};

fn base(filters: MessageSearchFilters) -> messages::BoxedQuery<'static, diesel::pg::Pg> {
    let mut query = messages::table
        .filter(messages::deleted_at.is_null())
        .filter(messages::is_published.eq(true))
        .filter(messages::message_type.ne(MessageType::System))
        .into_boxed();
    if let Some(from) = filters.created_from {
        query = query.filter(messages::created_at.ge(from));
    }
    if let Some(before) = filters.created_before {
        query = query.filter(messages::created_at.lt(before));
    }
    if let Some(uid) = filters.sender_uid {
        query = query.filter(messages::sender_uid.eq(uid));
    }
    query
}

pub fn load_filtered_messages(
    conn: &mut PgConnection,
    uid: i32,
    chat_id: Option<i64>,
    filters: MessageSearchFilters,
    limit: i64,
    offset: i64,
) -> QueryResult<Vec<Message>> {
    if let Some(chat_id) = chat_id {
        // Keep authorization in the actual read as well as the API precheck.
        let query = || {
            base(filters).filter(messages::chat_id.eq(chat_id)).filter(
                messages::chat_id.eq_any(crate::services::chat_access::accessible_chat_ids(uid)),
            )
        };
        if let MessageSearchRange::Thread(root) = filters.range {
            // Two index seeks avoid an OR over root PK and reply_root_id.
            let mut rows = query()
                .filter(messages::reply_root_id.eq(root))
                .order((messages::created_at.desc(), messages::id.desc()))
                .limit(offset + limit + 1)
                .select(Message::as_select())
                .load::<Message>(conn)?;
            rows.extend(
                query()
                    .filter(messages::id.eq(root))
                    .select(Message::as_select())
                    .load::<Message>(conn)?,
            );
            rows.sort_by_key(|m| std::cmp::Reverse((m.created_at, m.id)));
            return Ok(rows
                .into_iter()
                .skip(offset as usize)
                .take((limit + 1) as usize)
                .collect());
        }
        let mut query = query();
        if filters.range == MessageSearchRange::Main {
            query = query.filter(messages::reply_root_id.is_null());
        }
        return query
            .order((messages::created_at.desc(), messages::id.desc()))
            .offset(offset)
            .limit(limit + 1)
            .select(Message::as_select())
            .load(conn);
    }

    // Diesel cannot express this correlated LATERAL limit. Bound each authorized
    // chat's date-index scan before merging globally, instead of scanning other
    // users' message histories to discover accessible hits.
    let mut bounds = String::new();
    if filters.created_from.is_some() {
        bounds.push_str(" AND m.created_at >= $2");
    }
    if filters.created_before.is_some() {
        bounds.push_str(" AND m.created_at < $3");
    }
    let sql = format!(
        "SELECT hit.id FROM group_membership gm
         CROSS JOIN LATERAL (
            SELECT m.id, m.created_at FROM messages m
            WHERE m.chat_id = gm.chat_id AND m.deleted_at IS NULL
              AND m.is_published = TRUE AND m.message_type <> 'system' {bounds}
            ORDER BY m.created_at DESC, m.id DESC LIMIT $4
         ) hit
         WHERE gm.uid = $1 ORDER BY hit.created_at DESC, hit.id DESC
         LIMIT $5 OFFSET $6"
    );
    use diesel::sql_types::{BigInt, Integer, Nullable, Timestamptz};
    let selected = format!("SELECT m.* FROM messages m JOIN ({sql}) selected ON selected.id = m.id ORDER BY m.created_at DESC, m.id DESC");
    diesel::sql_query(selected)
        .bind::<Integer, _>(uid)
        .bind::<Nullable<Timestamptz>, _>(filters.created_from)
        .bind::<Nullable<Timestamptz>, _>(filters.created_before)
        .bind::<BigInt, _>(offset + limit + 1)
        .bind::<BigInt, _>(limit + 1)
        .bind::<BigInt, _>(offset)
        .load(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::connection::SimpleConnection;
    #[test]
    fn database_date_filtering_covers_types_scopes_memberships_and_pages() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
            conn.batch_execute(
                "INSERT INTO groups(id,name) VALUES (9876996000,'date-a'),(9876996001,'date-hidden'),(9876996002,'date-b');
                 INSERT INTO group_membership(chat_id,uid,archived) VALUES (9876996000,6001,TRUE),(9876996002,6001,FALSE);
                 INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at,has_thread)
                 VALUES (9876996101,9876996000,42,'text','date-root','2026-11-01T00:00:00Z',TRUE);
                 INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at)
                 VALUES (9876996102,9876996000,42,'text','date-text','2026-11-02T00:00:00Z'),
                        (9876996103,9876996000,43,'audio','date-audio','2026-11-02T00:00:00Z'),
                        (9876996104,9876996000,42,'file','date-file','2026-11-02T01:00:00Z'),
                        (9876996105,9876996000,42,'sticker','date-sticker','2026-11-03T00:00:00Z'),
                        (9876996106,9876996000,42,'text','date-deleted','2026-11-02T01:00:00Z'),
                        (9876996107,9876996000,42,'audio','date-pending','2026-11-02T01:00:00Z'),
                        (9876996110,9876996001,42,'text','date-hidden','2026-11-02T01:00:00Z'),
                        (9876996111,9876996002,42,'forwarded','date-forward','2026-11-02T00:30:00Z');
                 UPDATE messages SET deleted_at=NOW() WHERE id=9876996106;
                 UPDATE messages SET is_published=FALSE WHERE id=9876996107;
                 INSERT INTO messages(id,chat_id,sender_uid,message_type,system_kind,client_generated_id,created_at)
                 VALUES (9876996108,9876996000,42,'system','unknown','date-system','2026-11-02T01:00:00Z');
                 INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at,reply_root_id)
                 VALUES (9876996109,9876996000,42,'file','date-reply','2026-11-02T02:00:00Z',9876996101);"
            )?;
            let mut filters = MessageSearchFilters { range: MessageSearchRange::All, sender_uid: None,
                created_from: Some("2026-11-02T08:00:00+08:00".parse().unwrap()),
                created_before: Some("2026-11-03T00:00:00Z".parse().unwrap()) };
            let ids = |rows: Vec<Message>| rows.into_iter().map(|m|m.id - 9876996100).collect::<Vec<_>>();
            assert_eq!(ids(load_filtered_messages(conn,6001,None,filters,20,0)?), vec![9,4,11,3,2]);
            assert_eq!(ids(load_filtered_messages(conn,6001,None,filters,1,0)?), vec![9,4]);
            assert_eq!(ids(load_filtered_messages(conn,6001,None,filters,1,1)?), vec![4,11]);
            assert!(load_filtered_messages(conn,6002,None,filters,20,0)?.is_empty());
            assert!(load_filtered_messages(conn,6001,Some(9876996001),filters,20,0)?.is_empty());
            filters.range = MessageSearchRange::Main;
            assert_eq!(ids(load_filtered_messages(conn,6001,Some(9876996000),filters,20,0)?), vec![4,3,2]);
            filters.sender_uid = Some(42);
            assert_eq!(ids(load_filtered_messages(conn,6001,Some(9876996000),filters,20,0)?), vec![4,2]);
            filters.range = MessageSearchRange::Thread(9876996101);
            assert_eq!(ids(load_filtered_messages(conn,6001,Some(9876996000),filters,20,0)?), vec![9]);
            filters.created_from = None; filters.created_before = None;
            assert_eq!(ids(load_filtered_messages(conn,6001,Some(9876996000),filters,1,1)?), vec![1]);
            filters.range = MessageSearchRange::All;
            filters.sender_uid = None;
            filters.created_before = Some("2026-11-02T00:00:00Z".parse().unwrap());
            assert_eq!(ids(load_filtered_messages(conn,6001,None,filters,20,0)?), vec![1]);
            filters.created_before = None;
            filters.created_from = Some("2026-11-03T00:00:00Z".parse().unwrap());
            assert_eq!(ids(load_filtered_messages(conn,6001,None,filters,20,0)?), vec![5]);
            Ok(())
        });
    }
}
