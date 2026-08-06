use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use diesel::prelude::*;
use diesel::sql_query;

use crate::dto::users::UserGroupTagInfo;
use crate::services::avatars::AvatarService;
use crate::state::DbPool;

use super::{ProviderError, UserProfile, UserProvider};

pub(crate) struct DiscuzProvider {
    pool: DbPool,
    avatars: Arc<AvatarService>,
}

impl DiscuzProvider {
    pub(crate) fn new(pool: DbPool, avatars: Arc<AvatarService>) -> Self {
        Self { pool, avatars }
    }
}

#[derive(QueryableByName)]
struct UserUidRow {
    #[diesel(sql_type = diesel::sql_types::Integer)]
    uid: i32,
}

#[derive(Queryable)]
struct DiscuzUserProfileRow {
    uid: i32,
    username: String,
    gender: Option<i16>,
    group_id: i32,
    group_name: Option<String>,
    chat_group_color: Option<String>,
    chat_group_color_dark: Option<String>,
}

#[async_trait]
impl UserProvider for DiscuzProvider {
    async fn lookup_profiles(
        &self,
        uids: &[i32],
    ) -> Result<HashMap<i32, UserProfile>, ProviderError> {
        if uids.is_empty() {
            return Ok(HashMap::new());
        }

        let pool = self.pool.clone();
        let uids = uids.to_vec();
        tokio::task::spawn_blocking(move || {
            use crate::schema::discuz::discuz::common_member::dsl as cm_dsl;
            use crate::schema::discuz::discuz::common_usergroup::dsl as cug_dsl;
            use crate::schema::discuz_manual::discuz::common_member_profile::dsl as cmp_dsl;
            use crate::schema::usergroup_extra::dsl as uge_dsl;

            let mut conn = pool
                .get()
                .map_err(|err| ProviderError::Transient(err.to_string()))?;
            let rows = cm_dsl::common_member
                .left_join(cmp_dsl::common_member_profile.on(cm_dsl::uid.eq(cmp_dsl::uid)))
                .left_join(cug_dsl::common_usergroup.on(cm_dsl::groupid.eq(cug_dsl::groupid)))
                .left_join(uge_dsl::usergroup_extra.on(cm_dsl::groupid.eq(uge_dsl::groupid)))
                .filter(cm_dsl::uid.eq_any(uids))
                .select((
                    cm_dsl::uid,
                    cm_dsl::username,
                    cmp_dsl::gender.nullable(),
                    cm_dsl::groupid,
                    cug_dsl::grouptitle.nullable(),
                    uge_dsl::chat_group_color.nullable(),
                    uge_dsl::chat_group_color_dark.nullable(),
                ))
                .load::<DiscuzUserProfileRow>(&mut conn)
                .map_err(|err| ProviderError::Transient(err.to_string()))?;

            Ok(rows
                .into_iter()
                .map(|row| {
                    (
                        row.uid,
                        UserProfile {
                            username: Some(normalize_discuz_username(&row.username)),
                            gender: row.gender.unwrap_or(0),
                            user_group: Some(UserGroupTagInfo {
                                group_id: row.group_id,
                                name: row.group_name,
                                chat_group_color: row.chat_group_color,
                                chat_group_color_dark: row.chat_group_color_dark,
                            }),
                        },
                    )
                })
                .collect())
        })
        .await
        .map_err(|err| ProviderError::Transient(err.to_string()))?
    }

    async fn lookup_avatar_urls(
        &self,
        uids: &[i32],
    ) -> Result<HashMap<i32, Option<String>>, ProviderError> {
        let avatars = self.avatars.clone();
        let uids = uids.to_vec();
        tokio::task::spawn_blocking(move || Ok(avatars.lookup(&uids)))
            .await
            .map_err(|err| ProviderError::Transient(err.to_string()))?
    }

    async fn search_uids_by_username_prefix(
        &self,
        prefix: &str,
        limit: i64,
    ) -> Result<Vec<i32>, ProviderError> {
        let pool = self.pool.clone();
        let prefix = prefix.to_string();
        tokio::task::spawn_blocking(move || {
            let mut conn = pool
                .get()
                .map_err(|err| ProviderError::Transient(err.to_string()))?;
            sql_query(
                "SELECT cm.uid
                 FROM discuz.common_member AS cm
                 WHERE LOWER(BTRIM(cm.username::text)) LIKE LOWER($1) || '%'
                 ORDER BY cm.uid ASC
                 LIMIT $2",
            )
            .bind::<diesel::sql_types::Text, _>(prefix)
            .bind::<diesel::sql_types::BigInt, _>(limit)
            .load::<UserUidRow>(&mut conn)
            .map(|rows| rows.into_iter().map(|row| row.uid).collect())
            .map_err(|err| ProviderError::Transient(err.to_string()))
        })
        .await
        .map_err(|err| ProviderError::Transient(err.to_string()))?
    }
}

fn normalize_discuz_username(username: &str) -> String {
    username.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use diesel::r2d2::{ConnectionManager, Pool};
    use diesel::PgConnection;
    use prometheus::Registry;

    use super::{normalize_discuz_username, DiscuzProvider, UserProvider};
    use crate::services::avatars::{AvatarMetrics, AvatarService};

    #[test]
    fn normalize_discuz_username_leaves_plain_values_unchanged() {
        assert_eq!(normalize_discuz_username("alice"), "alice");
    }

    #[test]
    fn normalize_discuz_username_removes_trailing_spaces() {
        assert_eq!(normalize_discuz_username("alice   "), "alice");
    }

    #[test]
    fn normalize_discuz_username_keeps_leading_spaces() {
        assert_eq!(normalize_discuz_username("  alice   "), "  alice");
    }

    #[test]
    fn normalize_discuz_username_handles_all_space_values() {
        assert_eq!(normalize_discuz_username("     "), "");
    }

    #[tokio::test]
    async fn lookup_profiles_returns_empty_without_checking_out_a_connection() {
        let pool = Pool::builder()
            .max_size(1)
            .build_unchecked(ConnectionManager::<PgConnection>::new("postgres://invalid"));
        let avatars = Arc::new(AvatarService::new(
            None,
            Arc::new(AvatarMetrics::new(&Registry::new())),
        ));
        let provider = DiscuzProvider::new(pool, avatars);

        assert!(provider.lookup_profiles(&[]).await.unwrap().is_empty());
    }
}
