//! Current membership grants history access, independently of archive or mute state.
use crate::schema::group_membership;
use diesel::prelude::*;

pub fn accessible_chat_ids(
    uid: i32,
) -> group_membership::BoxedQuery<'static, diesel::pg::Pg, diesel::sql_types::BigInt> {
    group_membership::table
        .filter(group_membership::uid.eq(uid))
        .select(group_membership::chat_id)
        .into_boxed()
}

pub fn list_accessible_chat_ids(conn: &mut PgConnection, uid: i32) -> QueryResult<Vec<i64>> {
    accessible_chat_ids(uid).load(conn)
}

pub fn filter_accessible_chat_ids(
    conn: &mut PgConnection,
    uid: i32,
    ids: &[i64],
) -> QueryResult<Vec<i64>> {
    accessible_chat_ids(uid)
        .filter(group_membership::chat_id.eq_any(ids))
        .load(conn)
}

pub fn member_uids(
    chat_id: i64,
) -> group_membership::BoxedQuery<'static, diesel::pg::Pg, diesel::sql_types::Integer> {
    group_membership::table
        .filter(group_membership::chat_id.eq(chat_id))
        .select(group_membership::uid)
        .into_boxed()
}

pub fn is_chat_member(conn: &mut PgConnection, chat_id: i64, uid: i32) -> QueryResult<bool> {
    diesel::select(diesel::dsl::exists(
        member_uids(chat_id).filter(group_membership::uid.eq(uid)),
    ))
    .get_result(conn)
}

pub fn require_chat_member(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
) -> Result<(), crate::errors::AppError> {
    if !is_chat_member(conn, chat_id, uid)? {
        return Err(crate::errors::AppError::Forbidden(
            "Not a member of this chat",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn membership_scope_includes_archived_and_excludes_departed_chats() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
            let ids = [9_876_995_001_i64, 9_876_995_002, 9_876_995_003];
            for id in ids {
                diesel::sql_query("INSERT INTO groups (id, name) VALUES ($1, 'access-test')")
                    .bind::<diesel::sql_types::BigInt, _>(id)
                    .execute(conn)?;
            }
            let uid = 987655;
            for (id, archived) in [(ids[0], false), (ids[1], true)] {
                diesel::sql_query(
                    "INSERT INTO group_membership (chat_id, uid, archived) VALUES ($1, $2, $3)",
                )
                .bind::<diesel::sql_types::BigInt, _>(id)
                .bind::<diesel::sql_types::Integer, _>(uid)
                .bind::<diesel::sql_types::Bool, _>(archived)
                .execute(conn)?;
            }
            let mut accessible = filter_accessible_chat_ids(conn, uid, &ids)?;
            accessible.sort();
            assert_eq!(accessible, ids[..2]);
            assert!(filter_accessible_chat_ids(conn, uid, &[])?.is_empty());
            diesel::delete(
                group_membership::table
                    .filter(group_membership::uid.eq(uid))
                    .filter(group_membership::chat_id.eq(ids[0])),
            )
            .execute(conn)?;
            assert_eq!(filter_accessible_chat_ids(conn, uid, &ids)?, vec![ids[1]]);
            assert!(list_accessible_chat_ids(conn, uid)?.contains(&ids[1]));
            Ok(())
        });
    }
}
