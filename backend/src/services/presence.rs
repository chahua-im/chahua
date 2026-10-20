//! Scoped WebSocket presence snapshots.
//!
//! Presence is intentionally process-local: the connection registry is the source of live
//! status, while PostgreSQL supplies authorization and the existing HTTP-tracked last-seen
//! value. This service never writes to the database.

mod metrics;
pub use metrics::PresenceMetrics;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, NaiveDateTime, Utc};
use diesel::prelude::*;
use moka::future::Cache;

use crate::dto::ws::{GroupPresenceResponse, PresenceSnapshotPayload, UserPresenceResponse};
use crate::models::GroupKind;
use crate::schema::{group_membership, groups, user_extra};
use crate::services::social;
use crate::services::ws_registry::ConnectionRegistry;
use crate::state::DbPool;

const GROUP_COUNTS_CACHE_TTL: Duration = Duration::from_secs(15);
const MAX_CACHED_GROUPS: u64 = 128;

#[derive(Clone, Copy)]
struct GroupCounts {
    member_count: u32,
    online_count: u32,
}

#[derive(Debug)]
pub enum PresenceSnapshotError {
    Pool(diesel::r2d2::PoolError),
    Query(diesel::result::Error),
    Task(tokio::task::JoinError),
}

impl From<diesel::r2d2::PoolError> for PresenceSnapshotError {
    fn from(error: diesel::r2d2::PoolError) -> Self {
        Self::Pool(error)
    }
}

impl From<diesel::result::Error> for PresenceSnapshotError {
    fn from(error: diesel::result::Error) -> Self {
        Self::Query(error)
    }
}

/// Reads authorized presence data without updating `user_extra.last_seen_at`.
pub struct PresenceSnapshotService {
    db: DbPool,
    registry: Arc<ConnectionRegistry>,
    metrics: Arc<PresenceMetrics>,
    // Authorization is never cached; only the viewer-independent aggregate is shared.
    group_counts: Cache<i64, GroupCounts>,
}

impl PresenceSnapshotService {
    pub fn new(
        db: DbPool,
        registry: Arc<ConnectionRegistry>,
        metrics: Arc<PresenceMetrics>,
    ) -> Self {
        Self {
            db,
            registry,
            metrics,
            group_counts: Cache::builder()
                .max_capacity(MAX_CACHED_GROUPS)
                .time_to_live(GROUP_COUNTS_CACHE_TTL)
                .build(),
        }
    }

    /// Builds one absolute snapshot. Every call rechecks the viewer's current authorization.
    pub async fn snapshot(
        &self,
        viewer_uid: i32,
        request_id: Option<u64>,
        user_ids: Vec<i32>,
        chat_ids: Vec<i64>,
    ) -> Result<PresenceSnapshotPayload, Arc<PresenceSnapshotError>> {
        let started = Instant::now();
        let result = self
            .load_snapshot(viewer_uid, request_id, user_ids, chat_ids)
            .await;
        self.metrics
            .record_snapshot(result.is_ok(), started.elapsed().as_secs_f64());
        result
    }

    async fn load_snapshot(
        &self,
        viewer_uid: i32,
        request_id: Option<u64>,
        user_ids: Vec<i32>,
        chat_ids: Vec<i64>,
    ) -> Result<PresenceSnapshotPayload, Arc<PresenceSnapshotError>> {
        let db = self.db.clone();
        let registry = self.registry.clone();
        let user_ids = unique_i32(&user_ids);
        let chat_ids = unique_i64(&chat_ids);
        let scope_started = Instant::now();
        let scope_result = tokio::task::spawn_blocking(move || {
            let mut conn = db.get()?;
            let users = if user_ids.is_empty() {
                Vec::new()
            } else {
                load_visible_users(&mut conn, &registry, viewer_uid, &user_ids)?
            };
            let visible_chat_ids = if chat_ids.is_empty() {
                Vec::new()
            } else {
                load_visible_group_ids(&mut conn, viewer_uid, &chat_ids)?
            };
            Ok::<_, PresenceSnapshotError>((users, visible_chat_ids))
        })
        .await
        .map_err(|error| Arc::new(PresenceSnapshotError::Task(error)))
        .and_then(|result| result.map_err(Arc::new));
        self.metrics
            .record_scope_load(scope_result.is_ok(), scope_started.elapsed().as_secs_f64());
        let (users, visible_chat_ids) = scope_result?;

        let mut groups = Vec::with_capacity(visible_chat_ids.len());
        for chat_id in visible_chat_ids {
            let lookup_started = Instant::now();
            let counts_result = self
                .group_counts
                .try_get_with(chat_id, async {
                    let refresh_started = Instant::now();
                    let db = self.db.clone();
                    let registry = self.registry.clone();
                    let metrics = self.metrics.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        let mut conn = db.get()?;
                        let members = group_membership::table
                            .filter(group_membership::chat_id.eq(chat_id))
                            .select(group_membership::uid)
                            .load::<i32>(&mut conn)?;
                        let scan_started = Instant::now();
                        let online_count = registry.count_online(&members);
                        metrics
                            .record_group_scan(members.len(), scan_started.elapsed().as_secs_f64());
                        Ok::<_, PresenceSnapshotError>(GroupCounts {
                            member_count: members.len() as u32,
                            online_count,
                        })
                    })
                    .await
                    .map_err(PresenceSnapshotError::Task)
                    .and_then(|result| result);
                    self.metrics.record_group_refresh(
                        result.is_ok(),
                        refresh_started.elapsed().as_secs_f64(),
                    );
                    result
                })
                .await;
            self.metrics
                .record_group_lookup(lookup_started.elapsed().as_secs_f64());
            let counts = counts_result?;
            groups.push(GroupPresenceResponse {
                chat_id: chat_id.to_string(),
                member_count: counts.member_count,
                online_count: counts.online_count,
            });
        }
        Ok(PresenceSnapshotPayload {
            request_id,
            users,
            groups,
        })
    }
}

fn load_visible_users(
    conn: &mut PgConnection,
    registry: &ConnectionRegistry,
    viewer_uid: i32,
    user_ids: &[i32],
) -> Result<Vec<UserPresenceResponse>, diesel::result::Error> {
    let peers: Vec<i32> = user_ids
        .iter()
        .copied()
        .filter(|uid| *uid != viewer_uid)
        .collect();
    let relationships = social::peer_relationships(conn, viewer_uid, &peers)?;

    // Restrict shared-chat visibility to regular groups. DMs and thread subscriptions do not
    // make a user's presence discoverable. Each query is backed by the membership `(uid, chat_id)`
    // index and reads current rows for this publication.
    let viewer_chat_ids: Vec<i64> = group_membership::table
        .inner_join(groups::table)
        .filter(group_membership::uid.eq(viewer_uid))
        .filter(groups::kind.eq(GroupKind::Group))
        .select(group_membership::chat_id)
        .load(conn)?;
    let shared_members: HashSet<i32> = if viewer_chat_ids.is_empty() {
        HashSet::new()
    } else {
        group_membership::table
            .filter(group_membership::uid.eq_any(user_ids))
            .filter(group_membership::chat_id.eq_any(viewer_chat_ids))
            .select(group_membership::uid)
            .distinct()
            .load(conn)?
            .into_iter()
            .collect()
    };

    let allowed: HashSet<i32> = user_ids
        .iter()
        .copied()
        .filter(|uid| {
            if *uid == viewer_uid {
                return true;
            }
            let Some(relationship) = relationships.get(uid) else {
                return false;
            };
            !relationship.blocking
                && !relationship.blocked_by
                && (relationship.friends_since.is_some() || shared_members.contains(uid))
        })
        .collect();
    if allowed.is_empty() {
        return Ok(Vec::new());
    }

    let last_seen_by_uid: std::collections::HashMap<i32, NaiveDateTime> = user_extra::table
        .filter(user_extra::uid.eq_any(allowed.iter().copied()))
        .select((user_extra::uid, user_extra::last_seen_at))
        .load::<(i32, NaiveDateTime)>(conn)?
        .into_iter()
        .collect();

    Ok(user_ids
        .iter()
        .copied()
        .filter(|uid| allowed.contains(uid))
        .map(|uid| UserPresenceResponse {
            uid,
            online: registry.is_online(uid),
            last_seen_at: last_seen_by_uid
                .get(&uid)
                .copied()
                .map(|value| DateTime::<Utc>::from_naive_utc_and_offset(value, Utc)),
        })
        .collect())
}

fn load_visible_group_ids(
    conn: &mut PgConnection,
    viewer_uid: i32,
    chat_ids: &[i64],
) -> Result<Vec<i64>, diesel::result::Error> {
    // This membership predicate is deliberately re-run for each snapshot, so departing a group
    // cannot retain visibility through a cached watch.
    groups::table
        .inner_join(
            group_membership::table.on(group_membership::chat_id
                .eq(groups::id)
                .and(group_membership::uid.eq(viewer_uid))),
        )
        .filter(groups::id.eq_any(chat_ids))
        .filter(groups::kind.eq(GroupKind::Group))
        .select(groups::id)
        .load(conn)
}

fn unique_i32(values: &[i32]) -> Vec<i32> {
    let mut values = values.to_vec();
    values.sort_unstable();
    values.dedup();
    values
}

fn unique_i64(values: &[i64]) -> Vec<i64> {
    let mut values = values.to_vec();
    values.sort_unstable();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::ws_registry::WsMetrics;
    use diesel::r2d2::ConnectionManager;
    use prometheus::Registry;

    #[tokio::test]
    async fn failed_scope_load_records_failure_without_counting_group_work() {
        let registry = Registry::new();
        let metrics = Arc::new(PresenceMetrics::new(&registry));
        let connections = Arc::new(ConnectionRegistry::new(Arc::new(WsMetrics::new(&registry))));
        // libpq rejects this option before attempting any connection.
        let db = DbPool::builder()
            .max_size(1)
            .min_idle(Some(0))
            .connection_timeout(Duration::from_millis(10))
            .build_unchecked(ConnectionManager::<PgConnection>::new(
                "presence_test_invalid_option=value",
            ));
        let presence = PresenceSnapshotService::new(db, connections, metrics);

        assert!(presence
            .snapshot(7, Some(1), vec![], vec![123])
            .await
            .is_err());

        let rendered = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(rendered.contains("presence_snapshot_duration_seconds_count{result=\"failure\"} 1"));
        assert!(
            rendered.contains("presence_scope_load_duration_seconds_count{result=\"failure\"} 1")
        );
        assert!(rendered.contains("presence_group_count_lookup_duration_seconds_count 0"));
        assert!(rendered
            .contains("presence_group_count_refresh_duration_seconds_count{result=\"failure\"} 0"));
        assert!(rendered.contains("presence_group_members_scanned_count 0"));
    }
}
