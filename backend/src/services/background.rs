use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::PgConnection;
use futures::future::FutureExt;
use std::collections::HashSet;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use crate::dto::ws::{BulkDeletedPayload, ServerWsMessage};
use crate::metrics::Metrics;
use crate::schema::{attachments, group_membership, messages};
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
        metrics: Arc<Metrics>,
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
    metrics: Arc<Metrics>,
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
    metrics: &Arc<Metrics>,
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
                metrics.record_background_job(job_kind, "success", duration);
            }
            Err(e) => {
                metrics.record_background_job(job_kind, "failure", duration);
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
    use crate::schema::attachments::dsl as a_dsl;
    use crate::schema::group_membership::dsl as gm_dsl;
    use crate::schema::messages::dsl;

    let conn = &mut db.get().map_err(|e| format!("pool error: {e}"))?;

    let map_db = |e: diesel::result::Error| format!("db error: {e}");

    // 1. Collect member UIDs for WS broadcast (once before the loop)
    let member_uids: Vec<i32> = group_membership::table
        .filter(gm_dsl::chat_id.eq(chat_id))
        .select(group_membership::uid)
        .load(conn)
        .map_err(map_db)?;

    // 2. Chunked delete loop
    let mut total_deleted: usize = 0;
    let mut affected_thread_ids = HashSet::new();
    loop {
        let mut query = messages::table
            .filter(dsl::chat_id.eq(chat_id))
            .filter(dsl::sender_uid.eq(target_uid))
            .filter(dsl::deleted_at.is_null())
            .into_boxed();

        if let DeleteScope::Last24Hours = scope {
            let cutoff = Utc::now() - chrono::Duration::hours(24);
            query = query.filter(dsl::created_at.ge(cutoff));
        }

        let batch_ids: Vec<i64> = query
            .select(dsl::id)
            .order(dsl::id.desc())
            .limit(BATCH_SIZE)
            .load(conn)
            .map_err(map_db)?;

        if batch_ids.is_empty() {
            break;
        }

        let batch_thread_ids: Vec<Option<i64>> = messages::table
            .filter(dsl::id.eq_any(&batch_ids))
            .select(dsl::reply_root_id)
            .load(conn)
            .map_err(map_db)?;
        affected_thread_ids.extend(batch_thread_ids.into_iter().flatten());

        let now = Utc::now();

        // Soft-delete the batch of messages
        diesel::update(messages::table.filter(dsl::id.eq_any(&batch_ids)))
            .set(dsl::deleted_at.eq(Some(now)))
            .execute(conn)
            .map_err(map_db)?;

        if let Some(search_service) = message_search {
            search_service.delete_message_ids_best_effort(batch_ids.clone());
        }

        // Soft-delete attachments for these messages
        diesel::update(
            attachments::table
                .filter(a_dsl::message_id.eq_any(&batch_ids))
                .filter(a_dsl::deleted_at.is_null()),
        )
        .set(a_dsl::deleted_at.eq(Some(now)))
        .execute(conn)
        .map_err(map_db)?;

        // Broadcast MessagesBulkDeleted for this batch
        let ws_msg = Arc::new(ServerWsMessage::MessagesBulkDeleted(BulkDeletedPayload {
            chat_id: chat_id.to_string(),
            message_ids: batch_ids.iter().map(|id| id.to_string()).collect(),
        }));
        ws_registry.broadcast_to_uids(&member_uids, ws_msg);

        total_deleted += batch_ids.len();

        if (batch_ids.len() as i64) < BATCH_SIZE {
            break;
        }
    }

    // 3. Recalculate last_message_id and thread_meta once after all batches
    if total_deleted > 0 {
        crate::handlers::chats::recalculate_group_last_message(conn, chat_id)
            .map_err(|e| format!("recalculate last message: {e:?}"))?;

        for thread_root_id in &affected_thread_ids {
            if let Err(e) =
                crate::services::threads::recalculate_thread_meta(conn, chat_id, *thread_root_id)
            {
                warn!(
                    chat_id,
                    thread_root_id,
                    ?e,
                    "recalculate thread_meta after bulk delete"
                );
                continue;
            }

            if let Err(e) = crate::services::threads::broadcast_thread_update_to_subscribers(
                conn,
                ws_registry,
                chat_id,
                *thread_root_id,
            ) {
                warn!(
                    chat_id,
                    thread_root_id,
                    ?e,
                    "broadcast thread update after bulk delete"
                );
            }
        }

        info!(
            chat_id,
            target_uid, total_deleted, "Bulk message deletion completed"
        );
    }

    Ok(())
}
