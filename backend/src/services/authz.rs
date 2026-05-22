use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use diesel::prelude::*;
use diesel::PgConnection;

use crate::errors::AppError;
use crate::models::{PermissionResourceType, PolicySubjectType};
use crate::schema::discuz::discuz::common_member;
use crate::schema::{policy_assignments, policy_permissions};
const CACHE_TTL: Duration = Duration::from_secs(60);

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    ChatCreate,
    MemberViewAll,
    InviteCreate,
    PermissionAll,
    ServiceTokenManage,
}

impl Action {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ChatCreate => "chat.create",
            Self::MemberViewAll => "member.viewAll",
            Self::InviteCreate => "invite.create",
            Self::PermissionAll => "permission.all",
            Self::ServiceTokenManage => "serviceToken.manage",
        }
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Resource {
    Global,
    Chat(i64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct CacheKey {
    subject: CacheSubject,
    resource_type: PermissionResourceType,
    resource_id: Option<i64>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum CacheSubject {
    User {
        uid: i32,
        discuz_group_id: Option<i32>,
    },
    ServiceToken {
        token_id: i64,
    },
}

#[derive(Debug, Clone)]
struct CachedPermissionSet {
    actions: Arc<HashSet<String>>,
    cached_at: Instant,
}

pub struct AuthorizationService {
    cache: DashMap<CacheKey, CachedPermissionSet>,
}

impl AuthorizationService {
    pub fn start() -> Arc<Self> {
        Arc::new(Self {
            cache: DashMap::new(),
        })
    }

    pub fn has_permission(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        action: Action,
        resource: Resource,
    ) -> Result<bool, AppError> {
        let actions = self.load_cached_user_actions(conn, uid, resource)?;
        Ok(actions.contains(action.as_str()) || actions.contains(Action::PermissionAll.as_str()))
    }

    #[allow(dead_code)]
    pub fn has_service_token_permission(
        &self,
        conn: &mut PgConnection,
        token_id: i64,
        action: Action,
        resource: Resource,
    ) -> Result<bool, AppError> {
        let actions = self.load_cached_service_token_actions(conn, token_id, resource)?;
        Ok(actions.contains(action.as_str()) || actions.contains(Action::PermissionAll.as_str()))
    }

    pub fn list_permissions(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        resource: Resource,
    ) -> Result<Vec<String>, AppError> {
        let mut actions = self
            .load_cached_user_actions(conn, uid, resource)?
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        actions.sort();
        Ok(actions)
    }

    fn load_cached_user_actions(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        resource: Resource,
    ) -> Result<Arc<HashSet<String>>, AppError> {
        let discuz_group_id = self.lookup_discuz_group_id(conn, uid)?;
        self.load_cached_actions(
            conn,
            CacheSubject::User {
                uid,
                discuz_group_id,
            },
            resource,
        )
    }

    #[allow(dead_code)]
    fn load_cached_service_token_actions(
        &self,
        conn: &mut PgConnection,
        token_id: i64,
        resource: Resource,
    ) -> Result<Arc<HashSet<String>>, AppError> {
        self.load_cached_actions(conn, CacheSubject::ServiceToken { token_id }, resource)
    }

    fn load_cached_actions(
        &self,
        conn: &mut PgConnection,
        subject: CacheSubject,
        resource: Resource,
    ) -> Result<Arc<HashSet<String>>, AppError> {
        let cache_key = CacheKey {
            subject,
            resource_type: resource.resource_type(),
            resource_id: resource.resource_id(),
        };

        if let Some(entry) = self.cache.get(&cache_key) {
            if entry.cached_at.elapsed() <= CACHE_TTL {
                return Ok(entry.actions.clone());
            }
        }

        let actions = Arc::new(self.load_actions_for_resource(conn, subject, resource)?);

        self.cache.insert(
            cache_key,
            CachedPermissionSet {
                actions: actions.clone(),
                cached_at: Instant::now(),
            },
        );

        self.prune_stale_entries();

        Ok(actions)
    }

    pub fn require_permission(
        &self,
        conn: &mut PgConnection,
        uid: i32,
        action: Action,
        resource: Resource,
    ) -> Result<(), AppError> {
        if self.has_permission(conn, uid, action, resource)? {
            return Ok(());
        }

        Err(AppError::Forbidden("Permission required"))
    }

    #[allow(dead_code)]
    pub fn require_service_token_permission(
        &self,
        conn: &mut PgConnection,
        token_id: i64,
        action: Action,
        resource: Resource,
    ) -> Result<(), AppError> {
        if self.has_service_token_permission(conn, token_id, action, resource)? {
            return Ok(());
        }

        Err(AppError::Forbidden("Permission required"))
    }

    fn lookup_discuz_group_id(
        &self,
        conn: &mut PgConnection,
        uid: i32,
    ) -> Result<Option<i32>, AppError> {
        use crate::schema::discuz::discuz::common_member::dsl as cm_dsl;

        Ok(common_member::table
            .filter(cm_dsl::uid.eq(uid))
            .select(cm_dsl::groupid)
            .first::<i32>(conn)
            .optional()?)
    }

    fn load_actions_for_resource(
        &self,
        conn: &mut PgConnection,
        subject: CacheSubject,
        resource: Resource,
    ) -> Result<HashSet<String>, AppError> {
        use crate::schema::policy_assignments::dsl as pa_dsl;
        use crate::schema::policy_permissions::dsl as pp_dsl;

        let policy_ids = match subject {
            CacheSubject::User {
                uid,
                discuz_group_id,
            } => {
                let mut policy_ids = policy_assignments::table
                    .filter(
                        pa_dsl::subject_type
                            .eq(PolicySubjectType::User)
                            .and(pa_dsl::subject_id.eq(i64::from(uid))),
                    )
                    .select(pa_dsl::policy_id)
                    .load::<i64>(conn)?;

                if let Some(group_id) = discuz_group_id {
                    let group_policy_ids = policy_assignments::table
                        .filter(
                            pa_dsl::subject_type
                                .eq(PolicySubjectType::DiscuzGroup)
                                .and(pa_dsl::subject_id.eq(i64::from(group_id))),
                        )
                        .select(pa_dsl::policy_id)
                        .load::<i64>(conn)?;
                    policy_ids.extend(group_policy_ids);
                }

                policy_ids
            }
            CacheSubject::ServiceToken { token_id } => policy_assignments::table
                .filter(
                    pa_dsl::subject_type
                        .eq(PolicySubjectType::ServiceToken)
                        .and(pa_dsl::subject_id.eq(token_id)),
                )
                .select(pa_dsl::policy_id)
                .load::<i64>(conn)?,
        };

        if policy_ids.is_empty() {
            return Ok(HashSet::new());
        }

        let mut query = policy_permissions::table
            .filter(pp_dsl::policy_id.eq_any(policy_ids))
            .filter(pp_dsl::resource_type.eq(resource.resource_type()))
            .into_boxed();

        query = match resource {
            Resource::Global => query.filter(pp_dsl::resource_id.is_null()),
            Resource::Chat(chat_id) => query.filter(pp_dsl::resource_id.eq(Some(chat_id))),
        };

        let actions = query
            .select(pp_dsl::action)
            .distinct()
            .load::<String>(conn)?;

        Ok(actions.into_iter().collect())
    }

    fn prune_stale_entries(&self) {
        if self.cache.len() <= 1024 {
            return;
        }

        let cutoff = Instant::now() - std::time::Duration::from_secs(15 * 60);
        let stale_keys: Vec<CacheKey> = self
            .cache
            .iter()
            .filter_map(|entry| (entry.cached_at < cutoff).then_some(*entry.key()))
            .collect();

        for key in stale_keys {
            self.cache.remove(&key);
        }
    }

    #[cfg(test)]
    fn insert_cached_permissions_for_test(
        &self,
        cache_key: (i32, Option<i32>, Resource),
        actions: &[&str],
    ) {
        let (uid, discuz_group_id, resource) = cache_key;
        let actions = actions.iter().map(|action| action.to_string()).collect();
        self.cache.insert(
            CacheKey {
                subject: CacheSubject::User {
                    uid,
                    discuz_group_id,
                },
                resource_type: resource.resource_type(),
                resource_id: resource.resource_id(),
            },
            CachedPermissionSet {
                actions: Arc::new(actions),
                cached_at: Instant::now(),
            },
        );
    }
}

impl Resource {
    pub const fn resource_type(self) -> PermissionResourceType {
        match self {
            Self::Global => PermissionResourceType::Global,
            Self::Chat(_) => PermissionResourceType::Chat,
        }
    }

    pub const fn resource_id(self) -> Option<i64> {
        match self {
            Self::Global => None,
            Self::Chat(chat_id) => Some(chat_id),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AuthorizationService, Resource};

    fn empty_service() -> AuthorizationService {
        AuthorizationService {
            cache: Default::default(),
        }
    }

    #[test]
    fn resource_helpers_map_global_scope() {
        assert_eq!(Resource::Global.resource_id(), None);
    }

    #[test]
    fn prune_stale_entries_keeps_recent_entries() {
        let service = empty_service();
        service
            .insert_cached_permissions_for_test((42, Some(7), Resource::Global), &["chat.create"]);

        service.prune_stale_entries();

        assert_eq!(service.cache.len(), 1);
    }
}
