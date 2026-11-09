//! Structured history filtering does not depend on the text search index.
use super::{pagination::SearchPosition, MessageSearchFilters, MessageSearchRange};
use crate::{errors::AppError, models::Message, schema::messages};
use diesel::{prelude::*, PgConnection};

#[derive(Clone, Copy)]
pub enum HistorySearchScope {
    Main(i64),
    Thread { chat_id: i64, root_id: i64 },
}

impl HistorySearchScope {
    pub fn new(chat_id: Option<i64>, range: MessageSearchRange) -> Result<Self, AppError> {
        match (chat_id, range) {
            (Some(chat_id), MessageSearchRange::Main) => Ok(Self::Main(chat_id)),
            (Some(chat_id), MessageSearchRange::Thread(root_id)) => {
                Ok(Self::Thread { chat_id, root_id })
            }
            _ => Err(AppError::BadRequest(
                "Search without a query requires a chat and scope=main or scope=thread",
            )),
        }
    }
}

fn base(
    filters: MessageSearchFilters,
    before: Option<SearchPosition>,
) -> messages::BoxedQuery<'static, diesel::pg::Pg> {
    // Fixed predicates let generic prepared plans use the partial history indexes.
    let mut query = messages::table
        .filter(diesel::dsl::sql::<diesel::sql_types::Bool>(
            "deleted_at IS NULL AND is_published = TRUE AND message_type <> 'system'",
        ))
        .into_boxed();
    if let Some(from) = filters.created_from {
        query = query.filter(messages::created_at.ge(from));
    }
    if let Some(until) = filters.created_before {
        query = query.filter(messages::created_at.lt(until));
    }
    if let Some(uid) = filters.sender_uid {
        query = query.filter(messages::sender_uid.eq(uid));
    }
    if let Some(before) = before {
        query = query.filter(
            diesel::dsl::sql::<diesel::sql_types::Bool>("(created_at, id) < (")
                .bind::<diesel::sql_types::Timestamptz, _>(before.created_at)
                .sql(", ")
                .bind::<diesel::sql_types::BigInt, _>(before.id)
                .sql(")"),
        );
    }
    query
}

/// Returns up to limit + 1 rows, with the extra row used only for continuation detection.
pub fn load_filtered_messages(
    conn: &mut PgConnection,
    uid: i32,
    scope: HistorySearchScope,
    filters: MessageSearchFilters,
    limit: i64,
    before: Option<SearchPosition>,
) -> QueryResult<Vec<Message>> {
    let (chat_id, root) = match scope {
        HistorySearchScope::Main(chat_id) => {
            return base(filters, before)
                .filter(messages::chat_id.eq(chat_id))
                .filter(messages::reply_root_id.is_null())
                .filter(
                    messages::chat_id
                        .eq_any(crate::services::chat_access::accessible_chat_ids(uid)),
                )
                .order((messages::created_at.desc(), messages::id.desc()))
                .limit(limit + 1)
                .select(Message::as_select())
                .load(conn);
        }
        HistorySearchScope::Thread { chat_id, root_id } => (chat_id, root_id),
    };

    // Merge bounded reply/root projections before hydrating the page. Diesel cannot
    // express this ordered UNION efficiently.
    let mut predicates = String::from(
        "m.deleted_at IS NULL AND m.is_published = TRUE AND m.message_type <> 'system'",
    );
    if filters.sender_uid.is_some() {
        predicates.push_str(" AND m.sender_uid = $4");
    }
    if filters.created_from.is_some() {
        predicates.push_str(" AND m.created_at >= $5");
    }
    if filters.created_before.is_some() {
        predicates.push_str(" AND m.created_at < $6");
    }
    if before.is_some() {
        predicates.push_str(" AND (m.created_at, m.id) < ($7, $8)");
    }
    let eligible = format!("{predicates} AND m.chat_id = $2 AND m.chat_id IN (SELECT chat_id FROM group_membership WHERE uid = $1)");
    let selected = format!("SELECT id, created_at FROM (
            (SELECT m.id, m.created_at FROM messages m WHERE {eligible} AND m.reply_root_id = $3
             ORDER BY m.created_at DESC, m.id DESC LIMIT $9)
            UNION ALL
            (SELECT m.id, m.created_at FROM messages m WHERE {eligible} AND m.id = $3 AND m.reply_root_id IS NULL)
         ) candidates ORDER BY created_at DESC, id DESC LIMIT $9");
    let sql = format!("SELECT m.* FROM messages m JOIN ({selected}) selected ON selected.id = m.id ORDER BY m.created_at DESC, m.id DESC");
    use diesel::sql_types::{BigInt, Integer, Nullable, Timestamptz};
    diesel::sql_query(sql)
        .bind::<Integer, _>(uid)
        .bind::<BigInt, _>(chat_id)
        .bind::<BigInt, _>(root)
        .bind::<Nullable<Integer>, _>(filters.sender_uid)
        .bind::<Nullable<Timestamptz>, _>(filters.created_from)
        .bind::<Nullable<Timestamptz>, _>(filters.created_before)
        .bind::<Nullable<Timestamptz>, _>(before.map(|p| p.created_at))
        .bind::<Nullable<BigInt>, _>(before.map(|p| p.id))
        .bind::<BigInt, _>(limit + 1)
        .load(conn)
}

/// Fetch two bounded streams in the same database snapshot. Both are ordered by
/// the displayed message's key, so merging and deduplicating preserves keyset paging.
pub fn load_sender_history(
    conn: &mut PgConnection,
    uid: i32,
    chat_id: i64,
    sender_uid: i32,
    filters: MessageSearchFilters,
    limit: i64,
    before: Option<SearchPosition>,
) -> QueryResult<Vec<Message>> {
    conn.build_transaction()
        .read_only()
        .repeatable_read()
        .run(|conn| {
            let mut rows = load_filtered_messages(
                conn,
                uid,
                HistorySearchScope::Main(chat_id),
                filters,
                limit,
                before,
            )?;
            rows.extend(load_sender_thread_roots(
                conn, uid, chat_id, sender_uid, filters, limit, before,
            )?);
            rows.sort_unstable_by_key(|m| std::cmp::Reverse((m.created_at, m.id)));
            rows.dedup_by_key(|m| m.id);
            rows.truncate((limit + 1) as usize);
            Ok(rows)
        })
}

// Bound root work before checking participation, not after filtering matches.
// The fallback may read the sender's participation history, but never performs
// an unbounded sequence of per-root probes across unrelated chat history.
const SENDER_THREAD_ROOT_SCAN_BUDGET: i64 = 256;

#[derive(QueryableByName)]
struct ThreadCandidate {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    id: i64,
    #[diesel(sql_type = diesel::sql_types::Timestamptz)]
    created_at: chrono::DateTime<chrono::Utc>,
    #[diesel(sql_type = diesel::sql_types::Bool)]
    participating: bool,
}

impl ThreadCandidate {
    fn position(&self) -> SearchPosition {
        SearchPosition {
            created_at: self.created_at,
            id: self.id,
        }
    }
}

// MATERIALIZED keeps the scan budget ahead of participation predicates even in
// generic plans. Diesel's DSL cannot express this optimization boundary.
fn sender_thread_candidates_sql(
    filters: MessageSearchFilters,
    before: Option<SearchPosition>,
) -> String {
    let mut root_author = String::from("root.sender_uid = $3");
    let mut reply_author = String::from(
        "reply.reply_root_id = root.id AND reply.chat_id = $2 AND reply.sender_uid = $3
         AND reply.is_published = TRUE AND reply.deleted_at IS NULL",
    );
    if filters.created_from.is_some() {
        root_author.push_str(" AND root.created_at >= $4");
        reply_author.push_str(" AND reply.created_at >= $4");
    }
    if filters.created_before.is_some() {
        root_author.push_str(" AND root.created_at < $5");
        reply_author.push_str(" AND reply.created_at < $5");
    }
    let seek = if before.is_some() {
        "AND (root.created_at, root.id) < ($6, $7)"
    } else {
        ""
    };
    format!(
        "WITH roots AS MATERIALIZED (
            SELECT root.id, root.created_at, root.sender_uid FROM messages root
            WHERE root.chat_id = $2
              AND root.chat_id IN (SELECT chat_id FROM group_membership WHERE uid = $1)
              AND root.reply_root_id IS NULL AND root.has_thread = TRUE AND root.is_published = TRUE
              {seek}
            ORDER BY root.created_at DESC, root.id DESC LIMIT $8
        )
        SELECT root.id, root.created_at,
            (({root_author}) OR COALESCE((SELECT TRUE FROM messages reply WHERE {reply_author} LIMIT 1), FALSE)) AS participating
        FROM roots root ORDER BY root.created_at DESC, root.id DESC"
    )
}

// Materialize distinct participation IDs before joining roots: the fallback
// must not be transformed back into the unbounded root-first probe it replaces.
fn sender_thread_fallback_sql(filters: MessageSearchFilters) -> String {
    let mut dates = String::new();
    if filters.created_from.is_some() {
        dates.push_str(" AND created_at >= $4");
    }
    if filters.created_before.is_some() {
        dates.push_str(" AND created_at < $5");
    }
    format!(
        "WITH participation AS MATERIALIZED (
            SELECT DISTINCT COALESCE(reply_root_id, id) AS root_id FROM messages
            WHERE chat_id = $2 AND sender_uid = $3
              AND is_published = TRUE
              AND ((reply_root_id IS NOT NULL AND deleted_at IS NULL)
                   OR (reply_root_id IS NULL AND has_thread = TRUE))
              {dates}
        )
        SELECT root.id, root.created_at, TRUE AS participating
        FROM participation p JOIN messages root ON root.id = p.root_id
        WHERE root.chat_id = $2
          AND root.chat_id IN (SELECT chat_id FROM group_membership WHERE uid = $1)
          AND root.reply_root_id IS NULL AND root.has_thread = TRUE AND root.is_published = TRUE
          AND (root.created_at, root.id) < ($6, $7)
        ORDER BY root.created_at DESC, root.id DESC LIMIT $8"
    )
}

fn load_sender_thread_roots(
    conn: &mut PgConnection,
    uid: i32,
    chat_id: i64,
    sender_uid: i32,
    filters: MessageSearchFilters,
    limit: i64,
    before: Option<SearchPosition>,
) -> QueryResult<Vec<Message>> {
    use diesel::sql_types::{BigInt, Integer, Nullable, Timestamptz};
    let candidates = diesel::sql_query(sender_thread_candidates_sql(filters, before))
        .bind::<Integer, _>(uid)
        .bind::<BigInt, _>(chat_id)
        .bind::<Integer, _>(sender_uid)
        .bind::<Nullable<Timestamptz>, _>(filters.created_from)
        .bind::<Nullable<Timestamptz>, _>(filters.created_before)
        .bind::<Nullable<Timestamptz>, _>(before.map(|p| p.created_at))
        .bind::<Nullable<BigInt>, _>(before.map(|p| p.id))
        .bind::<BigInt, _>(SENDER_THREAD_ROOT_SCAN_BUDGET)
        .load::<ThreadCandidate>(conn)?;
    let boundary = candidates.last().map(ThreadCandidate::position);
    let exhausted = candidates.len() < SENDER_THREAD_ROOT_SCAN_BUDGET as usize;
    let mut ids = candidates
        .iter()
        .filter(|candidate| candidate.participating)
        .take((limit + 1) as usize)
        .map(|candidate| candidate.id)
        .collect::<Vec<_>>();
    if !exhausted && ids.len() < (limit + 1) as usize {
        // Both queries run in load_sender_history's repeatable-read snapshot.
        // Continue strictly after the scanned prefix, not after its last match.
        let boundary = boundary.expect("a full probe has a last root");
        let remaining = limit + 1 - ids.len() as i64;
        let fallback = diesel::sql_query(sender_thread_fallback_sql(filters))
            .bind::<Integer, _>(uid)
            .bind::<BigInt, _>(chat_id)
            .bind::<Integer, _>(sender_uid)
            .bind::<Nullable<Timestamptz>, _>(filters.created_from)
            .bind::<Nullable<Timestamptz>, _>(filters.created_before)
            .bind::<Timestamptz, _>(boundary.created_at)
            .bind::<BigInt, _>(boundary.id)
            .bind::<BigInt, _>(remaining)
            .load::<ThreadCandidate>(conn)?;
        ids.extend(fallback.into_iter().map(|candidate| candidate.id));
    }
    // Only hydrate the selected page, including its continuation lookahead.
    messages::table
        .filter(messages::id.eq_any(ids))
        .order((messages::created_at.desc(), messages::id.desc()))
        .select(Message::as_select())
        .load(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::connection::SimpleConnection;

    #[test]
    fn history_requires_a_chat_and_main_or_thread_scope() {
        for chat in [None, Some(10)] {
            assert!(HistorySearchScope::new(chat, MessageSearchRange::All).is_err());
        }
        for range in [MessageSearchRange::Main, MessageSearchRange::Thread(20)] {
            assert!(HistorySearchScope::new(None, range).is_err());
            assert!(HistorySearchScope::new(Some(10), range).is_ok());
        }
    }

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
            let mut filters = MessageSearchFilters { range: MessageSearchRange::Main, sender_uid: None,
                created_from: Some("2026-11-02T08:00:00+08:00".parse().unwrap()),
                created_before: Some("2026-11-03T00:00:00Z".parse().unwrap()) };
            let main = HistorySearchScope::Main(9876996000);
            let thread = HistorySearchScope::Thread { chat_id: 9876996000, root_id: 9876996101 };
            let ids = |rows: Vec<Message>| rows.into_iter().map(|m|m.id - 9876996100).collect::<Vec<_>>();
            assert_eq!(ids(load_filtered_messages(conn,6001,main,filters,20,None)?), vec![4,3,2]);
            assert_eq!(ids(load_filtered_messages(conn,6001,main,filters,1,None)?), vec![4,3]);
            assert_eq!(ids(load_filtered_messages(conn,6001,main,filters,1,Some(SearchPosition { created_at: "2026-11-02T01:00:00Z".parse().unwrap(), id:9876996104 }))?), vec![3,2]);
            assert!(load_filtered_messages(conn,6002,main,filters,20,None)?.is_empty());
            assert!(load_filtered_messages(conn,6001,HistorySearchScope::Main(9876996001),filters,20,None)?.is_empty());
            filters.sender_uid = Some(42);
            assert_eq!(ids(load_filtered_messages(conn,6001,main,filters,20,None)?), vec![4,2]);
            filters.range = MessageSearchRange::Thread(9876996101);
            assert_eq!(ids(load_filtered_messages(conn,6001,thread,filters,20,None)?), vec![9]);
            filters.created_from = None; filters.created_before = None;
            assert_eq!(ids(load_filtered_messages(conn,6001,thread,filters,1,Some(SearchPosition { created_at: "2026-11-02T02:00:00Z".parse().unwrap(), id:9876996109 }))?), vec![1]);
            filters.range = MessageSearchRange::Main;
            filters.sender_uid = None;
            filters.created_before = Some("2026-11-02T00:00:00Z".parse().unwrap());
            assert_eq!(ids(load_filtered_messages(conn,6001,main,filters,20,None)?), vec![1]);
            filters.created_before = None;
            filters.created_from = Some("2026-11-03T00:00:00Z".parse().unwrap());
            assert_eq!(ids(load_filtered_messages(conn,6001,main,filters,20,None)?), vec![5]);
            Ok(())
        });
    }
    #[test]
    fn database_cursor_browses_past_window_with_ties_and_concurrent_changes() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
            conn.batch_execute("INSERT INTO groups(id,name) VALUES (9876997000,'cursor-thread'),(9876997001,'cursor-main');
                INSERT INTO group_membership(chat_id,uid) VALUES (9876997000,7001),(9876997001,7001);
                INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at,has_thread)
                VALUES (9007199254800000,9876997000,42,'text','cursor-root','2026-11-01T00:00:00Z',TRUE);
                INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at,reply_root_id)
                SELECT 9007199254800000+n,9876997000,42,'file','cursor-reply-'||n,
                       '2026-11-01'::timestamptz+(n%3)*interval '1 microsecond',9007199254800000
                FROM generate_series(1,1205) n;
                INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at)
                SELECT 9007199254810000+n,9876997001,42,'audio','cursor-main-'||n,
                       '2026-11-01'::timestamptz+(n%3)*interval '1 microsecond'
                FROM generate_series(1,1205) n;")?;
            let filters = MessageSearchFilters { range: MessageSearchRange::Main, sender_uid: None,
                created_from: Some("2026-11-01T00:00:00Z".parse().unwrap()), created_before: None };
            for (scope, range, expected_count) in [
                (HistorySearchScope::Main(9876997000), MessageSearchRange::Main, 1),
                (HistorySearchScope::Main(9876997001), MessageSearchRange::Main, 1205),
                (HistorySearchScope::Thread { chat_id:9876997000, root_id:9007199254800000 }, MessageSearchRange::Thread(9007199254800000), 1206),
            ] {
                let mut before = None;
                let mut seen = Vec::new();
                loop {
                    let mut rows = load_filtered_messages(conn,7001,scope,MessageSearchFilters { range, ..filters },37,before)?;
                    let more = rows.len() > 37;
                    rows.truncate(37);
                    for row in rows {
                        let position = SearchPosition { created_at: row.created_at, id: row.id };
                        assert!(before.is_none_or(|p| position < p));
                        before = Some(position);
                        seen.push(row.id);
                    }
                    if !more { break; }
                }
                assert_eq!(seen.len(), expected_count);
                assert_eq!(seen.iter().collect::<std::collections::HashSet<_>>().len(), expected_count);
            }
            let first = load_filtered_messages(conn,7001,HistorySearchScope::Main(9876997001),filters,37,None)?;
            let last = &first[36];
            let before = Some(SearchPosition { created_at: last.created_at, id:last.id });
            let expected = load_filtered_messages(conn,7001,HistorySearchScope::Main(9876997001),filters,37,before)?.iter().map(|m|m.id).collect::<Vec<_>>();
            diesel::delete(messages::table.filter(messages::id.eq(first[0].id))).execute(conn)?;
            conn.batch_execute("INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at)
                VALUES (9007199254899999,9876997001,42,'text','cursor-new','2026-11-02T00:00:00Z');")?;
            assert_eq!(load_filtered_messages(conn,7001,HistorySearchScope::Main(9876997001),filters,37,before)?.iter().map(|m|m.id).collect::<Vec<_>>(), expected);
            conn.batch_execute("DELETE FROM group_membership WHERE uid=7001")?;
            assert!(load_filtered_messages(conn,7001,HistorySearchScope::Main(9876997001),filters,37,before)?.is_empty());
            assert!(load_filtered_messages(conn,7001,HistorySearchScope::Thread { chat_id:9876997000, root_id:9007199254800000 },MessageSearchFilters {range:MessageSearchRange::Thread(9007199254800000),..filters},37,before)?.is_empty());
            Ok(())
        });
    }

    fn assert_sender_thread_page_uses_bounded_seek(
        conn: &mut PgConnection,
        filters: MessageSearchFilters,
    ) {
        #[derive(QueryableByName)]
        struct Explain {
            #[diesel(column_name = "QUERY PLAN", sql_type = diesel::sql_types::Json)]
            plan: serde_json::Value,
        }
        fn root_scan(plan: &serde_json::Value) -> Option<&serde_json::Value> {
            if plan["Relation Name"] == "messages"
                && plan["Alias"]
                    .as_str()
                    .is_some_and(|alias| alias.starts_with("root"))
            {
                return Some(plan);
            }
            plan["Plans"].as_array()?.iter().find_map(root_scan)
        }
        let before = SearchPosition {
            created_at: "2026-01-01T00:00:00Z".parse().unwrap(),
            id: 1200,
        };
        let filters = MessageSearchFilters {
            created_from: Some("2026-11-01T00:00:00Z".parse().unwrap()),
            created_before: Some("2026-12-01T00:00:00Z".parse().unwrap()),
            ..filters
        };
        let selected = sender_thread_candidates_sql(filters, Some(before));
        conn.batch_execute(&format!("PREPARE sender_thread_page(integer,bigint,integer,timestamptz,timestamptz,timestamptz,bigint,bigint) AS
            {selected}")).unwrap();
        // Cover both planner modes used by prepared statements. Inspect row work,
        // not wall-clock timing, so the regression check is independent of hardware.
        for mode in ["force_custom_plan", "force_generic_plan"] {
            conn.batch_execute(&format!("SET plan_cache_mode = {mode}"))
                .unwrap();
            let plan = diesel::sql_query(format!("EXPLAIN (ANALYZE, FORMAT JSON) EXECUTE sender_thread_page(1,10,{},'2026-11-01','2026-12-01','2026-01-01',1200,{SENDER_THREAD_ROOT_SCAN_BUDGET})", filters.sender_uid.unwrap()))
                .get_result::<Explain>(conn).unwrap().plan;
            let scan =
                root_scan(&plan[0]["Plan"]).unwrap_or_else(|| panic!("missing root scan: {plan}"));
            assert!(
                scan["Node Type"].as_str().unwrap().contains("Index"),
                "{plan}"
            );
            let examined = scan["Actual Rows"].as_f64().unwrap()
                + scan["Rows Removed by Filter"].as_f64().unwrap_or(0.0);
            assert!(examined <= SENDER_THREAD_ROOT_SCAN_BUDGET as f64, "{plan}");
            assert_eq!(
                plan[0]["Plan"]["Actual Rows"].as_f64(),
                Some(SENDER_THREAD_ROOT_SCAN_BUDGET as f64)
            );
        }
        conn.batch_execute("RESET plan_cache_mode; DEALLOCATE sender_thread_page;")
            .unwrap();
    }

    #[test]
    fn sender_history_deduplicates_threads_and_pages_beyond_a_thousand() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        let schema = format!("participant_test_{}", uuid::Uuid::new_v4().simple());
        conn.batch_execute(&format!(
            "CREATE SCHEMA {schema}; SET search_path TO {schema},public;
            CREATE TABLE messages (LIKE public.messages INCLUDING ALL);
            CREATE TABLE group_membership (LIKE public.group_membership INCLUDING ALL);"
        ))
        .unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            conn.batch_execute("INSERT INTO group_membership(chat_id,uid) VALUES (10,1),(10,42);
                INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at,has_thread)
                SELECT n,10,CASE WHEN n%2=0 THEN 42 ELSE 99 END,'text','root-'||n,'2026-01-01',TRUE FROM generate_series(1,1205) n;
                INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at,reply_root_id)
                SELECT 10000+n,10,42,'text','reply-'||n,'2026-11-01',n FROM generate_series(1,1205) n;
                INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at)
                VALUES (20001,10,42,'text','main','2026-11-01'),(20002,20,42,'text','hidden','2026-11-01');
                UPDATE messages SET deleted_at=NOW() WHERE id=10001;
                UPDATE messages SET is_published=FALSE WHERE id=10003;
                UPDATE messages SET deleted_at=NOW() WHERE id=5;
                INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at,reply_root_id)
                VALUES (30000,10,42,'text','repeat','2026-11-01',6);").unwrap();
            let filters = MessageSearchFilters {
                range: MessageSearchRange::All,
                sender_uid: Some(42),
                created_from: None,
                created_before: None,
            };
            let root_index = include_str!("../../../migrations/2026-11-10-021536-0000_add_sender_history_root_seek_index/up.sql")
                .split("-- statement-break")
                .last().unwrap()
                .replace("CONCURRENTLY ", "");
            conn.batch_execute(&root_index).unwrap();
            conn.batch_execute("ANALYZE messages; ANALYZE group_membership;")
                .unwrap();
            assert_sender_thread_page_uses_bounded_seek(&mut conn, filters);
            let mut before = None;
            let mut ids = Vec::new();
            loop {
                let mut rows =
                    load_sender_history(&mut conn, 1, 10, 42, filters, 37, before).unwrap();
                let more = rows.len() > 37;
                rows.truncate(37);
                for row in rows {
                    let p = SearchPosition {
                        created_at: row.created_at,
                        id: row.id,
                    };
                    assert!(before.is_none_or(|previous| p < previous));
                    before = Some(p);
                    ids.push(row.id);
                }
                if !more {
                    break;
                }
            }
            assert_eq!(ids.len(), 1204); // 1,205 roots minus 2 invalid participations plus main.
            assert_eq!(
                ids.iter().collect::<std::collections::HashSet<_>>().len(),
                ids.len()
            );
            assert_eq!(ids[0], 20001);
            assert!(ids.contains(&5)); // Deleted root remains a locatable thread.
            assert!(!ids.contains(&1) && !ids.contains(&3));
            let dated = MessageSearchFilters {
                created_from: Some("2026-11-01T00:00:00Z".parse().unwrap()),
                ..filters
            };
            let rows = load_sender_history(&mut conn, 1, 10, 42, dated, 2000, None).unwrap();
            assert_eq!(rows.len(), 1204); // Old roots qualify through November replies.
            let before_replies = MessageSearchFilters {
                created_before: Some("2026-11-01T00:00:00Z".parse().unwrap()),
                ..filters
            };
            let roots =
                load_sender_history(&mut conn, 1, 10, 42, before_replies, 2000, None).unwrap();
            assert_eq!(roots.len(), 602); // Only the sender's January roots qualify.
            assert!(roots
                .iter()
                .all(|root| root.sender_uid == 42 && root.id <= 1205));
            let november = MessageSearchFilters {
                created_before: Some("2026-12-01T00:00:00Z".parse().unwrap()),
                ..dated
            };
            assert_eq!(
                load_sender_history(&mut conn, 1, 10, 42, november, 2000, None)
                    .unwrap()
                    .len(),
                1204
            );
            // Sparse participation selects a few known roots instead of probing
            // the entire chat. The oldest root is intentionally beyond page one.
            conn.batch_execute("INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at,reply_root_id)
                VALUES (40000,10,88,'text','sparse-reply','2026-11-01',1),
                       (40001,10,88,'text','sparse-duplicate','2026-11-01',1),
                       (40002,10,88,'text','sparse-other','2026-11-02',3);").unwrap();
            let sparse = MessageSearchFilters {
                sender_uid: Some(88),
                ..dated
            };
            let sparse_roots = load_sender_history(&mut conn, 1, 10, 88, sparse, 1, None).unwrap();
            assert_eq!(
                sparse_roots.iter().map(|m| m.id).collect::<Vec<_>>(),
                vec![3, 1]
            );
            let position = SearchPosition {
                created_at: sparse_roots[0].created_at,
                id: 3,
            };
            assert_eq!(
                load_sender_history(&mut conn, 1, 10, 88, sparse, 1, Some(position)).unwrap()[0].id,
                1
            );
            // Repeated replies in one old thread must not trigger a chat-wide
            // root probe. Include matches on both sides of the 256-root boundary.
            conn.batch_execute("INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at,reply_root_id)
                SELECT 50000+n,10,89,'text','repeated-'||n,'2026-11-01',1 FROM generate_series(1,129) n;
                INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at,reply_root_id)
                SELECT 60000+n,10,89,'text','boundary-'||n,'2026-11-01',n FROM unnest(ARRAY[1205,950,949,948,5]) n;
                INSERT INTO messages(id,chat_id,sender_uid,message_type,client_generated_id,created_at,reply_root_id,deleted_at,is_published)
                VALUES (70001,10,89,'text','excluded-deleted','2026-11-01',2,NOW(),TRUE),
                       (70002,10,89,'text','excluded-pending','2026-11-01',3,NULL,FALSE),
                       (70003,10,89,'text','excluded-date','2026-12-01',4,NULL,TRUE);
                ANALYZE messages;").unwrap();
            let repeated = MessageSearchFilters {
                sender_uid: Some(89),
                ..november
            };
            assert_sender_thread_page_uses_bounded_seek(&mut conn, repeated);
            for page_size in [1, 2, 3, 37, 100] {
                let mut before = None;
                let mut seen = Vec::new();
                loop {
                    let mut page =
                        load_sender_history(&mut conn, 1, 10, 89, repeated, page_size, before)
                            .unwrap();
                    let more = page.len() > page_size as usize;
                    page.truncate(page_size as usize);
                    for row in page {
                        let position = SearchPosition {
                            created_at: row.created_at,
                            id: row.id,
                        };
                        assert!(before.is_none_or(|previous| position < previous));
                        before = Some(position);
                        seen.push(row.id);
                    }
                    if !more {
                        break;
                    }
                }
                assert_eq!(seen, vec![1205, 950, 949, 948, 5, 1]);
            }
            let outside_dates = MessageSearchFilters {
                created_from: Some("2026-10-01T00:00:00Z".parse().unwrap()),
                created_before: Some("2026-11-01T00:00:00Z".parse().unwrap()),
                ..repeated
            };
            assert!(
                load_sender_history(&mut conn, 1, 10, 89, outside_dates, 37, None)
                    .unwrap()
                    .is_empty()
            );
            let absent_sender = MessageSearchFilters {
                sender_uid: Some(77),
                ..filters
            };
            assert!(
                load_sender_history(&mut conn, 1, 10, 77, absent_sender, 37, None)
                    .unwrap()
                    .is_empty()
            );
            let threads = crate::services::threads::get_chat_threads(
                &mut conn,
                10,
                None,
                crate::dto::threads::ThreadOrder::Newest,
                2000,
                Some(42),
            )
            .unwrap();
            assert_eq!(threads.len(), 1203);
            assert!(crate::services::threads::get_chat_threads(
                &mut conn,
                10,
                None,
                crate::dto::threads::ThreadOrder::Newest,
                20,
                Some(77)
            )
            .unwrap()
            .is_empty());
            let next = crate::services::threads::get_chat_threads(
                &mut conn,
                10,
                Some(1200),
                crate::dto::threads::ThreadOrder::Newest,
                20,
                Some(42),
            )
            .unwrap();
            assert!(next.iter().all(|m| m.id < 1200));
            conn.batch_execute("DELETE FROM group_membership WHERE uid=1")
                .unwrap();
            assert!(load_sender_history(&mut conn, 1, 10, 42, filters, 37, None)
                .unwrap()
                .is_empty());
        }));
        conn.batch_execute(&format!(
            "SET search_path TO public; DROP SCHEMA {schema} CASCADE;"
        ))
        .unwrap();
        if let Err(panic) = result {
            std::panic::resume_unwind(panic);
        }
    }
}
