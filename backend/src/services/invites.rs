use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::PgConnection;
use uuid::Uuid;

use crate::dto::invites::InviteResponse;
use crate::errors::AppError;
use crate::models::{Invite, InviteType, NewInvite};
use crate::schema::invites;
use crate::utils::ids;
use crate::AppState;

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
    state: &AppState,
    chat_id: i64,
    creator_uid: i32,
    expires_at: Option<DateTime<Utc>>,
) -> Result<Invite, AppError> {
    create_invite(
        conn,
        state,
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
    state: &AppState,
    chat_id: i64,
    target_uid: i32,
    creator_uid: Option<i32>,
    expires_at: Option<DateTime<Utc>>,
) -> Result<Invite, AppError> {
    create_invite(
        conn,
        state,
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
    state: &AppState,
    input: NewInviteInput,
) -> Result<Invite, AppError> {
    let id = ids::next_id(state.id_gen.as_ref()).await.map_err(|e| {
        tracing::error!("next_id for invite: {:?}", e);
        AppError::Internal("ID generation failed")
    })?;

    let now = Utc::now();
    let mut inserted = None;

    for _ in 0..8 {
        let new_invite = NewInvite {
            id,
            code: generate_invite_code(),
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
            .returning(Invite::as_returning())
            .get_result::<Invite>(conn)
        {
            Ok(invite) => {
                inserted = Some(invite);
                break;
            }
            Err(error) if is_unique_violation(&error) => continue,
            Err(error) => {
                tracing::error!("insert invite: {:?}", error);
                return Err(AppError::Internal("Failed to create invite"));
            }
        }
    }

    inserted.ok_or_else(|| {
        tracing::error!("failed to generate unique invite code after retries");
        AppError::Internal("Failed to create invite")
    })
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

fn is_unique_violation(error: &diesel::result::Error) -> bool {
    matches!(
        error,
        diesel::result::Error::DatabaseError(diesel::result::DatabaseErrorKind::UniqueViolation, _)
    )
}

#[cfg(test)]
mod tests {
    use super::{targeted_invite_is_reusable, validate_invite_is_active};
    use crate::models::{Invite, InviteType};
    use chrono::{Duration, TimeZone, Utc};

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
