use std::sync::Arc;

use diesel::{
    prelude::*,
    sql_types::{Bool, Integer},
};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    dto::message_sync::{MessageSyncChange as Change, MessageSyncResetReason as ResetReason},
    errors::AppError,
    schema::{message_sync_change as change, message_sync_head as head, message_sync_meta as meta},
    services::{
        avatars::AvatarService, media::MediaStore, message_visibility::MessageVisibility,
        messages::attach_metadata, user::load_chat_viewer,
    },
    state::DbPool,
};

use super::cursor::{CursorKey, Position};

const REPLAY_LIMIT: i64 = 1024;

diesel::define_sql_function! {
    #[aggregate]
    fn bool_or(value: Bool) -> Bool;
}

#[derive(Clone)]
pub(crate) struct ReplayService {
    pub(super) pool: DbPool,
    pub(super) media: MediaStore,
    pub(super) avatars: Arc<AvatarService>,
    pub(super) key: CursorKey,
}

#[derive(Debug)]
pub(crate) enum Advance {
    Revoked,
    Reset { cursor: String, reason: ResetReason },
    Unchanged,
    Batch { to: String, changes: Vec<Change> },
}

impl ReplayService {
    pub(crate) fn new(
        pool: DbPool,
        media: MediaStore,
        avatars: Arc<AvatarService>,
        jwt_signing_key: &[u8],
    ) -> Self {
        Self {
            pool,
            media,
            avatars,
            key: CursorKey::new(jwt_signing_key),
        }
    }

    pub(crate) async fn advance(
        &self,
        uid: i32,
        chat_id: i64,
        cursor: Option<String>,
    ) -> Result<Advance, AppError> {
        self.snapshot(move |service, conn| {
            service.advance_in_snapshot(conn, uid, chat_id, cursor.as_deref())
        })
        .await
    }

    pub(super) async fn snapshot<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&Self, &mut PgConnection) -> Result<T, AppError> + Send + 'static,
    ) -> Result<T, AppError> {
        let service = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = service.pool.get()?;
            conn.build_transaction()
                .read_only()
                .repeatable_read()
                .run(|conn| operation(&service, conn))
        })
        .await
        .map_err(|error| {
            tracing::error!(?error, "message sync database worker failed");
            AppError::Internal("Message sync database worker failed")
        })?
    }

    pub(super) fn advance_in_snapshot(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        chat_id: i64,
        cursor: Option<&str>,
    ) -> Result<Advance, AppError> {
        let Some(viewer) = load_chat_viewer(conn, uid, chat_id)? else {
            return Ok(Advance::Revoked);
        };
        let (Some(joined_at), Some(role)) = (viewer.joined_at, viewer.role) else {
            return Ok(Advance::Revoked);
        };
        let visibility = MessageVisibility {
            kind: viewer.kind,
            show_membership_messages: viewer.settings.show_membership_messages,
            can_view_membership_messages: viewer.policy.can_view,
        };
        let (epoch, head, retained_after): (Uuid, Option<i64>, Option<i64>) = meta::table
            .left_join(head::table.on(head::chat_id.eq(chat_id)))
            .filter(meta::singleton.eq(true))
            .select((
                meta::epoch,
                head::head.nullable(),
                head::retained_after.nullable(),
            ))
            .first(conn)?;
        let head = head.unwrap_or(0);
        let fingerprint = serde_json::to_vec(&(
            joined_at.timestamp_micros(),
            &role,
            viewer.policy.visibility,
            visibility.show_membership_messages,
            visibility.kind,
        ))
        .expect("chat visibility fingerprint is serializable");
        let digest = Sha256::digest(fingerprint);
        let position = Position {
            e: epoch,
            u: uid,
            c: chat_id,
            h: head,
            f: digest[..16].try_into().unwrap(),
        };
        let reset = |reason| Advance::Reset {
            cursor: self.key.encode(&position),
            reason,
        };
        let from = match check_position(&self.key, &position, retained_after.unwrap_or(0), cursor) {
            Ok(from) => from,
            Err(reason) => return Ok(reset(reason)),
        };
        if from == head {
            return Ok(Advance::Unchanged);
        }
        let changed: Vec<(i64, bool)> = change::table
            .filter(change::chat_id.eq(chat_id))
            .filter(change::seq.gt(from).and(change::seq.le(head)))
            .group_by(change::message_id)
            .select((change::message_id, bool_or(change::created)))
            .order(change::message_id.asc())
            .limit(REPLAY_LIMIT + 1)
            .load(conn)?;
        if changed.len() > REPLAY_LIMIT as usize {
            return Ok(reset(ResetReason::TooLarge));
        }
        let rows =
            visibility.replay_rows(conn, chat_id, changed.iter().map(|entry| entry.0).collect())?;
        let mut changed = changed.into_iter().peekable();
        let mut changes = Vec::with_capacity(rows.len());
        let mut upserts = Vec::new();
        let mut appeared = Vec::new();
        for (row, visible) in rows {
            while changed.peek().is_some_and(|entry| entry.0 < row.id) {
                changed.next();
            }
            let (_, created) = changed
                .next()
                .expect("projected row was selected by change ID");
            if visible {
                appeared.push(created);
                upserts.push(row);
            } else {
                changes.push(Change::Delete {
                    message_id: row.id,
                    thread_root_id: row.reply_root_id,
                });
            }
        }
        if !upserts.is_empty() {
            let projected = futures::executor::block_on(attach_metadata(
                conn,
                upserts,
                &self.media,
                &self.avatars,
                uid,
            ));
            check_projection(conn)?;
            changes.extend(
                projected
                    .into_iter()
                    .zip(appeared)
                    .map(|(message, appeared)| Change::Upsert {
                        message: Box::new(message),
                        appeared,
                    }),
            );
        }
        Ok(Advance::Batch {
            to: self.key.encode(&position),
            changes,
        })
    }
}

fn check_position(
    key: &CursorKey,
    now: &Position,
    retained_after: i64,
    cursor: Option<&str>,
) -> Result<i64, ResetReason> {
    let token = cursor.ok_or(ResetReason::NoBaseline)?;
    let from = key.decode(token).ok_or(ResetReason::InvalidCursor)?;
    if from.e != now.e {
        return Err(ResetReason::EpochChanged);
    }
    if from.u != now.u || from.c != now.c || !(0..=now.h).contains(&from.h) {
        return Err(ResetReason::InvalidCursor);
    }
    if from.f != now.f {
        return Err(ResetReason::VisibilityChanged);
    }
    if from.h < retained_after {
        return Err(ResetReason::Expired);
    }
    if now.h - from.h > REPLAY_LIMIT {
        return Err(ResetReason::TooLarge);
    }
    Ok(from.h)
}

pub(super) fn check_projection(conn: &mut PgConnection) -> QueryResult<()> {
    // Legacy projection can swallow query errors. A failed transaction must
    // never produce a checkpoint, even when the projection returned a value.
    diesel::select(diesel::dsl::sql::<Integer>("1")).get_result::<i32>(conn)?;
    Ok(())
}
