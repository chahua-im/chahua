//! Private writer state for multi-connection sync tests. Primary table shapes
//! come from the migrated test database; sync functions and triggers come from
//! the production migrations. Provider replicas remain read-only.

use diesel::{connection::SimpleConnection, prelude::*, sql_types::Text};

#[derive(QueryableByName)]
struct Table {
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = Text)]
    qualified_name: String,
}

pub(crate) struct SyncFixture {
    url: String,
    schema: String,
}

impl SyncFixture {
    pub(crate) fn new() -> Option<Self> {
        let url = std::env::var("WETTY_TEST_DATABASE_URL").ok()?;
        let mut conn = PgConnection::establish(&url).expect("connect private sync fixture");
        let tables = diesel::sql_query(
            "SELECT tablename::text AS name, format('%I.%I', schemaname, tablename) AS qualified_name
             FROM pg_catalog.pg_tables WHERE schemaname = current_schema()
               AND tablename <> '__diesel_schema_migrations'
               AND tablename NOT LIKE 'message_sync_%' AND tablename NOT LIKE 'list_sync_%'",
        )
        .load::<Table>(&mut conn)
        .unwrap();
        let fixture = Self {
            url,
            schema: format!("list_sync_test_{}", uuid::Uuid::new_v4().simple()),
        };
        conn.batch_execute(&format!("CREATE SCHEMA \"{}\"", fixture.schema))
            .unwrap();
        fixture.set_path(&mut conn);
        for table in tables {
            conn.batch_execute(&format!(
                "CREATE TABLE \"{}\" (LIKE {} INCLUDING ALL)",
                table.name.replace('"', "\"\""),
                table.qualified_name,
            ))
            .unwrap();
        }
        conn.batch_execute(include_str!(
            "../../migrations/2026-11-19-192526-0000_add_message_sync/up.sql"
        ))
        .unwrap();
        conn.batch_execute(include_str!(
            "../../migrations/2026-11-20-070844-0000_message_sync_commit_heads/up.sql"
        ))
        .unwrap();
        conn.batch_execute(include_str!(
            "../../migrations/2026-11-20-234802-0000_list_sync/up.sql"
        ))
        .unwrap();
        Some(fixture)
    }

    pub(crate) fn connect(&self) -> PgConnection {
        let mut conn = PgConnection::establish(&self.url).unwrap();
        self.set_path(&mut conn);
        conn
    }

    fn set_path(&self, conn: &mut PgConnection) {
        conn.batch_execute(&format!(
            "SET search_path TO \"{}\", public; SET lock_timeout = '5s'",
            self.schema,
        ))
        .unwrap();
    }
}

impl Drop for SyncFixture {
    fn drop(&mut self) {
        if let Ok(mut conn) = PgConnection::establish(&self.url) {
            let _ = conn.batch_execute(&format!("DROP SCHEMA \"{}\" CASCADE", self.schema));
        }
    }
}

#[test]
fn list_sync_private_writers_serialize_at_commit_and_rollback_does_not_advance() {
    use diesel::sql_types::{BigInt, Bool, Integer};
    use std::{
        sync::mpsc,
        time::{Duration, Instant},
    };

    #[derive(QueryableByName)]
    struct Head {
        #[diesel(sql_type = BigInt)]
        value: i64,
    }
    #[derive(QueryableByName)]
    struct Blocked {
        #[diesel(sql_type = Bool)]
        value: bool,
    }
    #[derive(QueryableByName)]
    struct Pid {
        #[diesel(sql_type = Integer)]
        value: i32,
    }
    let Some(fixture) = SyncFixture::new() else {
        return;
    };
    let mut first = fixture.connect();
    first
        .batch_execute(
            "BEGIN;
         INSERT INTO groups(id,name) VALUES (1,'private');
         INSERT INTO group_membership(chat_id,uid) VALUES (1,1),(1,2);
         COMMIT;
         BEGIN;
         UPDATE group_membership SET archived=true WHERE chat_id=1 AND uid=1;
         SET CONSTRAINTS list_sync_flush,message_sync_flush IMMEDIATE;",
        )
        .unwrap();
    let mut second = fixture.connect();
    let pid = diesel::sql_query("SELECT pg_backend_pid() AS value")
        .get_result::<Pid>(&mut second)
        .unwrap()
        .value;
    let (started, waiting) = mpsc::channel();
    let writer = std::thread::spawn(move || {
        second.batch_execute(
            "BEGIN; UPDATE group_membership SET last_read_message_id=42 WHERE chat_id=1 AND uid=2;"
        ).unwrap();
        started.send(()).unwrap();
        let began = Instant::now();
        second.batch_execute("COMMIT").unwrap();
        began.elapsed()
    });
    waiting.recv().unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let blocked = diesel::sql_query("SELECT cardinality(pg_blocking_pids($1)) > 0 AS value")
            .bind::<Integer, _>(pid)
            .get_result::<Blocked>(&mut first)
            .unwrap()
            .value;
        if blocked {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "second commit did not wait on the singleton"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    first.batch_execute("ROLLBACK").unwrap();
    eprintln!(
        "list-only read cursor commit lock wait: {:?}",
        writer.join().unwrap()
    );
    let head = diesel::sql_query("SELECT head AS value FROM list_sync_meta")
        .get_result::<Head>(&mut first)
        .unwrap()
        .value;
    assert_eq!(head, 2);
    let first_stamp = diesel::sql_query("SELECT seq AS value FROM list_sync_personal WHERE uid=1")
        .get_result::<Head>(&mut first)
        .unwrap()
        .value;
    let second_stamp = diesel::sql_query("SELECT seq AS value FROM list_sync_personal WHERE uid=2")
        .get_result::<Head>(&mut first)
        .unwrap()
        .value;
    assert_eq!((first_stamp, second_stamp), (1, 2));
}
