use diesel::{prelude::*, sql_types::Integer};

pub(crate) fn check_projection(conn: &mut PgConnection) -> QueryResult<()> {
    // Legacy projection can swallow query errors. A failed transaction must
    // never produce a checkpoint, even when the projection returned a value.
    diesel::select(diesel::dsl::sql::<Integer>("1")).get_result::<i32>(conn)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::connection::SimpleConnection;

    #[test]
    fn list_sync_failed_projection_cannot_pass_checkpoint_probe() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.batch_execute("BEGIN").unwrap();
        // Legacy enrichment can turn a database error into an empty collection.
        let _ = diesel::sql_query("SELECT 1 / 0").execute(&mut conn);
        assert!(check_projection(&mut conn).is_err());
        conn.batch_execute("ROLLBACK").unwrap();
    }
}
