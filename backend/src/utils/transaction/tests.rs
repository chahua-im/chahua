use super::*;
use diesel::connection::SimpleConnection;
use diesel::prelude::*;

fn connection() -> Option<PgConnection> {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return None;
    };
    Some(PgConnection::establish(&url).expect("connect to test database"))
}

#[derive(QueryableByName)]
struct Count {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    count: i64,
}

fn count(conn: &mut PgConnection) -> i64 {
    diesel::sql_query("SELECT count(*) FROM transaction_guard_test")
        .get_result::<Count>(conn)
        .unwrap()
        .count
}

#[test]
fn database_commits_success_and_rolls_back_application_and_sql_errors() {
    let Some(mut conn) = connection() else { return };
    conn.batch_execute("CREATE TEMP TABLE transaction_guard_test (id integer UNIQUE)")
        .unwrap();
    let mut tx = AsyncTransaction::begin(&mut conn).unwrap();
    tx.connection()
        .batch_execute("INSERT INTO transaction_guard_test VALUES (1)")
        .unwrap();
    tx.finish(Ok(())).unwrap();
    assert_eq!(count(&mut conn), 1);

    let mut tx = AsyncTransaction::begin(&mut conn).unwrap();
    tx.connection()
        .batch_execute("INSERT INTO transaction_guard_test VALUES (2)")
        .unwrap();
    assert!(matches!(
        tx.finish::<()>(Err(AppError::BadRequest("test"))),
        Err(AppError::BadRequest("test"))
    ));
    assert_eq!(count(&mut conn), 1);

    let mut tx = AsyncTransaction::begin(&mut conn).unwrap();
    let result = tx.connection().batch_execute("INSERT INTO transaction_guard_test VALUES (2); INSERT INTO transaction_guard_test VALUES (1)");
    assert!(tx.finish(result.map_err(AppError::from)).is_err());
    assert_eq!(count(&mut conn), 1);

    // A nested Diesel transaction must be a savepoint, not commit the outer write.
    let mut tx = AsyncTransaction::begin(&mut conn).unwrap();
    tx.connection()
        .transaction::<_, diesel::result::Error, _>(|conn| {
            conn.batch_execute("INSERT INTO transaction_guard_test VALUES (3)")
        })
        .unwrap();
    drop(tx);
    assert_eq!(count(&mut conn), 1);
}

#[test]
fn database_commit_failure_does_not_leave_partial_writes_or_an_open_transaction() {
    let Some(mut conn) = connection() else { return };
    conn.batch_execute("CREATE TEMP TABLE transaction_guard_test (id integer UNIQUE DEFERRABLE INITIALLY DEFERRED)").unwrap();
    let mut tx = AsyncTransaction::begin(&mut conn).unwrap();
    tx.connection()
        .batch_execute("INSERT INTO transaction_guard_test VALUES (1), (1)")
        .unwrap();
    assert!(tx.finish(Ok(())).is_err());
    assert_eq!(count(&mut conn), 0);
    // Reusing the connection must open a real transaction, not a stale savepoint.
    let mut tx = AsyncTransaction::begin(&mut conn).unwrap();
    tx.connection()
        .batch_execute("INSERT INTO transaction_guard_test VALUES (2)")
        .unwrap();
    tx.finish(Ok(())).unwrap();
    assert_eq!(count(&mut conn), 1);
}

#[tokio::test]
async fn database_cancelled_future_rolls_back_writes_and_releases_locks() {
    let Some(mut conn) = connection() else { return };
    let mut other = connection().unwrap();
    conn.batch_execute("CREATE TEMP TABLE transaction_guard_test (id integer)")
        .unwrap();
    let mut request = Box::pin(async {
        let mut tx = AsyncTransaction::begin(&mut conn).unwrap();
        tx.connection().batch_execute("INSERT INTO transaction_guard_test VALUES (1); SELECT pg_advisory_xact_lock(908172635)").unwrap();
        std::future::pending::<()>().await;
        tx.finish(Ok(())).unwrap();
    });
    assert!(futures::poll!(&mut request).is_pending());
    drop(request);
    assert_eq!(count(&mut conn), 0);
    other
        .transaction::<_, diesel::result::Error, _>(|conn| {
            conn.batch_execute(
                "SET LOCAL lock_timeout = '150ms'; SELECT pg_advisory_xact_lock(908172635)",
            )
        })
        .unwrap();
}
