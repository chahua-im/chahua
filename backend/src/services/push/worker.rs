use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::PgConnection;
use futures::future::FutureExt;
use futures::stream::{self, StreamExt};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::models::PushSubscription;
use crate::schema::push_subscriptions;
use crate::services::ws_registry::ConnectionRegistry;

use super::delivery::{DeliveryFailure, DeliveryFailureAction};
use super::payload::{build_apns_notification, build_push_payload, format_push_body};
use super::policy::{
    should_send_push, PushDecision, PushRecipientContext, PushSkipReason, ThreadPushState,
};
use super::{panic_payload_message, PushJob, PushService};

const PUSH_CONCURRENCY: usize = 10;
const PUSH_SUPPRESSION_FRESHNESS_SECS: u64 = 30;
const PUSH_WORKER_RESTART_DELAY: Duration = Duration::from_secs(1);
const PUSH_COUNTED_FAILURE_PRUNE_THRESHOLD: i32 = 3;

pub(super) async fn supervise_push_worker(
    mut rx: mpsc::Receiver<PushJob>,
    service: Arc<PushService>,
    db: Pool<ConnectionManager<PgConnection>>,
    ws_registry: Arc<ConnectionRegistry>,
) {
    loop {
        let worker_result =
            std::panic::AssertUnwindSafe(run_push_worker(&mut rx, &service, &db, &ws_registry))
                .catch_unwind()
                .await;

        match worker_result {
            Ok(()) => {
                info!("Push notification worker stopped (channel closed)");
                return;
            }
            Err(payload) => {
                let panic_message = panic_payload_message(payload.as_ref());
                error!(
                    "Push notification worker panicked; restarting in {}s: {}",
                    PUSH_WORKER_RESTART_DELAY.as_secs(),
                    panic_message
                );
                tokio::time::sleep(PUSH_WORKER_RESTART_DELAY).await;
            }
        }
    }
}

/// Background worker that processes push notification jobs.
async fn run_push_worker(
    rx: &mut mpsc::Receiver<PushJob>,
    service: &Arc<PushService>,
    db: &Pool<ConnectionManager<PgConnection>>,
    ws_registry: &Arc<ConnectionRegistry>,
) {
    info!("Push notification worker started");

    while let Some(job) = rx.recv().await {
        debug!(
            "Processing push job: chat_id={} sender_uid={} message_id={}",
            job.chat_id, job.sender_uid, job.message_id
        );
        let started_at = Instant::now();

        #[cfg(test)]
        maybe_panic_for_test(&job);

        let conn = match db.get() {
            Ok(c) => c,
            Err(e) => {
                error!("Push worker: failed to get DB connection: {:?}", e);
                service
                    .metrics
                    .record_push_job("failure", started_at.elapsed().as_secs_f64());
                continue;
            }
        };

        match process_push_job(service, conn, ws_registry, &job).await {
            Ok(()) => service
                .metrics
                .record_push_job("success", started_at.elapsed().as_secs_f64()),
            Err(e) => {
                error!(
                    "Push worker: job failed for message_id={}: {}",
                    job.message_id, e
                );
                service
                    .metrics
                    .record_push_job("failure", started_at.elapsed().as_secs_f64());
            }
        }
    }
}

#[derive(Debug)]
struct RecipientCandidate {
    uid: i32,
    muted_until: Option<chrono::DateTime<chrono::Utc>>,
    chat_archived: bool,
    thread_state: ThreadPushState,
}

#[derive(Debug)]
enum DeliveryAttemptResult {
    Success {
        subscription_id: i64,
        should_reset_failure_state: bool,
    },
    Failure {
        failure: DeliveryFailure,
        next_failure_count: i32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CountedFailurePersistenceAction {
    Record,
    Prune,
}

fn counted_failure_persistence_action(next_failure_count: i32) -> CountedFailurePersistenceAction {
    if next_failure_count >= PUSH_COUNTED_FAILURE_PRUNE_THRESHOLD {
        CountedFailurePersistenceAction::Prune
    } else {
        CountedFailurePersistenceAction::Record
    }
}

fn load_recipient_candidates(
    conn: &mut PgConnection,
    job: &PushJob,
) -> Result<Vec<RecipientCandidate>, String> {
    use crate::schema::group_membership;
    use crate::schema::group_membership::dsl as gm_dsl;

    let mut candidates = std::collections::HashMap::<i32, RecipientCandidate>::new();

    if let Some(thread_root_id) = job.thread_root_id {
        use crate::schema::thread_subscriptions::dsl as ts_dsl;

        let rows: Vec<(i32, bool, Option<chrono::DateTime<chrono::Utc>>, bool)> =
            ts_dsl::thread_subscriptions
                .inner_join(
                    group_membership::table.on(gm_dsl::chat_id
                        .eq(ts_dsl::chat_id)
                        .and(gm_dsl::uid.eq(ts_dsl::uid))),
                )
                .filter(ts_dsl::chat_id.eq(job.chat_id))
                .filter(ts_dsl::thread_root_id.eq(thread_root_id))
                .select((
                    ts_dsl::uid,
                    ts_dsl::archived,
                    group_membership::muted_until,
                    group_membership::archived,
                ))
                .load(conn)
                .map_err(|e| format!("Failed to load thread subscriber candidates: {:?}", e))?;

        for (uid, thread_archived, muted_until, chat_archived) in rows {
            candidates.insert(
                uid,
                RecipientCandidate {
                    uid,
                    muted_until,
                    chat_archived,
                    thread_state: if thread_archived {
                        ThreadPushState::ArchivedSubscription
                    } else {
                        ThreadPushState::ActiveSubscription
                    },
                },
            );
        }

        if !job.mentioned_uids.is_empty() {
            let rows: Vec<(i32, Option<chrono::DateTime<chrono::Utc>>, bool)> =
                group_membership::table
                    .filter(gm_dsl::chat_id.eq(job.chat_id))
                    .filter(gm_dsl::uid.eq_any(&job.mentioned_uids))
                    .select((
                        group_membership::uid,
                        group_membership::muted_until,
                        group_membership::archived,
                    ))
                    .load(conn)
                    .map_err(|e| format!("Failed to load mentioned member candidates: {:?}", e))?;

            for (uid, muted_until, chat_archived) in rows {
                candidates.entry(uid).or_insert(RecipientCandidate {
                    uid,
                    muted_until,
                    chat_archived,
                    thread_state: ThreadPushState::NoSubscription,
                });
            }
        }
    } else {
        let rows: Vec<(i32, Option<chrono::DateTime<chrono::Utc>>, bool)> = group_membership::table
            .filter(gm_dsl::chat_id.eq(job.chat_id))
            .select((
                group_membership::uid,
                group_membership::muted_until,
                group_membership::archived,
            ))
            .load(conn)
            .map_err(|e| format!("Failed to load member candidates: {:?}", e))?;

        for (uid, muted_until, chat_archived) in rows {
            candidates.insert(
                uid,
                RecipientCandidate {
                    uid,
                    muted_until,
                    chat_archived,
                    thread_state: ThreadPushState::NotThreadMessage,
                },
            );
        }
    }

    Ok(candidates.into_values().collect())
}

/// Process a single push job: load subscriptions, filter online users, send, cleanup.
async fn process_push_job(
    service: &Arc<PushService>,
    mut conn: diesel::r2d2::PooledConnection<ConnectionManager<PgConnection>>,
    ws_registry: &ConnectionRegistry,
    job: &PushJob,
) -> Result<(), String> {
    let now = chrono::Utc::now();

    let candidates = load_recipient_candidates(&mut conn, job)?;

    let mentioned_uids: std::collections::HashSet<i32> =
        job.mentioned_uids.iter().copied().collect();
    let target_uids: Vec<i32> = candidates
        .into_iter()
        .filter_map(|candidate| {
            let has_active_presence =
                ws_registry.should_suppress_push(candidate.uid, PUSH_SUPPRESSION_FRESHNESS_SECS);
            let context = PushRecipientContext {
                uid: candidate.uid,
                is_sender: candidate.uid == job.sender_uid,
                is_mentioned: mentioned_uids.contains(&candidate.uid),
                chat_archived: candidate.chat_archived,
                group_muted_until: candidate.muted_until,
                thread_state: candidate.thread_state,
                has_active_presence,
            };

            match should_send_push(&context, now) {
                PushDecision::Send | PushDecision::SendOneOffMention => Some(candidate.uid),
                PushDecision::Skip(PushSkipReason::ActivePresence) => {
                    service.metrics.record_push_suppressed();
                    None
                }
                PushDecision::Skip(_) => None,
            }
        })
        .collect();

    if target_uids.is_empty() {
        debug!(
            "Push job: no offline recipients for message_id={}",
            job.message_id
        );
        return Ok(());
    }

    // 3. Load push subscriptions for the target users.
    let subs: Vec<PushSubscription> = push_subscriptions::table
        .filter(push_subscriptions::dsl::user_id.eq_any(&target_uids))
        .select(PushSubscription::as_select())
        .load(&mut conn)
        .map_err(|e| format!("Failed to load push subscriptions: {:?}", e))?;

    if subs.is_empty() {
        debug!(
            "Push job: no subscriptions for message_id={}",
            job.message_id
        );
        return Ok(());
    }

    debug!(
        "Push job: sending to {} subscriptions for message_id={}",
        subs.len(),
        job.message_id
    );

    // 3.5 Calculate unread counts only for users with push subscriptions
    let sub_uids: Vec<i32> = {
        let mut seen = std::collections::HashSet::with_capacity(subs.len());
        subs.iter()
            .filter_map(|s| seen.insert(s.user_id).then_some(s.user_id))
            .collect()
    };
    let unread_counts = crate::services::chat::get_unread_counts(&mut conn, &sub_uids)
        .unwrap_or_else(|e| {
            warn!("Failed to load unread counts for push job: {:?}", e);
            std::collections::HashMap::new()
        });

    // 4. Build the push payload base text.
    let body_text = format_push_body(&job.sender_username, job.body_preview.as_deref());

    // 5. Send concurrently with bounded parallelism.
    let delivery_results: Vec<DeliveryAttemptResult> = stream::iter(subs)
        .map(|sub| {
            let service = service.clone();

            let unread = unread_counts.get(&sub.user_id).copied().unwrap_or(0);
            let web_payload = serde_json::to_vec(&build_push_payload(job, unread, &body_text))
                .unwrap_or_default();
            let apns_notification = build_apns_notification(job, unread);

            async move {
                match service
                    .send_to_subscription(&sub, &web_payload, &apns_notification)
                    .await
                {
                    Ok(()) => DeliveryAttemptResult::Success {
                        subscription_id: sub.id,
                        should_reset_failure_state: sub.delivery_failure_count != 0
                            || sub.last_delivery_error.is_some()
                            || sub.last_delivery_error_at.is_some(),
                    },
                    Err(failure) => DeliveryAttemptResult::Failure {
                        failure,
                        next_failure_count: sub.delivery_failure_count.saturating_add(1),
                    },
                }
            }
        })
        .buffer_unordered(PUSH_CONCURRENCY)
        .collect()
        .await;

    apply_delivery_results(service, &mut conn, delivery_results)?;

    Ok(())
}

fn apply_delivery_results(
    service: &PushService,
    conn: &mut PgConnection,
    results: Vec<DeliveryAttemptResult>,
) -> Result<(), String> {
    let mut reset_ids = Vec::new();
    let mut prune_ids = Vec::new();
    let mut counted_failures = Vec::new();
    let now = chrono::Utc::now();

    for result in results {
        match result {
            DeliveryAttemptResult::Success {
                subscription_id,
                should_reset_failure_state,
            } => {
                if should_reset_failure_state {
                    reset_ids.push(subscription_id);
                }
            }
            DeliveryAttemptResult::Failure {
                failure,
                next_failure_count,
            } => {
                service.metrics.record_push_delivery_failure(
                    failure.provider.as_metrics_label(),
                    failure.class.as_metrics_label(),
                );

                match failure.action {
                    DeliveryFailureAction::PruneImmediate => {
                        warn!(
                            provider = failure.provider.as_metrics_label(),
                            subscription_id = failure.subscription_id,
                            user_id = failure.user_id,
                            failure_class = failure.class.as_metrics_label(),
                            reason = %failure.reason,
                            failure_count = next_failure_count,
                            action = "prune",
                            "pruning push subscription after immediate delivery failure"
                        );
                        service.metrics.record_push_subscription_prune(
                            failure.provider.as_metrics_label(),
                            failure.reason.as_str(),
                        );
                        prune_ids.push(failure.subscription_id);
                    }
                    DeliveryFailureAction::Counted
                        if counted_failure_persistence_action(next_failure_count)
                            == CountedFailurePersistenceAction::Prune =>
                    {
                        warn!(
                            provider = failure.provider.as_metrics_label(),
                            subscription_id = failure.subscription_id,
                            user_id = failure.user_id,
                            failure_class = failure.class.as_metrics_label(),
                            reason = %failure.reason,
                            failure_count = next_failure_count,
                            action = "prune",
                            "pruning push subscription after repeated delivery failures"
                        );
                        service.metrics.record_push_subscription_prune(
                            failure.provider.as_metrics_label(),
                            failure.reason.as_str(),
                        );
                        prune_ids.push(failure.subscription_id);
                    }
                    DeliveryFailureAction::Counted => {
                        warn!(
                            provider = failure.provider.as_metrics_label(),
                            subscription_id = failure.subscription_id,
                            user_id = failure.user_id,
                            failure_class = failure.class.as_metrics_label(),
                            reason = %failure.reason,
                            failure_count = next_failure_count,
                            action = "retry",
                            "recording counted push delivery failure"
                        );
                        counted_failures.push((failure, next_failure_count));
                    }
                    DeliveryFailureAction::None => {}
                }
            }
        }
    }

    if !reset_ids.is_empty() {
        diesel::update(
            push_subscriptions::table.filter(push_subscriptions::dsl::id.eq_any(&reset_ids)),
        )
        .set((
            push_subscriptions::dsl::delivery_failure_count.eq(0),
            push_subscriptions::dsl::last_delivery_error.eq::<Option<String>>(None),
            push_subscriptions::dsl::last_delivery_error_at
                .eq::<Option<chrono::DateTime<chrono::Utc>>>(None),
        ))
        .execute(conn)
        .map_err(|e| format!("Failed to reset push delivery failure state: {:?}", e))?;
    }

    for (failure, next_failure_count) in counted_failures {
        diesel::update(push_subscriptions::table.find(failure.subscription_id))
            .set((
                push_subscriptions::dsl::delivery_failure_count.eq(next_failure_count),
                push_subscriptions::dsl::last_delivery_error.eq(Some(failure.reason)),
                push_subscriptions::dsl::last_delivery_error_at.eq(Some(now)),
            ))
            .execute(conn)
            .map_err(|e| format!("Failed to update push delivery failure state: {:?}", e))?;
    }

    if !prune_ids.is_empty() {
        diesel::delete(
            push_subscriptions::table.filter(push_subscriptions::dsl::id.eq_any(&prune_ids)),
        )
        .execute(conn)
        .map_err(|e| format!("Failed to prune push subscriptions: {:?}", e))?;
    }

    Ok(())
}

#[cfg(test)]
fn maybe_panic_for_test(job: &PushJob) {
    if job.message_id == TEST_PANIC_MESSAGE_ID.load(std::sync::atomic::Ordering::SeqCst) {
        panic!("test-induced push worker panic");
    }
}

#[cfg(test)]
static TEST_PANIC_MESSAGE_ID: std::sync::atomic::AtomicI64 =
    std::sync::atomic::AtomicI64::new(i64::MIN);

#[cfg(test)]
mod tests {
    use super::{counted_failure_persistence_action, CountedFailurePersistenceAction};

    #[test]
    fn first_counted_delivery_failure_is_recorded() {
        assert_eq!(
            counted_failure_persistence_action(1),
            CountedFailurePersistenceAction::Record
        );
    }

    #[test]
    fn second_counted_delivery_failure_is_recorded() {
        assert_eq!(
            counted_failure_persistence_action(2),
            CountedFailurePersistenceAction::Record
        );
    }

    #[test]
    fn third_counted_delivery_failure_prunes_subscription() {
        assert_eq!(
            counted_failure_persistence_action(3),
            CountedFailurePersistenceAction::Prune
        );
    }
}
