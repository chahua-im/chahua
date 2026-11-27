use std::sync::Arc;

use diesel::{prelude::*, sql_types::Bool};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    dto::message_sync::{MessageSyncChange as Change, MessageSyncResetReason as ResetReason},
    errors::AppError,
    schema::{message_sync_change as change, message_sync_head as head, message_sync_meta as meta},
    services::{
        avatars::AvatarService, media::MediaStore, message_visibility::MessageVisibility,
        messages::attach_metadata, sync_cursor::CursorKey, sync_projection::check_projection,
        user::load_chat_viewer,
    },
    state::DbPool,
};

use super::cursor::Position;

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
pub(crate) struct ReplayBatch {
    pub to: String,
    pub changes: Vec<Change>,
}

#[derive(Debug)]
pub(crate) enum Advance {
    Revoked,
    Reset { cursor: String, reason: ResetReason },
    Unchanged,
    Batches(Vec<ReplayBatch>),
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
            key: CursorKey::new(jwt_signing_key, b"chahua.message-sync.cursor.v1"),
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
        let changed: Vec<(i64, bool, Option<i64>)> = change::table
            .filter(change::chat_id.eq(chat_id))
            .filter(change::seq.gt(from).and(change::seq.le(head)))
            .group_by(change::message_id)
            .select((
                change::message_id,
                bool_or(change::created),
                diesel::dsl::min(change::seq),
            ))
            .order(change::message_id.asc())
            .limit(REPLAY_LIMIT + 1)
            .load(conn)?;
        if changed.len() > REPLAY_LIMIT as usize {
            return Ok(reset(ResetReason::TooLarge));
        }
        let rows =
            visibility.replay_rows(conn, chat_id, changed.iter().map(|entry| entry.0).collect())?;
        let mut changed = changed.into_iter().peekable();
        let mut sequenced_changes = Vec::with_capacity(rows.len());
        let mut upserts = Vec::new();
        let mut upsert_meta = Vec::new();
        for (row, visible) in rows {
            while changed.peek().is_some_and(|entry| entry.0 < row.id) {
                changed.next();
            }
            let (_, created, min_seq) = changed
                .next()
                .expect("projected row was selected by change ID");
            let min_seq = min_seq.expect("nonempty change group has sequence");
            if visible {
                upsert_meta.push((min_seq, row.id, created));
                upserts.push(row);
            } else {
                sequenced_changes.push((
                    min_seq,
                    row.id,
                    Change::Delete {
                        message_id: row.id,
                        thread_root_id: row.reply_root_id,
                    },
                ));
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
            sequenced_changes.extend(projected.into_iter().zip(upsert_meta).map(
                |(message, (min_seq, id, appeared))| {
                    (
                        min_seq,
                        id,
                        Change::Upsert {
                            message: Box::new(message),
                            appeared,
                        },
                    )
                },
            ));
        }
        match pack_replay_batches(
            chat_id,
            cursor.expect("validated cursor"),
            &position,
            &self.key,
            sequenced_changes,
            crate::rpc::session::MAX_FRAME_BYTES,
        ) {
            Ok(batches) => Ok(Advance::Batches(batches)),
            Err(reason) => Ok(reset(reason)),
        }
    }
}

fn pack_replay_batches(
    chat_id: i64,
    from_cursor: &str,
    position: &Position,
    key: &CursorKey,
    mut items: Vec<(i64, i64, Change)>,
    max_frame_bytes: usize,
) -> Result<Vec<ReplayBatch>, ResetReason> {
    let head_cursor = key.encode(position);
    if items.is_empty() {
        return Ok(vec![ReplayBatch {
            to: head_cursor,
            changes: Vec::new(),
        }]);
    }
    items.sort_by_key(|(seq, id, _)| (*seq, *id));

    let mut groups: Vec<(i64, Vec<Change>)> = Vec::new();
    for (seq, _, change) in items {
        if let Some((last_seq, changes)) =
            groups.last_mut().filter(|(last_seq, _)| *last_seq == seq)
        {
            let _ = last_seq;
            changes.push(change);
        } else {
            groups.push((seq, vec![change]));
        }
    }

    let max_from = if from_cursor.len() >= head_cursor.len() {
        from_cursor
    } else {
        &head_cursor
    };
    let envelope_bytes =
        crate::rpc::events::encode_event(&crate::dto::ws::ServerWsMessage::MessageSyncBatch(
            crate::dto::message_sync::MessageSyncBatch {
                chat_id,
                from: max_from.to_owned(),
                to: head_cursor.clone(),
                changes: Vec::new(),
            },
        ))
        .expect("empty sync batch encodes")
        .len();

    let mut batches = Vec::new();
    let mut current_changes = Vec::new();
    let mut current_bytes = 0usize;
    let mut current_last_seq = 0i64;

    for (seq, group_changes) in groups {
        let mut group_bytes = group_changes.len().saturating_sub(1);
        for change in &group_changes {
            group_bytes += serde_json::to_vec(change)
                .expect("sync change serializes")
                .len();
        }
        if envelope_bytes + group_bytes > max_frame_bytes {
            return Err(ResetReason::TooLarge);
        }
        let added_bytes = if current_changes.is_empty() {
            group_bytes
        } else {
            1 + group_bytes
        };
        if !current_changes.is_empty()
            && envelope_bytes + current_bytes + added_bytes > max_frame_bytes
        {
            let to = key.encode(&Position {
                h: current_last_seq,
                ..position.clone()
            });
            batches.push(ReplayBatch {
                to,
                changes: std::mem::take(&mut current_changes),
            });
            current_changes = group_changes;
            current_bytes = group_bytes;
            current_last_seq = seq;
        } else {
            current_changes.extend(group_changes);
            current_bytes += added_bytes;
            current_last_seq = seq;
        }
    }

    batches.push(ReplayBatch {
        to: head_cursor,
        changes: current_changes,
    });
    Ok(batches)
}

fn check_position(
    key: &CursorKey,
    now: &Position,
    retained_after: i64,
    cursor: Option<&str>,
) -> Result<i64, ResetReason> {
    let token = cursor.ok_or(ResetReason::NoBaseline)?;
    let from: Position = key.decode(token).ok_or(ResetReason::InvalidCursor)?;
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

#[cfg(test)]
mod tests;
