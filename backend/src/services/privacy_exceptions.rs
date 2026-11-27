//! Caller-owned friendship overrides. Both canonical halves use existing UID indexes.
use diesel::prelude::*;

use crate::dto::friends::PrivacyExceptionKind;
use crate::schema::friendships;

pub fn list(
    conn: &mut PgConnection,
    uid: i32,
    kind: PrivacyExceptionKind,
) -> QueryResult<Vec<(i32, bool)>> {
    macro_rules! rows {
        ($owner:ident, $peer:ident, $column:ident) => {
            friendships::table
                .filter(friendships::$owner.eq(uid))
                .filter(friendships::$column.is_not_null())
                .select((friendships::$peer, friendships::$column.assume_not_null()))
                .load::<(i32, bool)>(conn)?
        };
    }
    let (mut first, second) = match kind {
        PrivacyExceptionKind::Presence => (
            rows!(uid1, uid2, uid1_shares_presence),
            rows!(uid2, uid1, uid2_shares_presence),
        ),
        PrivacyExceptionKind::ReadReceipts => (
            rows!(uid1, uid2, uid1_shares_read_receipts),
            rows!(uid2, uid1, uid2_shares_read_receipts),
        ),
    };
    first.extend(second);
    first.sort_unstable_by_key(|(peer, _)| *peer);
    Ok(first)
}

pub fn count(conn: &mut PgConnection, uid: i32, kind: PrivacyExceptionKind) -> QueryResult<i64> {
    macro_rules! count {
        ($owner:ident, $column:ident) => {
            friendships::table
                .filter(friendships::$owner.eq(uid))
                .filter(friendships::$column.is_not_null())
                .count()
                .get_result::<i64>(conn)?
        };
    }
    Ok(match kind {
        PrivacyExceptionKind::Presence => {
            count!(uid1, uid1_shares_presence) + count!(uid2, uid2_shares_presence)
        }
        PrivacyExceptionKind::ReadReceipts => {
            count!(uid1, uid1_shares_read_receipts) + count!(uid2, uid2_shares_read_receipts)
        }
    })
}

/// Capture the affected peers with UPDATE RETURNING in the same transaction as the reset.
pub fn clear(
    conn: &mut PgConnection,
    uid: i32,
    kind: PrivacyExceptionKind,
) -> QueryResult<Vec<i32>> {
    conn.transaction(|conn| {
        macro_rules! clear {
            ($owner:ident, $peer:ident, $column:ident) => {
                diesel::update(
                    friendships::table
                        .filter(friendships::$owner.eq(uid))
                        .filter(friendships::$column.is_not_null()),
                )
                .set(friendships::$column.eq(None::<bool>))
                .returning(friendships::$peer)
                .get_results::<i32>(conn)?
            };
        }
        let (mut first, second) = match kind {
            PrivacyExceptionKind::Presence => (
                clear!(uid1, uid2, uid1_shares_presence),
                clear!(uid2, uid1, uid2_shares_presence),
            ),
            PrivacyExceptionKind::ReadReceipts => (
                clear!(uid1, uid2, uid1_shares_read_receipts),
                clear!(uid2, uid1, uid2_shares_read_receipts),
            ),
        };
        first.extend(second);
        first.sort_unstable();
        Ok(first)
    })
}

#[cfg(test)]
mod tests;
