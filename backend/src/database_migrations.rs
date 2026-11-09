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
const STATEMENT_BREAK: &str = "\n-- statement-break\n";

pub struct AppMigrations;

impl MigrationSource<Pg> for AppMigrations {
    fn migrations(&self) -> Result<Vec<Box<dyn Migration<Pg>>>> {
        let migrations = EMBEDDED.migrations()?;
        Ok(migrations
            .into_iter()
            .map(|migration: Box<dyn Migration<Pg>>| {
                if migration.name().to_string() == MESSAGE_FILTER_MIGRATION {
                    Box::new(MessageFilterMigration(migration)) as Box<dyn Migration<Pg>>
                } else {
                    migration
                }
            })
            .collect())
    }
}

struct MessageFilterMigration(Box<dyn Migration<Pg>>);

// PQexec treats multiple statements as one implicit transaction even when Diesel's
// migration transaction is disabled. Explicit boundaries avoid parsing SQL and
// let each concurrent index operation run in its own top-level command.
fn execute_statements(conn: &mut dyn BoxableConnection<Pg>, sql: &str) -> Result<()> {
    for statement in sql.split(STATEMENT_BREAK) {
        conn.batch_execute(statement)?;
    }
    Ok(())
}

impl Migration<Pg> for MessageFilterMigration {
    fn run(&self, conn: &mut dyn BoxableConnection<Pg>) -> Result<()> {
        execute_statements(conn, MESSAGE_FILTER_UP)
    }

    fn revert(&self, conn: &mut dyn BoxableConnection<Pg>) -> Result<()> {
        execute_statements(conn, MESSAGE_FILTER_DOWN)
    }

    fn metadata(&self) -> &dyn MigrationMetadata {
        self.0.metadata()
    }

    fn name(&self) -> &dyn MigrationName {
        self.0.name()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::{connection::SimpleConnection, prelude::*, PgConnection};
    use diesel_migrations::MigrationHarness;

    fn message_filter_migration() -> Box<dyn Migration<Pg>> {
        AppMigrations
            .migrations()
            .unwrap()
            .into_iter()
            .find(|migration| migration.name().to_string() == MESSAGE_FILTER_MIGRATION)
            .unwrap()
    }

    #[test]
    fn concurrent_index_migration_does_not_use_a_transaction() {
        assert!(!message_filter_migration().metadata().run_in_transaction());
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
            let migration = message_filter_migration();
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
