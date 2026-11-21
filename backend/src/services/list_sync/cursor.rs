use diesel::{sql_types::BigInt, QueryableByName};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{dto::list_sync::ListSyncResetReason as ResetReason, services::sync_cursor::CursorKey};

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    QueryableByName,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Key {
    #[diesel(sql_type = BigInt)]
    pub chat_id: i64,
    #[diesel(sql_type = BigInt)]
    pub thread_root_id: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Mode {
    Baseline { last: Option<Key> },
    Delta,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Position {
    pub e: Uuid,
    pub u: i32,
    pub s: i64,
    pub mode: Mode,
}

pub(super) fn validate(
    key: &CursorKey,
    now: Position,
    retained_after: i64,
    account_seq: i64,
    token: Option<&str>,
) -> Result<Position, ResetReason> {
    let from: Position = key
        .decode(token.ok_or(ResetReason::NoBaseline)?)
        .ok_or(ResetReason::InvalidCursor)?;
    if from.u != now.u
        || from.s < 0
        || matches!(from.mode,
        Mode::Baseline { last: Some(last) } if last.chat_id <= 0 || last.thread_root_id < 0)
    {
        return Err(ResetReason::InvalidCursor);
    }
    // A restored database can have a lower head. An authentic same-account
    // token from its former epoch must still identify that reset correctly.
    if from.e != now.e {
        return Err(ResetReason::EpochChanged);
    }
    if from.s > now.s {
        return Err(ResetReason::InvalidCursor);
    }
    if from.s < retained_after {
        return Err(ResetReason::Expired);
    }
    if from.s < account_seq {
        return Err(ResetReason::AccountChanged);
    }
    Ok(from)
}
