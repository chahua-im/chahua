use super::MIGRATIONS;
use diesel::{connection::SimpleConnection, Connection, PgConnection};
use diesel_migrations::MigrationHarness;

struct TempSchemaGuard {
    url: String,
    schema: String,
}

impl Drop for TempSchemaGuard {
    fn drop(&mut self) {
        if let Ok(mut conn) = PgConnection::establish(&self.url) {
            let _ = conn.batch_execute(&format!(
                "DROP SCHEMA IF EXISTS \"{}\" CASCADE",
                self.schema
            ));
        }
    }
}

#[test]
fn pending_migrations_ignore_removed_discuz_versions() {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    let schema = format!("migration_test_{}", uuid::Uuid::new_v4().simple());
    let _guard = TempSchemaGuard {
        url: url.clone(),
        schema: schema.clone(),
    };
    conn.batch_execute(&format!(
        "CREATE SCHEMA \"{schema}\";
         SET search_path TO \"{schema}\";
         CREATE TABLE __diesel_schema_migrations (
             version VARCHAR(50) PRIMARY KEY,
             run_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         INSERT INTO __diesel_schema_migrations (version) VALUES
             ('202603170558000000'),
             ('202603212347250000'),
             ('202603231200000000'),
             ('202608201200000000'),
             ('202609120550030000');"
    ))
    .unwrap();

    conn.run_pending_migrations(MIGRATIONS).unwrap();
}
