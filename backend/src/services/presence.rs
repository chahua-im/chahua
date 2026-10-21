//! Scoped WebSocket presence snapshots.
//!
//! Presence is intentionally process-local: the connection registry is the source of live
//! status, while PostgreSQL supplies authorization and the HTTP/heartbeat-tracked last-seen
//! value. This service never writes to the database.

mod changes;
pub use changes::{take_pending_changes, PresenceChange, PresenceChanges};

mod metrics;
pub use metrics::PresenceMetrics;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, NaiveDateTime, Utc};
use diesel::prelude::*;
use moka::future::Cache;

use crate::dto::ws::{
    GroupPresenceResponse, LastSeenBucket, PresenceSnapshotPayload, UserPresenceResponse,
};
use crate::models::{GroupKind, PresenceVisibility};
use crate::schema::{group_membership, groups, user_extra};
use crate::services::social;
use crate::services::ws_registry::{AppPresenceState, ConnectionRegistry};
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
    changes: tokio::sync::broadcast::Sender<PresenceChange>,
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
            changes: tokio::sync::broadcast::channel(64).0,
            group_counts: Cache::builder()
                .max_capacity(MAX_CACHED_GROUPS)
                .time_to_live(GROUP_COUNTS_CACHE_TTL)
                .build(),
        }
    }

    pub fn subscribe_changes(&self) -> PresenceChanges {
        self.changes.subscribe()
    }

    pub fn user_policy_changed(&self, uid: i32) {
        let _ = self.changes.send(PresenceChange::UserPolicy(uid));
    }

    pub fn pair_policy_changed(&self, a: i32, b: i32) {
        let _ = self.changes.send(PresenceChange::PairPolicy(a, b));
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

    // The existing publication authorization bounds the only policies we need to load.
    // The follow-up reads each policy once for the whole snapshot; it never fans out by user.
    let candidates: HashSet<i32> = user_ids
        .iter()
        .copied()
        .filter(|uid| {
            if *uid == viewer_uid {
                return true;
            }
            relationships.get(uid).is_some_and(|relationship| {
                relationship.friends_since.is_some() || shared_members.contains(uid)
            })
        })
        .collect();
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let mut policy_uids: Vec<i32> = candidates
        .iter()
        .copied()
        .filter(|uid| {
            !relationships
                .get(uid)
                .is_some_and(|peer| peer.blocking || peer.blocked_by)
        })
        .collect();
    if !policy_uids.contains(&viewer_uid) {
        policy_uids.push(viewer_uid);
    }
    let presence_by_uid: HashMap<i32, (NaiveDateTime, PresenceVisibility)> = user_extra::table
        .filter(user_extra::uid.eq_any(policy_uids))
        .select((
            user_extra::uid,
            user_extra::last_seen_at,
            user_extra::presence_visibility,
        ))
        .load::<(i32, NaiveDateTime, PresenceVisibility)>(conn)?
        .into_iter()
        .map(|(uid, last_seen_at, visibility)| (uid, (last_seen_at, visibility)))
        .collect();
    let viewer_visibility = presence_by_uid
        .get(&viewer_uid)
        .map_or(PresenceVisibility::Everyone, |(_, visibility)| *visibility);

    let now = Utc::now();
    Ok(user_ids
        .iter()
        .copied()
        .filter(|uid| candidates.contains(uid))
        .map(|uid| {
            if let Some(blocked) = relationships
                .get(&uid)
                .and_then(|peer| blocked_presence(uid, peer))
            {
                return blocked;
            }
            let peer_visibility = presence_by_uid
                .get(&uid)
                .map_or(PresenceVisibility::Everyone, |(_, visibility)| *visibility);
            let exact = uid == viewer_uid
                || relationships.get(&uid).is_some_and(|relationship| {
                    presence_is_visible(
                        false,
                        true,
                        relationship.friends_since.is_some(),
                        viewer_visibility,
                        relationship.shares_presence,
                        peer_visibility,
                        relationship.peer_shares_presence,
                    )
                });
            let last_seen_at = presence_by_uid.get(&uid).map(|(last_seen_at, _)| {
                DateTime::<Utc>::from_naive_utc_and_offset(*last_seen_at, Utc)
            });
            user_presence(
                uid,
                exact,
                registry.personal_presence(uid),
                last_seen_at,
                now,
            )
        })
        .collect())
}

fn blocked_presence(uid: i32, peer: &social::PeerRelationship) -> Option<UserPresenceResponse> {
    (peer.blocking || peer.blocked_by).then_some(UserPresenceResponse {
        uid,
        online: false,
        away: None,
        last_seen_at: None,
        last_seen_bucket: Some(LastSeenBucket::LongAgo),
    })
}

fn user_presence(
    uid: i32,
    exact: bool,
    state: Option<AppPresenceState>,
    last_seen_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> UserPresenceResponse {
    let last_seen_bucket = if exact {
        None
    } else if state.is_some() {
        Some(LastSeenBucket::Recently)
    } else {
        last_seen_at.map(|last_seen| match (now - last_seen).num_days() {
            days if days < 3 => LastSeenBucket::Recently,
            days if days < 7 => LastSeenBucket::WithinWeek,
            days if days < 30 => LastSeenBucket::WithinMonth,
            _ => LastSeenBucket::LongAgo,
        })
    };
    UserPresenceResponse {
        uid,
        online: exact && state == Some(AppPresenceState::Active),
        away: (exact && state == Some(AppPresenceState::Inactive)).then_some(true),
        last_seen_at: if exact { last_seen_at } else { None },
        last_seen_bucket,
    }
}

fn presence_is_visible(
    is_self: bool,
    is_authorized: bool,
    is_friend: bool,
    viewer_visibility: PresenceVisibility,
    viewer_override: Option<bool>,
    peer_visibility: PresenceVisibility,
    peer_override: Option<bool>,
) -> bool {
    is_self
        || (is_authorized
            && shares_presence(viewer_visibility, is_friend, viewer_override)
            && shares_presence(peer_visibility, is_friend, peer_override))
}

fn shares_presence(
    visibility: PresenceVisibility,
    is_friend: bool,
    override_value: Option<bool>,
) -> bool {
    override_value.unwrap_or(match visibility {
        PresenceVisibility::Everyone => true,
        PresenceVisibility::Friends => is_friend,
        PresenceVisibility::Nobody => false,
    })
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

    #[test]
    fn blocked_friends_receive_long_ago_in_both_directions_despite_share_overrides() {
        for (blocking, blocked_by) in [(true, false), (false, true), (true, true)] {
            let peer = social::PeerRelationship {
                blocking,
                blocked_by,
                friends_since: Some(Utc::now()),
                shares_presence: Some(true),
                peer_shares_presence: Some(true),
                ..Default::default()
            };
            assert_eq!(
                serde_json::to_value(blocked_presence(2, &peer).unwrap()).unwrap(),
                serde_json::json!({"uid": 2, "online": false, "lastSeenBucket": "longAgo"}),
            );
        }
        assert!(blocked_presence(2, &social::PeerRelationship::default()).is_none());
    }

    #[test]
    fn away_is_visible_only_with_exact_presence_permission() {
        let now = Utc::now();
        let away = Some(AppPresenceState::Inactive);
        let exact = user_presence(2, true, away, Some(now), now);
        assert!(!exact.online);
        assert_eq!(exact.away, Some(true));
        let private = user_presence(2, false, away, Some(now), now);
        let json = serde_json::to_value(private).unwrap();
        assert_eq!(json["lastSeenBucket"], "recently");
        assert_eq!(json["online"], false);
        assert!(json.get("away").is_none());
        assert!(json.get("lastSeenAt").is_none());
    }

    #[test]
    fn hidden_presence_never_serializes_exact_activity() {
        let now = Utc::now();
        for (days, bucket) in [
            (0, LastSeenBucket::Recently),
            (2, LastSeenBucket::Recently),
            (3, LastSeenBucket::WithinWeek),
            (7, LastSeenBucket::WithinMonth),
            (30, LastSeenBucket::LongAgo),
        ] {
            let response = user_presence(
                2,
                false,
                None,
                Some(now - chrono::Duration::days(days)),
                now,
            );
            assert_eq!(response.last_seen_bucket, Some(bucket));
            let json = serde_json::to_value(response).unwrap();
            assert_eq!(json["online"], false);
            assert!(json.get("lastSeenAt").is_none());
        }
        let online = user_presence(
            2,
            false,
            Some(AppPresenceState::Active),
            Some(now - chrono::Duration::days(40)),
            now,
        );
        assert_eq!(online.last_seen_bucket, Some(LastSeenBucket::Recently));
        assert!(!online.online);
        assert!(online.last_seen_at.is_none());
        let unknown = user_presence(2, false, None, None, now);
        assert!(unknown.last_seen_bucket.is_none());
        let exact = user_presence(2, true, None, Some(now), now);
        assert_eq!(exact.last_seen_at, Some(now));
        assert!(exact.last_seen_bucket.is_none());
    }

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

    #[test]
    fn global_presence_modes_and_missing_rows_default_to_everyone() {
        assert!(presence_is_visible(
            false,
            true,
            false,
            PresenceVisibility::Everyone,
            None,
            PresenceVisibility::Everyone,
            None,
        ));
        assert!(presence_is_visible(
            false,
            true,
            true,
            PresenceVisibility::Friends,
            None,
            PresenceVisibility::Friends,
            None,
        ));
        assert!(!presence_is_visible(
            false,
            true,
            false,
            PresenceVisibility::Friends,
            None,
            PresenceVisibility::Friends,
            None,
        ));
        assert!(!presence_is_visible(
            false,
            true,
            true,
            PresenceVisibility::Nobody,
            None,
            PresenceVisibility::Everyone,
            None,
        ));
    }

    #[test]
    fn friend_overrides_take_precedence_and_require_reciprocity() {
        assert!(presence_is_visible(
            false,
            true,
            true,
            PresenceVisibility::Nobody,
            Some(true),
            PresenceVisibility::Nobody,
            Some(true),
        ));
        assert!(!presence_is_visible(
            false,
            true,
            true,
            PresenceVisibility::Everyone,
            Some(false),
            PresenceVisibility::Everyone,
            Some(true),
        ));
        assert!(!presence_is_visible(
            false,
            true,
            true,
            PresenceVisibility::Everyone,
            Some(true),
            PresenceVisibility::Everyone,
            Some(false),
        ));
    }

    #[test]
    fn blocks_hide_individual_presence_but_self_remains_visible() {
        assert!(!presence_is_visible(
            false,
            false,
            true,
            PresenceVisibility::Everyone,
            Some(true),
            PresenceVisibility::Everyone,
            Some(true),
        ));
        assert!(presence_is_visible(
            true,
            false,
            false,
            PresenceVisibility::Nobody,
            None,
            PresenceVisibility::Nobody,
            None,
        ));
    }
}
