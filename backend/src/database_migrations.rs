use diesel::connection::BoxableConnection;
use diesel::migration::{Migration, MigrationMetadata, MigrationName, MigrationSource, Result};
use diesel::pg::Pg;
use diesel_migrations::{embed_migrations, EmbeddedMigrations};

const EMBEDDED: EmbeddedMigrations = embed_migrations!("migrations");
const MESSAGE_FILTER_MIGRATION: &str = "2026-11-09-124756-0000_add_message_filter_indexes";
const MESSAGE_FILTER_UP: &str =
    include_str!("../migrations/2026-11-09-124756-0000_add_message_filter_indexes/up.sql");
const MESSAGE_FILTER_DOWN: &str =
    include_str!("../migrations/2026-11-09-124756-0000_add_message_filter_indexes/down.sql");
const SENDER_HISTORY_MIGRATION: &str = "2026-11-10-021536-0000_add_sender_history_root_seek_index";
const SENDER_HISTORY_UP: &str =
    include_str!("../migrations/2026-11-10-021536-0000_add_sender_history_root_seek_index/up.sql");
const SENDER_HISTORY_DOWN: &str = include_str!(
    "../migrations/2026-11-10-021536-0000_add_sender_history_root_seek_index/down.sql"
);
const STATEMENT_BREAK: &str = "\n-- statement-break\n";

pub struct AppMigrations;

impl MigrationSource<Pg> for AppMigrations {
    fn migrations(&self) -> Result<Vec<Box<dyn Migration<Pg>>>> {
        let migrations = EMBEDDED.migrations()?;
        Ok(migrations
            .into_iter()
            .map(|migration: Box<dyn Migration<Pg>>| {
                let statements = match migration.name().to_string().as_str() {
                    MESSAGE_FILTER_MIGRATION => Some((MESSAGE_FILTER_UP, MESSAGE_FILTER_DOWN)),
                    SENDER_HISTORY_MIGRATION => Some((SENDER_HISTORY_UP, SENDER_HISTORY_DOWN)),
                    _ => None,
                };
                match statements {
                    Some((up, down)) => Box::new(ConcurrentIndexMigration {
                        migration,
                        up,
                        down,
                    }) as Box<dyn Migration<Pg>>,
                    None => migration,
                }
            })
            .collect())
    }
}

struct ConcurrentIndexMigration {
    migration: Box<dyn Migration<Pg>>,
    up: &'static str,
    down: &'static str,
}

// PQexec treats multiple statements as one implicit transaction even when Diesel's
// migration transaction is disabled. Explicit boundaries avoid parsing SQL and
// let each concurrent index operation run in its own top-level command.
fn execute_statements(conn: &mut dyn BoxableConnection<Pg>, sql: &str) -> Result<()> {
    for statement in sql.split(STATEMENT_BREAK) {
        conn.batch_execute(statement)?;
    }
    Ok(())
}

impl Migration<Pg> for ConcurrentIndexMigration {
    fn run(&self, conn: &mut dyn BoxableConnection<Pg>) -> Result<()> {
        execute_statements(conn, self.up)
    }

    fn revert(&self, conn: &mut dyn BoxableConnection<Pg>) -> Result<()> {
        execute_statements(conn, self.down)
    }

    fn metadata(&self) -> &dyn MigrationMetadata {
        self.migration.metadata()
    }

    fn name(&self) -> &dyn MigrationName {
        self.migration.name()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::{connection::SimpleConnection, prelude::*, PgConnection};
    use diesel_migrations::MigrationHarness;

    fn migration_named(name: &str) -> Box<dyn Migration<Pg>> {
        AppMigrations
            .migrations()
            .unwrap()
            .into_iter()
            .find(|migration| migration.name().to_string() == name)
            .unwrap()
    }

    #[test]
    fn concurrent_index_migration_does_not_use_a_transaction() {
        for name in [MESSAGE_FILTER_MIGRATION, SENDER_HISTORY_MIGRATION] {
            assert!(!migration_named(name).metadata().run_in_transaction());
        }
    }

    #[test]
    fn concurrent_indexes_retry_partial_migration_and_revert() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        let schema = format!("search_migration_{}", uuid::Uuid::new_v4().simple());
        conn.batch_execute(&format!(
            "CREATE SCHEMA {schema}; SET search_path TO {schema};"
        ))
        .unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // Missing sender_uid makes the second build fail after the first succeeds.
            conn.batch_execute(
                "CREATE TABLE messages (
                id bigint, chat_id bigint, reply_root_id bigint, created_at timestamptz,
                deleted_at timestamptz, is_published boolean, message_type text, has_thread boolean
            )",
            )
            .unwrap();
            assert!(conn.applied_migrations().unwrap().is_empty());
            let migration = migration_named(MESSAGE_FILTER_MIGRATION);
            assert!(conn.run_migration(&migration).is_err());
            assert!(conn.applied_migrations().unwrap().is_empty());
            conn.batch_execute("ALTER TABLE messages ADD COLUMN sender_uid integer")
                .unwrap();

            conn.run_migration(&migration).unwrap();
            assert_eq!(
                conn.applied_migrations().unwrap(),
                vec![migration.name().version()]
            );
            #[derive(QueryableByName)]
            struct IndexState {
                #[diesel(sql_type = diesel::sql_types::Text)]
                name: String,
                #[diesel(sql_type = diesel::sql_types::Bool)]
                valid: bool,
                #[diesel(sql_type = diesel::sql_types::Text)]
                predicate: String,
            }
            let indexes = diesel::sql_query(
                "SELECT c.relname AS name, i.indisvalid AS valid,
                    pg_get_expr(i.indpred, i.indrelid) AS predicate
                FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
                WHERE i.indrelid='messages'::regclass ORDER BY c.relname",
            )
            .load::<IndexState>(&mut conn)
            .unwrap();
            assert_eq!(indexes.len(), 4);
            assert!(indexes.iter().all(|index| index.valid));
            for index in indexes {
                let scope = if index.name == "idx_messages_filter_thread_date" {
                    "reply_root_id IS NOT NULL"
                } else {
                    "reply_root_id IS NULL"
                };
                assert!(index.predicate.contains(scope));
            }

            conn.revert_migration(&migration).unwrap();
            assert!(conn.applied_migrations().unwrap().is_empty());
            // A second application proves the rollback removed all four names.
            conn.run_migration(&migration).unwrap();
            conn.revert_migration(&migration).unwrap();
            let sender_history = migration_named(SENDER_HISTORY_MIGRATION);
            conn.run_migration(&sender_history).unwrap();
            let valid = diesel::sql_query(
                "SELECT c.relname AS name, i.indisvalid AS valid,
                    pg_get_expr(i.indpred, i.indrelid) AS predicate
                 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
                 WHERE i.indrelid='messages'::regclass",
            )
            .get_result::<IndexState>(&mut conn)
            .unwrap();
            assert_eq!(valid.name, "idx_messages_thread_root_date");
            assert!(valid.valid);
            assert!(valid.predicate.contains("reply_root_id IS NULL"));
            assert!(!valid.predicate.contains("deleted_at"));
            conn.revert_migration(&sender_history).unwrap();
            conn.run_migration(&sender_history).unwrap();
            conn.revert_migration(&sender_history).unwrap();
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
