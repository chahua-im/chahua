mod metrics;
pub(crate) use metrics::AudioTranscodeMetrics;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use aws_sdk_s3::primitives::ByteStream;
use chrono::Utc;
use dashmap::DashSet;
use diesel::prelude::*;
use diesel::PgConnection;
use futures::future::FutureExt;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use crate::dto::ws::ServerWsMessage;
use crate::errors::AppError;
use crate::handlers::chats::{
    attach_metadata, build_message_side_effects, recalculate_group_last_message,
};
use crate::models::{Attachment, Message, MessageType, NewAttachment, TranscodeStatus};
use crate::schema::{attachments, messages};
use crate::services::media::MediaStore;
use crate::AppState;

const CHANNEL_BUFFER: usize = 64;
const BACKLOG_REFILL_LIMIT: i64 = 200;
const WORKER_RESTART_DELAY: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy)]
struct AudioTranscodeJob {
    message_id: i64,
}

enum EnqueueResult {
    Queued,
    AlreadyScheduled,
    Full,
}

pub struct AudioTranscodeService {
    job_tx: mpsc::Sender<AudioTranscodeJob>,
    scheduled: DashSet<i64>,
    processing: Mutex<Option<i64>>,
}

static SERVICE: OnceLock<Arc<AudioTranscodeService>> = OnceLock::new();

impl AudioTranscodeService {
    fn new(job_tx: mpsc::Sender<AudioTranscodeJob>) -> Self {
        Self {
            job_tx,
            scheduled: DashSet::new(),
            processing: Mutex::new(None),
        }
    }

    fn enqueue(&self, message_id: i64) -> EnqueueResult {
        if !self.try_schedule(message_id) {
            return EnqueueResult::AlreadyScheduled;
        }

        let job = AudioTranscodeJob { message_id };
        if let Err(err) = self.job_tx.try_send(job) {
            self.scheduled.remove(&message_id);
            warn!(
                message_id,
                error = %err,
                "audio transcode queue full, leaving message pending"
            );
            EnqueueResult::Full
        } else {
            debug!(message_id, "audio transcode job queued");
            EnqueueResult::Queued
        }
    }

    fn try_schedule(&self, message_id: i64) -> bool {
        if self.scheduled.contains(&message_id) {
            return false;
        }
        if self
            .processing
            .lock()
            .expect("audio processing mutex poisoned")
            .as_ref()
            == Some(&message_id)
        {
            return false;
        }
        self.scheduled.insert(message_id)
    }

    fn start_processing(&self, message_id: i64) {
        *self
            .processing
            .lock()
            .expect("audio processing mutex poisoned") = Some(message_id);
    }

    fn finish_processing(&self, message_id: i64) {
        let mut processing = self
            .processing
            .lock()
            .expect("audio processing mutex poisoned");
        if processing.as_ref() == Some(&message_id) {
            *processing = None;
        }
        self.scheduled.remove(&message_id);
    }

    fn clear_processing_after_panic(&self) {
        if let Some(message_id) = self
            .processing
            .lock()
            .expect("audio processing mutex poisoned")
            .take()
        {
            self.scheduled.remove(&message_id);
        }
    }
}

pub fn start(state: AppState) {
    let (tx, rx) = mpsc::channel(CHANNEL_BUFFER);
    let service = Arc::new(AudioTranscodeService::new(tx));

    if SERVICE.set(service.clone()).is_err() {
        warn!("audio transcode service already started");
        return;
    }

    tokio::spawn(async move {
        supervise_worker(rx, service, state).await;
    });
}

pub fn enqueue_message(message_id: i64) {
    match SERVICE.get() {
        Some(service) => {
            let _ = service.enqueue(message_id);
        }
        None => error!(
            message_id,
            "audio transcode service not started; leaving message pending"
        ),
    }
}

async fn supervise_worker(
    mut rx: mpsc::Receiver<AudioTranscodeJob>,
    service: Arc<AudioTranscodeService>,
    state: AppState,
) {
    loop {
        let worker_result = std::panic::AssertUnwindSafe(run_worker(&mut rx, &service, &state))
            .catch_unwind()
            .await;

        match worker_result {
            Ok(()) => {
                info!("Audio transcode worker stopped (channel closed)");
                return;
            }
            Err(payload) => {
                service.clear_processing_after_panic();
                let panic_message = super::push::panic_payload_message(payload.as_ref());
                error!(
                    "Audio transcode worker panicked; restarting in {}s: {}",
                    WORKER_RESTART_DELAY.as_secs(),
                    panic_message
                );
                tokio::time::sleep(WORKER_RESTART_DELAY).await;
            }
        }
    }
}

async fn run_worker(
    rx: &mut mpsc::Receiver<AudioTranscodeJob>,
    service: &Arc<AudioTranscodeService>,
    state: &AppState,
) {
    info!("Audio transcode worker started");

    loop {
        refill_pending_jobs(service, state);

        let Some(job) = rx.recv().await else {
            return;
        };

        service.start_processing(job.message_id);
        debug!(
            message_id = job.message_id,
            "audio transcode processing started"
        );
        let started_at = Instant::now();

        if let Err(err) = process_message(state.clone(), job.message_id).await {
            warn!(
                message_id = job.message_id,
                elapsed_ms = started_at.elapsed().as_millis() as u64,
                ?err,
                "audio transcode processing failed"
            );
        }

        service.finish_processing(job.message_id);
    }
}

fn refill_pending_jobs(service: &AudioTranscodeService, state: &AppState) {
    let mut conn = match state.db.get() {
        Ok(conn) => conn,
        Err(err) => {
            error!(
                ?err,
                "audio transcode refill: failed to acquire db connection"
            );
            return;
        }
    };
    let conn = &mut *conn;

    use crate::schema::messages::dsl as m_dsl;

    let legacy_ids: Vec<i64> = match messages::table
        .filter(m_dsl::message_type.eq(MessageType::Audio))
        .filter(m_dsl::deleted_at.is_null())
        .filter(m_dsl::is_published.eq(true))
        .filter(m_dsl::transcode_status.eq(TranscodeStatus::None))
        .order(m_dsl::id.desc())
        .select(m_dsl::id)
        .limit(BACKLOG_REFILL_LIMIT)
        .load(conn)
    {
        Ok(ids) => ids,
        Err(err) => {
            error!(
                ?err,
                "audio transcode refill: failed to load legacy audio ids"
            );
            return;
        }
    };

    if !legacy_ids.is_empty() {
        if let Err(err) = diesel::update(messages::table.filter(m_dsl::id.eq_any(&legacy_ids)))
            .set(m_dsl::transcode_status.eq(TranscodeStatus::Pending))
            .execute(conn)
        {
            error!(
                ?err,
                "audio transcode refill: failed to mark legacy rows pending"
            );
            return;
        }
    }

    let pending_ids: Vec<i64> = match messages::table
        .filter(m_dsl::message_type.eq(MessageType::Audio))
        .filter(m_dsl::deleted_at.is_null())
        .filter(m_dsl::transcode_status.eq(TranscodeStatus::Pending))
        .order(m_dsl::id.desc())
        .select(m_dsl::id)
        .limit(BACKLOG_REFILL_LIMIT)
        .load(conn)
    {
        Ok(ids) => ids,
        Err(err) => {
            error!(
                ?err,
                "audio transcode refill: failed to load pending audio ids"
            );
            return;
        }
    };

    for message_id in pending_ids {
        if matches!(service.enqueue(message_id), EnqueueResult::Full) {
            break;
        }
    }
}

async fn process_message(state: AppState, message_id: i64) -> Result<(), AppError> {
    let started_at = std::time::Instant::now();
    let (message, current_attachment) = {
        let conn = &mut state.db.get()?;
        let message: Message = messages::table
            .filter(messages::id.eq(message_id))
            .select(Message::as_select())
            .first(conn)
            .optional()?
            .ok_or(AppError::NotFound("Message not found"))?;
        let current_attachment = load_primary_attachment(conn, message.id)?;
        (message, current_attachment)
    };

    if message.deleted_at.is_some() || message.message_type != MessageType::Audio {
        return Ok(());
    }
    if matches!(
        message.transcode_status,
        TranscodeStatus::Done | TranscodeStatus::Failed
    ) {
        return Ok(());
    }

    let was_published = message.is_published;
    if let Some(attachment) = &current_attachment {
        state
            .metrics
            .audio_transcode
            .record_source(&attachment.kind);
    }
    let mut metric_guard = AudioTranscodeMetricGuard::new(state.clone(), started_at);

    let outcome = match &current_attachment {
        Some(attachment) if is_canonical_attachment(attachment) => AudioPublishOutcome::Done {
            swap_attachment: None,
        },
        Some(attachment) => {
            match transcode_attachment(&state.media, state.id_gen.as_ref(), attachment).await {
                Ok(new_attachment) => AudioPublishOutcome::Done {
                    swap_attachment: Some(new_attachment),
                },
                Err(err) => {
                    tracing::warn!(message_id, attachment_id = attachment.id, error = %err, "audio transcode failed, publishing original attachment");
                    AudioPublishOutcome::Failed
                }
            }
        }
        None => {
            tracing::warn!(
                message_id,
                "audio message has no attachment, publishing original state"
            );
            AudioPublishOutcome::Failed
        }
    };

    let updated_message = {
        let conn = &mut state.db.get()?;
        conn.transaction::<_, AppError, _>(|conn| {
            use crate::schema::attachments::dsl as a_dsl;
            use crate::schema::messages::dsl as m_dsl;

            if let AudioPublishOutcome::Done {
                swap_attachment: Some(ref new_attachment),
            } = outcome
            {
                let mut linked_attachment = new_attachment.clone();
                linked_attachment.message_id = Some(message.id);

                diesel::update(attachments::table.filter(a_dsl::message_id.eq(message.id)))
                    .set(a_dsl::message_id.eq::<Option<i64>>(None))
                    .execute(conn)?;

                diesel::insert_into(attachments::table)
                    .values(&linked_attachment)
                    .execute(conn)?;
            }

            let updated_message: Message =
                diesel::update(messages::table.filter(m_dsl::id.eq(message.id)))
                    .set((
                        m_dsl::is_published.eq(true),
                        m_dsl::transcode_status.eq(match outcome {
                            AudioPublishOutcome::Done { .. } => TranscodeStatus::Done,
                            AudioPublishOutcome::Failed => TranscodeStatus::Failed,
                        }),
                    ))
                    .returning(Message::as_returning())
                    .get_result(conn)?;

            if !was_published && updated_message.reply_root_id.is_none() {
                recalculate_group_last_message(conn, updated_message.chat_id)?;
            }

            if !was_published {
                if let Some(reply_root_id) = updated_message.reply_root_id {
                    crate::services::threads::increment_thread_meta(
                        conn,
                        updated_message.chat_id,
                        reply_root_id,
                        updated_message.created_at,
                    )?;
                    diesel::update(messages::table.filter(m_dsl::id.eq(reply_root_id)))
                        .set(m_dsl::has_thread.eq(true))
                        .execute(conn)?;
                }
            }

            Ok(updated_message)
        })?
    };

    let conn = &mut state.db.get()?;
    let response = attach_metadata(
        conn,
        vec![updated_message],
        &state.media,
        &state.avatars,
        message.sender_uid,
    )
    .await
    .into_iter()
    .next()
    .ok_or(AppError::Internal("Failed to build message response"))?;

    if was_published {
        if matches!(
            outcome,
            AudioPublishOutcome::Done {
                swap_attachment: Some(_)
            }
        ) {
            broadcast_message_update(&state, &response);
        }
        metric_guard.finish(outcome.metrics_label());
        log_audio_transcode_job(
            &message,
            current_attachment.as_ref(),
            &outcome,
            started_at.elapsed(),
        );
        return Ok(());
    }

    let conn = &mut state.db.get()?;
    let side_effects =
        build_message_side_effects(conn, &response, message.sender_uid, message.chat_id, true)?;
    let member_uids = side_effects.broadcast_uids.clone();
    side_effects.fire(&state);

    if let Some(thread_root_id) = response.reply_root_id {
        if let Some(root_msg) = messages::table
            .filter(messages::id.eq(thread_root_id))
            .filter(messages::deleted_at.is_null())
            .filter(messages::is_published.eq(true))
            .select(Message::as_select())
            .first(conn)
            .optional()?
        {
            let root_response = attach_metadata(
                conn,
                vec![root_msg],
                &state.media,
                &state.avatars,
                message.sender_uid,
            )
            .await
            .into_iter()
            .next()
            .ok_or(AppError::Internal("Failed to build thread root response"))?;
            let ws_msg = std::sync::Arc::new(ServerWsMessage::MessageUpdated(root_response));
            state.ws_registry.broadcast_to_uids(&member_uids, ws_msg);
        }

        if let Err(err) = crate::services::threads::broadcast_thread_update_to_subscribers(
            conn,
            &state.ws_registry,
            message.chat_id,
            thread_root_id,
        ) {
            tracing::warn!(
                chat_id = message.chat_id,
                thread_root_id,
                ?err,
                "failed to broadcast thread update after audio publish"
            );
        }
    }

    metric_guard.finish(outcome.metrics_label());
    log_audio_transcode_job(
        &message,
        current_attachment.as_ref(),
        &outcome,
        started_at.elapsed(),
    );

    Ok(())
}

fn broadcast_message_update(state: &AppState, response: &crate::dto::messages::MessageResponse) {
    let mut conn = match state.db.get() {
        Ok(conn) => conn,
        Err(err) => {
            tracing::error!(
                ?err,
                message_id = response.id,
                "failed to acquire db connection for message update broadcast"
            );
            return;
        }
    };
    let conn = &mut *conn;
    let member_uids: Vec<i32> = match crate::schema::group_membership::table
        .filter(crate::schema::group_membership::chat_id.eq(response.chat_id))
        .select(crate::schema::group_membership::uid)
        .load(conn)
    {
        Ok(uids) => uids,
        Err(err) => {
            tracing::error!(
                ?err,
                message_id = response.id,
                "failed to load member uids for message update broadcast"
            );
            return;
        }
    };
    let ws_msg = std::sync::Arc::new(ServerWsMessage::MessageUpdated(response.clone()));
    state.ws_registry.broadcast_to_uids(&member_uids, ws_msg);
}

fn load_primary_attachment(
    conn: &mut PgConnection,
    message_id: i64,
) -> Result<Option<Attachment>, AppError> {
    use crate::schema::attachments::dsl as a_dsl;

    attachments::table
        .filter(a_dsl::message_id.eq(message_id))
        .filter(a_dsl::deleted_at.is_null())
        .order((a_dsl::order.asc(), a_dsl::id.asc()))
        .select(Attachment::as_select())
        .first(conn)
        .optional()
        .map_err(Into::into)
}

fn is_canonical_attachment(attachment: &Attachment) -> bool {
    attachment.kind == "audio/ogg"
        && Path::new(&attachment.file_name)
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("ogg"))
}

async fn transcode_attachment(
    media: &MediaStore,
    id_gen: &crate::utils::ids::IdGen,
    attachment: &Attachment,
) -> Result<NewAttachment, String> {
    let source_bytes = media
        .get_object(&attachment.external_reference)
        .await
        .map_err(|err| format!("download source object: {err:?}"))?;

    let output_bytes = transcode_with_ffmpeg(&attachment.file_name, source_bytes).await?;

    let object_id = Uuid::new_v4().to_string();
    let canonical_file_name = canonical_file_name(&attachment.file_name);
    let storage_key = media.attachment_key(&canonical_file_name, &object_id);
    media
        .put_object(
            &storage_key,
            "audio/ogg",
            ByteStream::from(output_bytes.clone()),
        )
        .await
        .map_err(|err| format!("upload canonical object: {err:?}"))?;

    let new_attachment_id = crate::utils::ids::next_message_id(id_gen)
        .await
        .map_err(|err| format!("generate canonical attachment id: {err:?}"))?;

    Ok(NewAttachment {
        id: new_attachment_id,
        message_id: None,
        file_name: canonical_file_name,
        kind: "audio/ogg".to_string(),
        external_reference: storage_key,
        size: output_bytes.len() as i64,
        created_at: Utc::now(),
        deleted_at: None,
        width: None,
        height: None,
        order: attachment.order,
    })
}

async fn transcode_with_ffmpeg(file_name: &str, source_bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let file_name = file_name.to_string();
    tokio::task::spawn_blocking(move || {
        let ext = Path::new(&file_name)
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("bin");
        let input_path = temp_path("wetty-audio-input", ext);
        let output_path = temp_path("wetty-audio-output", "ogg");

        std::fs::write(&input_path, &source_bytes)
            .map_err(|err| format!("write temp input: {err}"))?;

        let output = std::process::Command::new("ffmpeg")
            .arg("-y")
            .arg("-i")
            .arg(&input_path)
            .arg("-c:a")
            .arg("libopus")
            .arg("-f")
            .arg("ogg")
            .arg(&output_path)
            .output()
            .map_err(|err| format!("spawn ffmpeg: {err}"))?;

        let _ = std::fs::remove_file(&input_path);

        if !output.status.success() {
            let _ = std::fs::remove_file(&output_path);
            return Err(format!(
                "ffmpeg failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }

        let bytes =
            std::fs::read(&output_path).map_err(|err| format!("read ffmpeg output: {err}"))?;
        let _ = std::fs::remove_file(&output_path);
        Ok(bytes)
    })
    .await
    .map_err(|err| format!("join ffmpeg task: {err}"))?
}

fn temp_path(prefix: &str, extension: &str) -> PathBuf {
    std::env::temp_dir().join(format!("{prefix}-{}.{}", Uuid::new_v4(), extension))
}

fn canonical_file_name(original_file_name: &str) -> String {
    let stem = Path::new(original_file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("audio");
    format!("{stem}.ogg")
}

enum AudioPublishOutcome {
    Done {
        swap_attachment: Option<NewAttachment>,
    },
    Failed,
}

impl AudioPublishOutcome {
    fn metrics_label(&self) -> Option<&'static str> {
        match self {
            Self::Done {
                swap_attachment: Some(_),
            } => Some("success"),
            Self::Done {
                swap_attachment: None,
            } => None,
            Self::Failed => Some("failure"),
        }
    }
}

fn log_audio_transcode_job(
    message: &Message,
    input_attachment: Option<&Attachment>,
    outcome: &AudioPublishOutcome,
    elapsed: std::time::Duration,
) {
    let action = match outcome {
        AudioPublishOutcome::Done {
            swap_attachment: Some(_),
        } => "transcoded",
        AudioPublishOutcome::Done {
            swap_attachment: None,
        } => "already_canonical",
        AudioPublishOutcome::Failed => "published_original",
    };

    let input_attachment_id = input_attachment.map(|attachment| attachment.id);
    let input_kind = input_attachment
        .map(|attachment| attachment.kind.as_str())
        .unwrap_or("none");
    let input_file_name = input_attachment
        .map(|attachment| attachment.file_name.as_str())
        .unwrap_or("");
    let input_size = input_attachment
        .map(|attachment| attachment.size)
        .unwrap_or(0);

    let output_attachment_id = match outcome {
        AudioPublishOutcome::Done {
            swap_attachment: Some(new_attachment),
        } => Some(new_attachment.id),
        AudioPublishOutcome::Done {
            swap_attachment: None,
        }
        | AudioPublishOutcome::Failed => input_attachment_id,
    };
    let output_kind = match outcome {
        AudioPublishOutcome::Done {
            swap_attachment: Some(new_attachment),
        } => new_attachment.kind.as_str(),
        AudioPublishOutcome::Done {
            swap_attachment: None,
        }
        | AudioPublishOutcome::Failed => input_kind,
    };
    let output_file_name = match outcome {
        AudioPublishOutcome::Done {
            swap_attachment: Some(new_attachment),
        } => new_attachment.file_name.as_str(),
        AudioPublishOutcome::Done {
            swap_attachment: None,
        }
        | AudioPublishOutcome::Failed => input_file_name,
    };
    let output_size = match outcome {
        AudioPublishOutcome::Done {
            swap_attachment: Some(new_attachment),
        } => new_attachment.size,
        AudioPublishOutcome::Done {
            swap_attachment: None,
        }
        | AudioPublishOutcome::Failed => input_size,
    };

    tracing::debug!(
        message_id = message.id,
        chat_id = message.chat_id,
        reply_root_id = message.reply_root_id,
        was_published = message.is_published,
        action,
        input_attachment_id,
        input_kind,
        input_file_name,
        input_size,
        output_attachment_id,
        output_kind,
        output_file_name,
        output_size,
        duration_ms = elapsed.as_millis() as u64,
        "audio transcode job completed"
    );
}

struct AudioTranscodeMetricGuard {
    state: AppState,
    started_at: std::time::Instant,
    finished: bool,
}

impl AudioTranscodeMetricGuard {
    fn new(state: AppState, started_at: std::time::Instant) -> Self {
        Self {
            state,
            started_at,
            finished: false,
        }
    }

    fn finish(&mut self, result: Option<&'static str>) {
        self.finished = true;
        if let Some(result) = result {
            self.state
                .metrics
                .audio_transcode
                .record_job(result, self.started_at.elapsed().as_secs_f64());
        }
    }
}

impl Drop for AudioTranscodeMetricGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.state
                .metrics
                .audio_transcode
                .record_job("failure", self.started_at.elapsed().as_secs_f64());
        }
    }
}
