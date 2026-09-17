//! Shared helpers for database-backed integration tests.
//!
//! Gated on `WETTY_TEST_DATABASE_URL`: tests that need Postgres call
//! [`TestDb::establish`] and are skipped (with a notice) when the variable is
//! absent.
//!
//! The test database must be a dedicated Postgres database (in CI it is a
//! sidecar container). Every [`TestDb`] holds a session-level Postgres
//! advisory lock for its whole lifetime, so database-backed tests — including
//! migration runs and the DDL in the presence visibility round-trip — are
//! serialized across `cargo nextest`'s per-test processes instead of racing
//! on shared schema objects. Pending migrations run inside that lock before
//! the test body starts, so a test never sees a half-migrated database
//! regardless of which test executes first.

use diesel::connection::SimpleConnection;
use diesel::{Connection, PgConnection};
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};

const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");

/// Arbitrary fixed key for the test-serialization advisory lock. Any value
/// works as long as every test database helper agrees on it.
const TEST_DB_LOCK_KEY: i64 = 745_337_001;

/// A connection to the test database with pending migrations applied and the
/// cross-test advisory lock held until the guard is dropped.
pub struct TestDb {
    conn: Option<PgConnection>,
}

impl TestDb {
    /// Establishes the connection and migrates the database. Panics on
    /// connect or migration failure: a broken test database should fail the
    /// test loudly instead of silently skipping assertions.
    pub fn establish() -> Self {
        let url = match std::env::var("WETTY_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(_) => panic!(
                "skipping: WETTY_TEST_DATABASE_URL is not set \
                 (database-backed tests require a dedicated Postgres)"
            ),
        };
        let mut conn = PgConnection::establish(&url)
            .unwrap_or_else(|err| panic!("connect to test database: {err}"));
        conn.batch_execute(&format!("SELECT pg_advisory_lock({TEST_DB_LOCK_KEY})"))
            .unwrap_or_else(|err| panic!("acquire test database lock: {err}"));
        // The lock is held by this session, so no other test process can run
        // migrations concurrently. Pending migrations are a no-op once
        // applied, so every test pays only a round trip after the first.
        conn.run_pending_migrations(MIGRATIONS)
            .unwrap_or_else(|err| panic!("migrate test database: {err}"));
        Self { conn: Some(conn) }
    }

    /// Borrowed connection for the test body.
    pub fn conn(&mut self) -> &mut PgConnection {
        self.conn
            .as_mut()
            .expect("test database connection is held until teardown")
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        // Closing the connection releases the session advisory lock; the
        // explicit unlock keeps the invariant obvious and reports failures.
        if let Some(mut conn) = self.conn.take() {
            if let Err(err) =
                conn.batch_execute(&format!("SELECT pg_advisory_unlock({TEST_DB_LOCK_KEY})"))
            {
                eprintln!("failed to release test database lock: {err}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_db_migrates_the_database_under_the_lock() {
        let mut db = match std::env::var("WETTY_TEST_DATABASE_URL") {
            Ok(_) => TestDb::establish(),
            Err(_) => {
                eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
                return;
            }
        };
        use diesel::prelude::*;
        #[derive(QueryableByName)]
        struct Present {
            #[diesel(sql_type = diesel::sql_types::Bool)]
            present: bool,
        }
        let rows: Vec<Present> =
            diesel::sql_query("SELECT to_regclass('user_extra') IS NOT NULL AS present")
                .load(db.conn())
                .expect("check user_extra after migrations");
        assert!(
            rows.first().map(|row| row.present).unwrap_or_default(),
            "user_extra must exist once migrations have run"
        );
    }
}
