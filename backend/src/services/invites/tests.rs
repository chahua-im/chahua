use super::*;
use crate::models::{Invite, InviteType};
use crate::utils::transaction::AsyncTransaction;
use chrono::{Duration, TimeZone, Utc};
use diesel::connection::SimpleConnection;

fn fixture() -> Option<PgConnection> {
    let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return None;
    };
    let mut conn = PgConnection::establish(&url).unwrap();
    conn.batch_execute(
        "CREATE TEMP TABLE invites (LIKE public.invites INCLUDING ALL);
             INSERT INTO invites (id, code, chat_id, invite_type)
                 VALUES (1, 'collision', 10, 'generic');",
    )
    .unwrap();
    Some(conn)
}

fn generic_input() -> NewInviteInput {
    NewInviteInput {
        chat_id: 10,
        invite_type: InviteType::Generic,
        creator_uid: None,
        target_uid: None,
        required_chat_id: None,
        expires_at: None,
    }
}

#[test]
fn database_code_collision_retries_without_aborting_the_send_transaction() {
    let Some(mut conn) = fixture() else { return };
    let mut tx = AsyncTransaction::begin(&mut conn).unwrap();
    let mut codes = ["collision", "fresh-code"].into_iter();
    let result = insert_invite_with_codes(tx.connection(), 2, Utc::now(), generic_input(), || {
        codes.next().unwrap().into()
    });
    let invite = tx.finish(result).unwrap();
    assert_eq!(invite.code, "fresh-code");
    assert_eq!(
        invites::table.count().get_result::<i64>(&mut conn).unwrap(),
        2
    );

    // Exhausting code retries is bounded and leaves SQL usable for rollback.
    let mut attempts = 0;
    let mut tx = AsyncTransaction::begin(&mut conn).unwrap();
    let result = insert_invite_with_codes(tx.connection(), 3, Utc::now(), generic_input(), || {
        attempts += 1;
        "collision".into()
    });
    assert!(result.is_err());
    assert_eq!(attempts, 8);
    assert_eq!(
        invites::table
            .count()
            .get_result::<i64>(tx.connection())
            .unwrap(),
        2
    );
    assert!(tx.finish(result).is_err());
}

#[test]
fn database_non_code_unique_violation_is_not_retried() {
    let Some(mut conn) = fixture() else { return };
    let mut attempts = 0;
    let mut tx = AsyncTransaction::begin(&mut conn).unwrap();
    let result = insert_invite_with_codes(tx.connection(), 1, Utc::now(), generic_input(), || {
        attempts += 1;
        "fresh-code".into()
    });
    assert!(tx.finish(result).is_err());
    assert_eq!(attempts, 1);
    assert_eq!(
        invites::table.count().get_result::<i64>(&mut conn).unwrap(),
        1
    );
}

fn invite(invite_type: InviteType) -> Invite {
    Invite {
        id: 1,
        code: "ABCDEFGHJK".to_string(),
        chat_id: 10,
        invite_type,
        creator_uid: None,
        target_uid: Some(42),
        required_chat_id: None,
        created_at: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
        expires_at: None,
        revoked_at: None,
        used_at: None,
    }
}

#[test]
fn active_invite_rejects_revoked_or_expired() {
    let now = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
    let mut value = invite(InviteType::Targeted);
    assert!(validate_invite_is_active(&value, now));

    value.revoked_at = Some(now);
    assert!(!validate_invite_is_active(&value, now));

    value.revoked_at = None;
    value.expires_at = Some(now - Duration::seconds(1));
    assert!(!validate_invite_is_active(&value, now));
}

#[test]
fn reusable_targeted_invite_requires_targeted_unused_and_active() {
    let now = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
    let mut value = invite(InviteType::Targeted);
    assert!(targeted_invite_is_reusable(&value, now));

    value.used_at = Some(now);
    assert!(!targeted_invite_is_reusable(&value, now));

    value.used_at = None;
    value.invite_type = InviteType::Generic;
    assert!(!targeted_invite_is_reusable(&value, now));
}
