mod metrics;
pub use metrics::BackgroundMetrics;

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::PgConnection;
use futures::future::FutureExt;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use crate::dto::ws::{BulkDeletedPayload, ServerWsMessage};
use crate::schema::{group_membership, messages};
use crate::services::message_deletion::{
    reconcile_deletions, soft_delete_batch, DeletionImpact, DeletionTarget,
};
use crate::services::message_search::MessageSearchService;
use crate::services::unread::UnreadService;
use crate::services::ws_registry::ConnectionRegistry;

const CHANNEL_BUFFER: usize = 64;
const BATCH_SIZE: i64 = 500;
const WORKER_RESTART_DELAY: Duration = Duration::from_secs(1);

// ---------------------------------------------------------------------------
// Job definitions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub enum DeleteScope {
    All,
    Last24Hours,
}

/// A background job that can be enqueued for async processing.
pub enum BackgroundJob {
    /// Soft-delete messages from a removed member, in batches.
    BulkDeleteMessages {
        chat_id: i64,
        target_uid: i32,
        scope: DeleteScope,
    },
    // Future variants: CleanupStaleUploads, CompressMedia, etc.
}

impl BackgroundJob {
    /// Label used for metrics.
    fn kind(&self) -> &'static str {
        match self {
            BackgroundJob::BulkDeleteMessages { .. } => "bulk_delete_messages",
        }
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

pub struct BackgroundService {
    job_tx: mpsc::Sender<BackgroundJob>,
}

impl BackgroundService {
    pub fn start(
        db: Pool<ConnectionManager<PgConnection>>,
        ws_registry: Arc<ConnectionRegistry>,
        metrics: Arc<BackgroundMetrics>,
        message_search: Option<Arc<MessageSearchService>>,
        unread_service: Arc<UnreadService>,
    ) -> Arc<Self> {
        let (tx, rx) = mpsc::channel(CHANNEL_BUFFER);

        let service = Arc::new(Self { job_tx: tx });

        tokio::spawn(async move {
            supervise_worker(rx, db, ws_registry, metrics, message_search, unread_service).await;
        });

        service
    }

    /// Enqueue a background job. Non-blocking; logs a warning if the channel is full.
    pub fn enqueue(&self, job: BackgroundJob) {
        if let Err(e) = self.job_tx.try_send(job) {
            warn!("Background job channel full, dropping job: {}", e);
        }
    }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/// Supervisor loop: catches panics from the worker and restarts it.
async fn supervise_worker(
    mut rx: mpsc::Receiver<BackgroundJob>,
    db: Pool<ConnectionManager<PgConnection>>,
    ws_registry: Arc<ConnectionRegistry>,
    metrics: Arc<BackgroundMetrics>,
    message_search: Option<Arc<MessageSearchService>>,
    unread_service: Arc<UnreadService>,
) {
    loop {
        let worker_result = std::panic::AssertUnwindSafe(run_worker(
            &mut rx,
            &db,
            &ws_registry,
            &metrics,
            &message_search,
            &unread_service,
        ))
        .catch_unwind()
        .await;

        match worker_result {
            Ok(()) => {
                info!("Background worker stopped (channel closed)");
                return;
            }
            Err(payload) => {
                let panic_message = super::push::panic_payload_message(payload.as_ref());
                error!(
                    "Background worker panicked; restarting in {}s: {}",
                    WORKER_RESTART_DELAY.as_secs(),
                    panic_message
                );
                tokio::time::sleep(WORKER_RESTART_DELAY).await;
            }
        }
    }
}

/// Main worker loop: pulls jobs from the channel and dispatches them.
async fn run_worker(
    rx: &mut mpsc::Receiver<BackgroundJob>,
    db: &Pool<ConnectionManager<PgConnection>>,
    ws_registry: &Arc<ConnectionRegistry>,
    metrics: &Arc<BackgroundMetrics>,
    message_search: &Option<Arc<MessageSearchService>>,
    unread_service: &Arc<UnreadService>,
) {
    while let Some(job) = rx.recv().await {
        let job_kind = job.kind();
        let started_at = std::time::Instant::now();

        let result = match &job {
            BackgroundJob::BulkDeleteMessages {
                chat_id,
                target_uid,
                scope,
            } => process_bulk_delete(
                *chat_id,
                *target_uid,
                *scope,
                db,
                ws_registry,
                message_search,
                unread_service,
            ),
        };

        let duration = started_at.elapsed().as_secs_f64();
        match &result {
            Ok(()) => {
                metrics.record_job(job_kind, "success", duration);
            }
            Err(e) => {
                metrics.record_job(job_kind, "failure", duration);
                error!(job_kind, "Background job failed: {}", e);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

/// Soft-delete messages from a user in a chat, in batches of BATCH_SIZE.
fn process_bulk_delete(
    chat_id: i64,
    target_uid: i32,
    scope: DeleteScope,
    db: &Pool<ConnectionManager<PgConnection>>,
    ws_registry: &Arc<ConnectionRegistry>,
    message_search: &Option<Arc<MessageSearchService>>,
    unread_service: &Arc<UnreadService>,
) -> Result<(), String> {
    use crate::schema::group_membership::dsl as gm_dsl;
    use crate::schema::messages::dsl;

    let conn = &mut db.get().map_err(|e| format!("pool error: {e}"))?;
    let map_db = |e: diesel::result::Error| format!("db error: {e}");

    let member_uids: Vec<i32> = group_membership::table
        .filter(gm_dsl::chat_id.eq(chat_id))
        .select(group_membership::uid)
        .load(conn)
        .map_err(map_db)?;

    let mut impact = DeletionImpact::default();
    loop {
        // Match recall's ascending lock order when the two paths overlap.
        // Selection and mutation share a transaction so reconciliation uses
        // metadata from the locked messages we actually delete.
        let batch = conn
            .transaction::<_, diesel::result::Error, _>(|conn| {
                let query = messages::table
                    .filter(dsl::chat_id.eq(chat_id))
                    .filter(dsl::sender_uid.eq(target_uid))
                    .filter(dsl::deleted_at.is_null())
                    .select(DeletionTarget::as_select())
                    .order(dsl::id.asc())
                    .limit(BATCH_SIZE)
                    .for_update();

                let targets: Vec<DeletionTarget> = match scope {
                    DeleteScope::All => query.load(conn)?,
                    DeleteScope::Last24Hours => {
                        let cutoff = Utc::now() - chrono::Duration::hours(24);
                        query.filter(dsl::created_at.ge(cutoff)).load(conn)?
                    }
                };
                if targets.is_empty() {
                    return Ok(DeletionImpact::default());
                }
                soft_delete_batch(conn, &targets)
            })
            .map_err(map_db)?;
        let batch_len = batch.message_ids.len();
        if batch_len == 0 {
            break;
        }

        if let Some(search_service) = message_search {
            search_service.delete_message_ids_best_effort(batch.message_ids.clone());
        }
        ws_registry.broadcast_to_uids(
            &member_uids,
            Arc::new(ServerWsMessage::MessagesBulkDeleted(BulkDeletedPayload {
                complete: Some(false),
                thread_root_ids: None,
                chat_id: chat_id.to_string(),
                message_ids: batch.message_ids.iter().map(i64::to_string).collect(),
            })),
        );
        impact.merge(batch);

        if (batch_len as i64) < BATCH_SIZE {
            break;
        }
    }

    if !impact.message_ids.is_empty() {
        // Deletions have committed; invalidate even if final reconciliation fails.
        unread_service.invalidate_chat(chat_id);
        conn.transaction(|conn| reconcile_deletions(conn, chat_id, &impact))
            .map_err(|e| format!("reconcile bulk deletion: {e:?}"))?;

        for &thread_root_id in &impact.thread_root_ids {
            if let Err(e) = crate::services::threads::broadcast_thread_update_to_uids(
                conn,
                ws_registry,
                &member_uids,
                chat_id,
                thread_root_id,
            ) {
                warn!(
                    chat_id,
                    thread_root_id,
                    ?e,
                    "broadcast thread update after bulk delete"
                );
            }
        }

        ws_registry.broadcast_to_uids(
            &member_uids,
            Arc::new(ServerWsMessage::MessagesBulkDeleted(BulkDeletedPayload {
                chat_id: chat_id.to_string(),
                message_ids: vec![],
                complete: Some(true),
                thread_root_ids: Some(impact.thread_root_ids.iter().map(i64::to_string).collect()),
            })),
        );
        info!(
            chat_id,
            target_uid,
            total_deleted = impact.message_ids.len(),
            "Bulk message deletion completed"
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;
    use crate::schema::{attachments, groups, message_mentions, thread_meta, thread_user_states};
    use crate::services::ws_registry::WsMetrics;
    use diesel::connection::SimpleConnection;

    #[test]
    fn database_member_cleanup_merges_batches_and_preserves_scope() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        // Reuse one rollback-only connection across the worker's transactions.
        let pool = Pool::builder()
            .max_size(1)
            .connection_customizer(Box::new(diesel::r2d2::TestCustomizer))
            .build(ConnectionManager::<PgConnection>::new(url))
            .unwrap();
        pool.get().unwrap().batch_execute(
            "INSERT INTO groups(id, name) VALUES (88100, 'bulk-cleanup'), (88200, 'other-chat');
             INSERT INTO messages(id, chat_id, sender_uid, message_type, message,
                                  client_generated_id, created_at, reply_root_id, has_thread, is_published)
             VALUES (88099, 88100, 2, 'text', 'previous', 'cleanup-previous', NOW(), NULL, false, true),
                    (88101, 88100, 2, 'text', 'root', 'cleanup-root', NOW(), NULL, true, true),
                    (88102, 88100, 1, 'text', 'old', 'cleanup-old', NOW() - INTERVAL '3 days', NULL, false, true),
                    (88103, 88100, 2, 'text', 'other user', 'cleanup-other-user', NOW(), NULL, false, true),
                    (88104, 88100, 1, 'text', 'old reply', 'cleanup-old-reply', NOW() - INTERVAL '3 days', 88101, false, true),
                    (88900, 88100, 1, 'audio', NULL, 'cleanup-pending', NOW(), NULL, false, false),
                    (88201, 88200, 1, 'text', 'other chat', 'cleanup-other-chat', NOW(), NULL, false, true);
             UPDATE messages SET deleted_at = NOW() WHERE id = 88101;
             INSERT INTO messages(id, chat_id, sender_uid, message_type, message,
                                  client_generated_id, created_at, reply_root_id, is_published)
             SELECT id, 88100, 1, 'text', 'reply', 'cleanup-reply-' || id, NOW(), 88101, true
             FROM generate_series(88301, 88803) AS id;
             UPDATE groups SET last_message_id = 88103, last_message_at = NOW() WHERE id = 88100;
             INSERT INTO group_membership(chat_id, uid, last_read_message_id)
             VALUES (88100, 2, 88102), (88100, 3, 88101);
             INSERT INTO thread_user_states(chat_id, thread_root_id, uid, last_read_message_id)
             VALUES (88100, 88101, 2, 88803);
             INSERT INTO thread_meta(chat_id, thread_root_id, reply_count, last_reply_at)
             VALUES (88100, 88101, 504, NOW());
             INSERT INTO message_mentions(message_id, mentioned_uid, chat_id)
             VALUES (88102, 2, 88100), (88803, 2, 88100);
             INSERT INTO attachments(id, message_id, kind, external_reference, size, created_at)
             VALUES (88910, 88900, 'audio/webm', 'cleanup-pending', 1, NOW()),
                    (88911, 88102, 'text/plain', 'cleanup-old', 1, NOW());",
        ).unwrap();
        let registry = Arc::new(ConnectionRegistry::new(Arc::new(WsMetrics::new(
            &prometheus::Registry::new(),
        ))));
        let (_connection, mut events) = registry.register(2, "cleanup-test".into());
        assert!(matches!(
            &*events.try_recv().unwrap(),
            ServerWsMessage::PresenceUpdate(_)
        ));
        let unread = Arc::new(UnreadService::new());

        process_bulk_delete(
            88100,
            1,
            DeleteScope::Last24Hours,
            &pool,
            &registry,
            &None,
            &unread,
        )
        .unwrap();
        let mut deleted_ids = BTreeSet::new();
        let mut batch_sizes = Vec::new();
        let mut complete = false;
        let mut updates = Vec::new();
        while let Ok(event) = events.try_recv() {
            assert!(!complete, "completion must be the last event");
            match &*event {
                ServerWsMessage::MessagesBulkDeleted(payload)
                    if payload.complete == Some(false) =>
                {
                    batch_sizes.push(payload.message_ids.len());
                    deleted_ids.extend(payload.message_ids.iter().cloned());
                }
                ServerWsMessage::MessagesBulkDeleted(payload) => {
                    assert_eq!(payload.complete, Some(true));
                    assert!(payload.message_ids.is_empty());
                    assert_eq!(payload.thread_root_ids, Some(vec!["88101".into()]));
                    complete = true;
                }
                ServerWsMessage::ThreadUpdate(payload) => updates.push(payload.reply_count),
                _ => panic!("unexpected deletion event"),
            }
        }
        assert!(complete);
        assert_eq!(batch_sizes, vec![500, 4]);
        assert_eq!(deleted_ids.len(), 504);
        assert!(
            deleted_ids.contains("88900"),
            "cleanup includes unpublished audio"
        );
        assert!(
            !deleted_ids.contains("88104"),
            "old replies stay outside the time scope"
        );
        assert_eq!(updates, vec![1]);
        {
            let conn = &mut *pool.get().unwrap();
            assert_eq!(
                thread_meta::table
                    .find((88100_i64, 88101_i64))
                    .select(thread_meta::reply_count)
                    .first::<i64>(conn)
                    .unwrap(),
                1
            );
            assert_eq!(
                thread_user_states::table
                    .find((88100_i64, 88101_i64, 2))
                    .select(thread_user_states::last_read_message_id)
                    .first::<Option<i64>>(conn)
                    .unwrap(),
                Some(88104)
            );
            assert!(messages::table
                .find(88101_i64)
                .select(messages::has_thread)
                .first::<bool>(conn)
                .unwrap());
            assert!(attachments::table
                .find(88910_i64)
                .select(attachments::deleted_at)
                .first::<Option<chrono::DateTime<Utc>>>(conn)
                .unwrap()
                .is_some());
            assert!(attachments::table
                .find(88911_i64)
                .select(attachments::deleted_at)
                .first::<Option<chrono::DateTime<Utc>>>(conn)
                .unwrap()
                .is_none());
            assert_eq!(
                message_mentions::table
                    .filter(message_mentions::chat_id.eq(88100))
                    .select(message_mentions::message_id)
                    .load::<i64>(conn)
                    .unwrap(),
                vec![88102]
            );
        }

        process_bulk_delete(88100, 1, DeleteScope::All, &pool, &registry, &None, &unread).unwrap();
        let mut final_ids = BTreeSet::new();
        let mut completed = false;
        while let Ok(event) = events.try_recv() {
            if let ServerWsMessage::MessagesBulkDeleted(payload) = &*event {
                final_ids.extend(payload.message_ids.iter().cloned());
                completed |= payload.complete == Some(true);
            }
        }
        assert!(completed);
        assert_eq!(final_ids, BTreeSet::from(["88102".into(), "88104".into()]));
        {
            let conn = &mut *pool.get().unwrap();
            let survivors: Vec<i64> = messages::table
                .filter(messages::chat_id.eq_any([88100, 88200]))
                .filter(messages::deleted_at.is_null())
                .order(messages::id.asc())
                .select(messages::id)
                .load(conn)
                .unwrap();
            assert_eq!(survivors, vec![88099, 88103, 88201]);
            assert!(!messages::table
                .find(88101_i64)
                .select(messages::has_thread)
                .first::<bool>(conn)
                .unwrap());
            assert_eq!(
                group_membership::table
                    .filter(group_membership::chat_id.eq(88100))
                    .select(group_membership::last_read_message_id)
                    .load::<Option<i64>>(conn)
                    .unwrap(),
                vec![Some(88099); 2]
            );
            assert_eq!(
                thread_user_states::table
                    .find((88100_i64, 88101_i64, 2))
                    .select(thread_user_states::last_read_message_id)
                    .first::<Option<i64>>(conn)
                    .unwrap(),
                None
            );
            assert_eq!(
                groups::table
                    .find(88100_i64)
                    .select(groups::last_message_id)
                    .first::<Option<i64>>(conn)
                    .unwrap(),
                Some(88103)
            );
            assert_eq!(
                thread_meta::table
                    .filter(thread_meta::chat_id.eq(88100))
                    .count()
                    .get_result::<i64>(conn)
                    .unwrap(),
                0
            );
            assert_eq!(
                message_mentions::table
                    .filter(message_mentions::chat_id.eq(88100))
                    .count()
                    .get_result::<i64>(conn)
                    .unwrap(),
                0
            );
        }
        process_bulk_delete(88100, 1, DeleteScope::All, &pool, &registry, &None, &unread).unwrap();
        assert!(events.try_recv().is_err(), "an empty cleanup has no events");
    }
}
