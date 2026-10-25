use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::PgConnection;
use uuid::Uuid;

use crate::dto::invites::InviteResponse;
use crate::errors::AppError;
use crate::models::{GroupKind, Invite, InviteType, NewInvite};
use crate::schema::{groups, invites};
use crate::utils::ids;
use crate::utils::ids::IdGen;

const INVITE_CODE_LEN: usize = 10;
const INVITE_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

pub fn invite_to_response(invite: Invite) -> InviteResponse {
    InviteResponse {
        id: invite.id,
        code: invite.code,
        chat_id: invite.chat_id,
        invite_type: invite.invite_type,
        creator_uid: invite.creator_uid,
        target_uid: invite.target_uid,
        required_chat_id: invite.required_chat_id,
        created_at: invite.created_at,
        expires_at: invite.expires_at,
        revoked_at: invite.revoked_at,
        used_at: invite.used_at,
    }
}

pub fn validate_invite_is_active(invite: &Invite, now: DateTime<Utc>) -> bool {
    invite.revoked_at.is_none() && invite.expires_at.is_none_or(|expires_at| expires_at > now)
}

pub fn targeted_invite_is_reusable(invite: &Invite, now: DateTime<Utc>) -> bool {
    invite.invite_type == InviteType::Targeted
        && invite.used_at.is_none()
        && validate_invite_is_active(invite, now)
}

pub fn find_active_targeted_invite(
    conn: &mut PgConnection,
    chat_id: i64,
    target_uid: i32,
    now: DateTime<Utc>,
) -> Result<Option<Invite>, AppError> {
    let invite = invites::table
        .filter(invites::chat_id.eq(chat_id))
        .filter(invites::target_uid.eq(Some(target_uid)))
        .filter(invites::invite_type.eq(InviteType::Targeted))
        .filter(invites::revoked_at.is_null())
        .filter(invites::used_at.is_null())
        .filter(
            invites::expires_at
                .is_null()
                .or(invites::expires_at.gt(now)),
        )
        .order((invites::created_at.desc(), invites::id.desc()))
        .select(Invite::as_select())
        .first::<Invite>(conn)
        .optional()?;

    Ok(invite.filter(|invite| targeted_invite_is_reusable(invite, now)))
}

pub async fn create_generic_invite(
    conn: &mut PgConnection,
    id_gen: &IdGen,
    chat_id: i64,
    creator_uid: i32,
    expires_at: Option<DateTime<Utc>>,
) -> Result<Invite, AppError> {
    create_invite(
        conn,
        id_gen,
        NewInviteInput {
            chat_id,
            invite_type: InviteType::Generic,
            creator_uid: Some(creator_uid),
            target_uid: None,
            required_chat_id: None,
            expires_at,
        },
    )
    .await
}

pub async fn create_targeted_invite(
    conn: &mut PgConnection,
    id_gen: &IdGen,
    chat_id: i64,
    target_uid: i32,
    creator_uid: Option<i32>,
    expires_at: Option<DateTime<Utc>>,
) -> Result<Invite, AppError> {
    create_invite(
        conn,
        id_gen,
        NewInviteInput {
            chat_id,
            invite_type: InviteType::Targeted,
            creator_uid,
            target_uid: Some(target_uid),
            required_chat_id: None,
            expires_at,
        },
    )
    .await
}

pub struct NewInviteInput {
    pub chat_id: i64,
    pub invite_type: InviteType,
    pub creator_uid: Option<i32>,
    pub target_uid: Option<i32>,
    pub required_chat_id: Option<i64>,
    pub expires_at: Option<DateTime<Utc>>,
}

pub async fn create_invite(
    conn: &mut PgConnection,
    id_gen: &IdGen,
    input: NewInviteInput,
) -> Result<Invite, AppError> {
    // Single choke point covering the user-facing endpoints and the
    // service-token external endpoint: no invite may ever target a DM, so
    // redeeming can never add a third member to one.
    let kind: GroupKind = groups::table
        .filter(groups::id.eq(input.chat_id))
        .select(groups::kind)
        .first(conn)?;
    if kind == GroupKind::Dm {
        return Err(AppError::BadRequest("DM chats cannot have invites"));
    }

    let id = ids::next_id(id_gen).await.map_err(|e| {
        tracing::error!("next_id for invite: {:?}", e);
        AppError::Internal("ID generation failed")
    })?;

    let now = Utc::now();
    insert_invite_with_codes(conn, id, now, input, generate_invite_code)
}

fn insert_invite_with_codes(
    conn: &mut PgConnection,
    id: i64,
    now: DateTime<Utc>,
    input: NewInviteInput,
    mut next_code: impl FnMut() -> String,
) -> Result<Invite, AppError> {
    for _ in 0..8 {
        let new_invite = NewInvite {
            id,
            code: next_code(),
            chat_id: input.chat_id,
            invite_type: input.invite_type.clone(),
            creator_uid: input.creator_uid,
            target_uid: input.target_uid,
            required_chat_id: input.required_chat_id,
            created_at: now,
            expires_at: input.expires_at,
            revoked_at: None,
            used_at: None,
        };

        match diesel::insert_into(invites::table)
            .values(&new_invite)
            .on_conflict(invites::code)
            .do_nothing()
            .returning(Invite::as_returning())
            .get_result::<Invite>(conn)
            .optional()
        {
            Ok(Some(invite)) => return Ok(invite),
            Ok(None) => continue,
            Err(error) => {
                tracing::error!("insert invite: {:?}", error);
                return Err(AppError::Internal("Failed to create invite"));
            }
        }
    }

    tracing::error!("failed to generate unique invite code after retries");
    Err(AppError::Internal("Failed to create invite"))
}

fn generate_invite_code() -> String {
    let mut code = String::with_capacity(INVITE_CODE_LEN);

    while code.len() < INVITE_CODE_LEN {
        for byte in Uuid::new_v4().into_bytes() {
            let idx = (byte as usize) % INVITE_CODE_ALPHABET.len();
            code.push(INVITE_CODE_ALPHABET[idx] as char);
            if code.len() == INVITE_CODE_LEN {
                break;
            }
        }
    }

    code
}

#[cfg(test)]
mod tests {
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
        let result =
            insert_invite_with_codes(tx.connection(), 2, Utc::now(), generic_input(), || {
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
        let result =
            insert_invite_with_codes(tx.connection(), 3, Utc::now(), generic_input(), || {
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
        let result =
            insert_invite_with_codes(tx.connection(), 1, Utc::now(), generic_input(), || {
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
}
