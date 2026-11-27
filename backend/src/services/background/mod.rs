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
    ) -> Arc<Self> {
        let (tx, rx) = mpsc::channel(CHANNEL_BUFFER);

        let service = Arc::new(Self { job_tx: tx });

        tokio::spawn(async move {
            supervise_worker(rx, db, ws_registry, metrics, message_search).await;
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
) {
    loop {
        let worker_result = std::panic::AssertUnwindSafe(run_worker(
            &mut rx,
            &db,
            &ws_registry,
            &metrics,
            &message_search,
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
            .transaction::<_, crate::errors::AppError, _>(|conn| {
                let query = messages::table
                    .filter(dsl::chat_id.eq(chat_id))
                    .filter(dsl::sender_uid.eq(target_uid))
                    .filter(dsl::message_type.ne(crate::models::MessageType::System))
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
            .map_err(|e| format!("message deletion error: {e:?}"))?;
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
mod tests;
