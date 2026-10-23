use crate::services::notification_preferences::{
    load_notification_defaults_for_users, ChatNotificationSetting,
};
use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::PgConnection;
use futures::future::FutureExt;
use futures::stream::{self, StreamExt};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::models::{GroupKind, PushProvider, PushSubscription};
use crate::schema::push_subscriptions;
use crate::services::ws_registry::ConnectionRegistry;

use super::delivery::{DeliveryFailure, DeliveryFailureAction};
use super::payload::{
    build_apns_notification, build_push_payload, format_push_body, format_reply_push_body,
    payload_type_for, PushPayloadType,
};
use super::policy::{
    should_send_push, should_send_web_push, PushDecision, PushRecipientContext, PushSkipReason,
    ThreadPushState,
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
                    .record_job("failure", started_at.elapsed().as_secs_f64());
                continue;
            }
        };

        match process_push_job(service, conn, ws_registry, &job).await {
            Ok(()) => service
                .metrics
                .record_job("success", started_at.elapsed().as_secs_f64()),
            Err(e) => {
                error!(
                    "Push worker: job failed for message_id={}: {}",
                    job.message_id, e
                );
                service
                    .metrics
                    .record_job("failure", started_at.elapsed().as_secs_f64());
            }
        }
    }
}

#[derive(Debug)]
struct RecipientCandidate {
    uid: i32,
    notification_setting: ChatNotificationSetting,
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
        use crate::schema::thread_user_states::dsl as ts_dsl;

        let rows: Vec<(i32, bool, ChatNotificationSetting, bool)> = ts_dsl::thread_user_states
            .inner_join(
                group_membership::table.on(gm_dsl::chat_id
                    .eq(ts_dsl::chat_id)
                    .and(gm_dsl::uid.eq(ts_dsl::uid))),
            )
            .filter(ts_dsl::chat_id.eq(job.chat_id))
            .filter(ts_dsl::thread_root_id.eq(thread_root_id))
            .filter(ts_dsl::subscribed.eq(true))
            .select((
                ts_dsl::uid,
                ts_dsl::archived,
                (
                    group_membership::muted_until,
                    group_membership::mute_override,
                ),
                group_membership::archived,
            ))
            .load(conn)
            .map_err(|e| format!("Failed to load thread subscriber candidates: {:?}", e))?;

        for (uid, thread_archived, notification_setting, chat_archived) in rows {
            candidates.insert(
                uid,
                RecipientCandidate {
                    uid,
                    notification_setting,
                    chat_archived,
                    thread_state: if thread_archived {
                        ThreadPushState::ArchivedSubscription
                    } else {
                        ThreadPushState::ActiveSubscription
                    },
                },
            );
        }

        if !job.mentioned_uids.is_empty() || job.reply_target_uid.is_some() {
            let rows: Vec<(i32, ChatNotificationSetting, bool)> = group_membership::table
                .filter(gm_dsl::chat_id.eq(job.chat_id))
                .filter(
                    gm_dsl::uid.eq_any(
                        job.mentioned_uids
                            .iter()
                            .copied()
                            .chain(job.reply_target_uid),
                    ),
                )
                .select((
                    group_membership::uid,
                    (
                        group_membership::muted_until,
                        group_membership::mute_override,
                    ),
                    group_membership::archived,
                ))
                .load(conn)
                .map_err(|e| {
                    format!(
                        "Failed to load directly addressed member candidates: {:?}",
                        e
                    )
                })?;

            for (uid, notification_setting, chat_archived) in rows {
                candidates.entry(uid).or_insert(RecipientCandidate {
                    uid,
                    notification_setting,
                    chat_archived,
                    thread_state: ThreadPushState::NoSubscription,
                });
            }
        }
    } else {
        let rows: Vec<(i32, ChatNotificationSetting, bool)> = group_membership::table
            .filter(gm_dsl::chat_id.eq(job.chat_id))
            .select((
                group_membership::uid,
                (
                    group_membership::muted_until,
                    group_membership::mute_override,
                ),
                group_membership::archived,
            ))
            .load(conn)
            .map_err(|e| format!("Failed to load member candidates: {:?}", e))?;

        for (uid, notification_setting, chat_archived) in rows {
            candidates.insert(
                uid,
                RecipientCandidate {
                    uid,
                    notification_setting,
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
    let kind = crate::schema::groups::table
        .find(job.chat_id)
        .select(crate::schema::groups::kind)
        .first::<GroupKind>(&mut conn)
        .map_err(|e| format!("Failed to load push chat kind: {:?}", e))?;
    let is_dm = kind == GroupKind::Dm;
    let defaults = load_notification_defaults_for_users(
        &mut conn,
        &candidates
            .iter()
            .map(|candidate| candidate.uid)
            .collect::<Vec<_>>(),
    )
    .map_err(|e| format!("Failed to load push notification defaults: {e}"))?;
    let mut ordinary_recipients = std::collections::HashSet::new();

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
                is_reply_target: job.reply_target_uid == Some(candidate.uid),
                chat_archived: candidate.chat_archived,
                notification_setting: candidate.notification_setting,
                chat_kind: kind,
                notification_defaults: defaults.get(&candidate.uid).copied().unwrap_or_default(),
                thread_state: candidate.thread_state,
                has_active_presence,
            };

            if is_dm
                && matches!(
                    should_send_web_push(&context, is_dm, now),
                    PushDecision::Send
                )
            {
                ordinary_recipients.insert(candidate.uid);
            }

            match should_send_push(&context, now) {
                PushDecision::Send | PushDecision::SendOneOffMention => Some(candidate.uid),
                PushDecision::Skip(PushSkipReason::ActivePresence) => {
                    service.metrics.record_suppressed();
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
    let mut subs: Vec<PushSubscription> = push_subscriptions::table
        .filter(push_subscriptions::dsl::user_id.eq_any(&target_uids))
        .select(PushSubscription::as_select())
        .load(&mut conn)
        .map_err(|e| format!("Failed to load push subscriptions: {:?}", e))?;

    // Do not send silent Push events: browsers require a visible notification.
    // APNs retains its existing mention/reply policy.
    subs.retain(|sub| {
        !is_dm
            || sub.provider != PushProvider::WebPush
            || ordinary_recipients.contains(&sub.user_id)
    });

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
    let unread_counts = service
        .unread_service
        .count_users_unread_totals(&mut conn, &sub_uids)
        .unwrap_or_else(|e| {
            warn!("Failed to load unread counts for push job: {:?}", e);
            std::collections::HashMap::new()
        });

    // 4. Send concurrently with bounded parallelism.
    let delivery_results: Vec<DeliveryAttemptResult> = stream::iter(subs)
        .map(|sub| {
            let service = service.clone();

            let unread = unread_counts.get(&sub.user_id).copied().unwrap_or(0);
            // Reply targets get their own body copy; mentions and generic
            // messages share the standard one.
            let body_text = match payload_type_for(job, sub.user_id) {
                PushPayloadType::Reply => {
                    format_reply_push_body(&job.sender_username, job.body_preview.as_deref())
                }
                PushPayloadType::Mention | PushPayloadType::NewMessage => {
                    format_push_body(&job.sender_username, job.body_preview.as_deref())
                }
            };
            let mut web_payload = build_push_payload(job, unread, &body_text, sub.user_id);
            if is_dm {
                web_payload.ordinary_message_body = Some(format_push_body(
                    &job.sender_username,
                    job.body_preview.as_deref(),
                ));
            }
            let web_payload = serde_json::to_vec(&web_payload).unwrap_or_default();
            let apns_notification = build_apns_notification(job, unread, sub.user_id);

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
                service.metrics.record_delivery_failure(
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
                        service.metrics.record_subscription_prune(
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
                        service.metrics.record_subscription_prune(
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
    fn database_push_candidates_keep_preferences_and_thread_membership_boundaries() {
        use super::*;
        use diesel::connection::SimpleConnection;
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.batch_execute("
            CREATE TEMP TABLE group_membership (chat_id BIGINT, uid INTEGER, muted_until TIMESTAMPTZ, mute_override BOOLEAN, archived BOOLEAN);
            CREATE TEMP TABLE thread_user_states (chat_id BIGINT, uid INTEGER, thread_root_id BIGINT, subscribed BOOLEAN, archived BOOLEAN);
            INSERT INTO group_membership VALUES (1,7,NULL,NULL,FALSE),(1,8,NULL,FALSE,FALSE),(1,9,NULL,TRUE,TRUE),(2,10,NULL,FALSE,FALSE);
            INSERT INTO thread_user_states VALUES (1,7,100,TRUE,FALSE),(1,8,100,FALSE,FALSE);
        ").unwrap();
        let mut job = PushJob {
            chat_id: 1,
            sender_uid: 1,
            sender_username: "sender".into(),
            chat_name: "group".into(),
            message_preview: crate::services::push::PushMessagePreview {
                message: None,
                message_type: crate::models::MessageType::Text,
                sticker: None,
                attachments: vec![],
                is_deleted: false,
            },
            body_preview: None,
            message_id: 101,
            thread_root_id: None,
            mentioned_uids: vec![8, 10],
            reply_target_uid: None,
        };
        let candidates = load_recipient_candidates(&mut conn, &job).unwrap();
        assert_eq!(candidates.len(), 3);
        let settings = candidates
            .iter()
            .map(|c| (c.uid, c.notification_setting.mute_override))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(settings[&7], None);
        assert_eq!(settings[&8], Some(false));
        assert_eq!(settings[&9], Some(true));
        job.thread_root_id = Some(100);
        let candidates = load_recipient_candidates(&mut conn, &job).unwrap();
        assert_eq!(candidates.len(), 2);
        assert_eq!(
            candidates.iter().find(|c| c.uid == 7).unwrap().thread_state,
            ThreadPushState::ActiveSubscription
        );
        assert_eq!(
            candidates.iter().find(|c| c.uid == 8).unwrap().thread_state,
            ThreadPushState::NoSubscription
        );
        assert!(candidates.iter().all(|c| c.uid != 10));
    }

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
