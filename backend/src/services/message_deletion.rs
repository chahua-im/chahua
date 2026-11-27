//! Shared batch deletion and reconciliation for recalls and member cleanup.

use std::collections::{BTreeMap, BTreeSet};

use chrono::Utc;
use diesel::prelude::*;

use crate::{
    errors::AppError,
    models::{Message, MessageType},
    schema::{attachments, group_membership, groups, message_mentions, messages},
    services::{chat, threads},
};

pub struct BulkDeletion {
    pub impact: DeletionImpact,
    pub member_uids: Vec<i32>,
    pub roots: Vec<Message>,
}

/// Only the columns needed for authorization and deletion bookkeeping.
#[derive(Queryable, Selectable)]
#[diesel(table_name = messages)]
pub struct DeletionTarget {
    pub id: i64,
    pub sender_uid: i32,
    pub is_published: bool,
    message_type: MessageType,
    reply_root_id: Option<i64>,
    has_thread: bool,
}

#[derive(Default)]
pub struct DeletionImpact {
    pub message_ids: Vec<i64>,
    pub thread_root_ids: BTreeSet<i64>,
    reply_ids: BTreeMap<i64, Vec<i64>>,
    chat_message_ids: Vec<i64>,
}

impl DeletionImpact {
    pub fn merge(&mut self, batch: Self) {
        self.message_ids.extend(batch.message_ids);
        self.thread_root_ids.extend(batch.thread_root_ids);
        self.chat_message_ids.extend(batch.chat_message_ids);
        for (root_id, ids) in batch.reply_ids {
            self.reply_ids.entry(root_id).or_default().extend(ids);
        }
    }
}

pub fn validate_deletable_message_type(message_type: &MessageType) -> Result<(), AppError> {
    if matches!(message_type, MessageType::System) {
        return Err(AppError::BadRequest("Cannot delete system message"));
    }
    Ok(())
}

/// The caller must load and lock targets from one chat in its transaction,
/// applying the entry point's authorization and publication rules first.
/// This function neither commits nor publishes events.
pub fn soft_delete_batch(
    conn: &mut PgConnection,
    targets: &[DeletionTarget],
) -> Result<DeletionImpact, AppError> {
    // Validate the entire batch before any writes or deletion bookkeeping.
    for message in targets {
        validate_deletable_message_type(&message.message_type)?;
    }
    let mut impact = DeletionImpact::default();
    for message in targets {
        impact.message_ids.push(message.id);
        if let Some(root_id) = message.reply_root_id {
            impact.thread_root_ids.insert(root_id);
            impact
                .reply_ids
                .entry(root_id)
                .or_default()
                .push(message.id);
        } else {
            impact.chat_message_ids.push(message.id);
            if message.has_thread {
                impact.thread_root_ids.insert(message.id);
            }
        }
    }

    let ids = &impact.message_ids;
    let now = Utc::now();
    diesel::update(
        messages::table
            .filter(messages::id.eq_any(ids))
            .filter(messages::deleted_at.is_null()),
    )
    .set(messages::deleted_at.eq(now))
    .execute(conn)?;
    diesel::delete(message_mentions::table.filter(message_mentions::message_id.eq_any(ids)))
        .execute(conn)?;
    diesel::update(
        attachments::table
            .filter(attachments::message_id.eq_any(ids))
            .filter(attachments::deleted_at.is_null()),
    )
    .set(attachments::deleted_at.eq(now))
    .execute(conn)?;
    Ok(impact)
}

/// Reconcile once for the complete deleted set, inside the caller's transaction.
/// Member cleanup merges its committed batches before calling this function.
pub fn reconcile_deletions(
    conn: &mut PgConnection,
    chat_id: i64,
    impact: &DeletionImpact,
) -> Result<(), AppError> {
    for (&root_id, deleted_ids) in &impact.reply_ids {
        threads::recalculate_thread_meta(conn, chat_id, root_id)?;
        threads::shift_thread_read_pointers_on_delete(conn, root_id, deleted_ids)?;
    }

    // Deleting the last reply can hide a previously deleted root outside the
    // selection. Re-read visibility after recalculating the thread statistics.
    let chat_ids: Vec<i64> = impact
        .chat_message_ids
        .iter()
        .chain(&impact.thread_root_ids)
        .copied()
        .collect();
    let hidden_chat_ids: Vec<i64> = messages::table
        .filter(messages::id.eq_any(&chat_ids))
        .filter(messages::has_thread.eq(false))
        .filter(messages::deleted_at.is_not_null())
        .select(messages::id)
        .load(conn)?;
    if !hidden_chat_ids.is_empty() {
        chat::shift_chat_read_pointers_on_delete(conn, chat_id, &hidden_chat_ids)?;
    }
    let last_id: Option<i64> = groups::table
        .find(chat_id)
        .select(groups::last_message_id)
        .first(conn)?;
    if last_id.is_some_and(|id| impact.message_ids.contains(&id)) {
        chat::recalculate_group_last_message(conn, chat_id)?;
    }
    Ok(())
}

pub fn validate_message_ids(mut ids: Vec<i64>) -> Result<Vec<i64>, AppError> {
    if ids.is_empty() || ids.len() > 100 {
        return Err(AppError::BadRequest("Select between 1 and 100 messages"));
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

/// The caller has checked chat membership and writability. Validate the entire
/// selection before writing; already deleted messages make retries idempotent.
pub fn delete_selection(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
    is_admin: bool,
    ids: &[i64],
) -> Result<BulkDeletion, AppError> {
    conn.transaction(|conn| {
        let selected: Vec<DeletionTarget> = messages::table
            .filter(messages::chat_id.eq(chat_id))
            .filter(messages::id.eq_any(ids))
            .order(messages::id.asc())
            .for_update()
            .select(DeletionTarget::as_select())
            .load(conn)?;
        if selected.len() != ids.len() {
            return Err(AppError::NotFound("Message not found"));
        }
        if !is_admin && selected.iter().any(|message| message.sender_uid != uid) {
            return Err(AppError::Forbidden("You can only delete your own messages"));
        }
        if selected.iter().any(|message| !message.is_published) {
            return Err(AppError::BadRequest("Cannot delete unpublished message"));
        }

        let impact = soft_delete_batch(conn, &selected)?;
        reconcile_deletions(conn, chat_id, &impact)?;

        let roots = messages::table
            .filter(messages::id.eq_any(&impact.thread_root_ids))
            .select(Message::as_select())
            .load(conn)?;
        let member_uids = group_membership::table
            .filter(group_membership::chat_id.eq(chat_id))
            .select(group_membership::uid)
            .load(conn)?;
        Ok(BulkDeletion {
            impact,
            member_uids,
            roots,
        })
    })
}

#[cfg(test)]
mod tests;
