//! Discuz identity provider.
//!
//! All knowledge of the Discuz forum database — its MySQL schema, username
//! semantics, user-group titles and colors — lives behind this module. The
//! rest of the backend consumes [`UserProfile`]s and uid lists and never sees
//! a Discuz table. Avatar resolution stays in `services::avatars` because it
//! reads the Discuz avatar filesystem, not the database.

use std::collections::HashMap;

use diesel::QueryResult;
use mysql::prelude::*;
use mysql::{Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, Value};

use crate::dto::users::UserGroupTagInfo;

#[derive(Debug, Clone)]
pub struct UserProfile {
    pub username: Option<String>,
    pub gender: i16,
    pub user_group: Option<UserGroupTagInfo>,
}

pub(crate) struct DiscuzProvider {
    pool: Pool,
}

impl DiscuzProvider {
    /// Connections are opened lazily on first query, so construction succeeds
    /// without a reachable MySQL server.
    pub fn new(url: &str) -> Self {
        let opts = OptsBuilder::from_opts(
            Opts::from_url(url).expect("DISCUZ_DATABASE_URL must be a valid mysql:// URL"),
        )
        .pool_opts(PoolOpts::default().with_constraints(PoolConstraints::new(0, 16).unwrap()));
        Self {
            pool: Pool::new(opts).expect("Failed to create Discuz MySQL pool"),
        }
    }

    /// Batch profile lookup: username, gender and user-group tag (title and
    /// color) for every uid present in the forum member table.
    pub fn user_profiles(&self, uids: &[i32]) -> QueryResult<HashMap<i32, UserProfile>> {
        if uids.is_empty() {
            return Ok(HashMap::new());
        }

        type Row = (
            i32,
            String,
            Option<i16>,
            i32,
            Option<String>,
            Option<String>,
        );
        let rows: Vec<Row> = self
            .conn()?
            .exec(
                format!(
                    "SELECT cm.uid, cm.username, cmp.gender, cm.groupid, cug.grouptitle, cug.color
                     FROM common_member cm
                     LEFT JOIN common_member_profile cmp ON cmp.uid = cm.uid
                     LEFT JOIN common_usergroup cug ON cug.groupid = cm.groupid
                     WHERE cm.uid IN ({})",
                    placeholders(uids.len())
                ),
                values(uids),
            )
            .map_err(query_error)?;

        Ok(rows
            .into_iter()
            .map(|(uid, username, gender, group_id, name, color)| {
                let color = color.map(|color| format!("#{color}"));
                (
                    uid,
                    UserProfile {
                        username: Some(username),
                        gender: gender.unwrap_or(0),
                        user_group: Some(UserGroupTagInfo {
                            group_id,
                            name,
                            chat_group_color: color.clone(),
                            chat_group_color_dark: color,
                        }),
                    },
                )
            })
            .collect())
    }

    /// Case-insensitive username prefix search over the whole forum directory,
    /// ordered by uid.
    pub fn search_uids_by_username_prefix(
        &self,
        prefix: &str,
        limit: i64,
    ) -> QueryResult<Vec<i32>> {
        self.conn()?
            .exec(
                "SELECT uid FROM common_member
                 WHERE username LIKE CONCAT(?, '%') ORDER BY uid LIMIT ?",
                (prefix, limit),
            )
            .map_err(query_error)
    }

    /// Restricts `uids` to those whose username matches the prefix
    /// (case-insensitive).
    pub fn filter_uids_by_username_prefix(
        &self,
        uids: &[i32],
        prefix: &str,
    ) -> QueryResult<Vec<i32>> {
        if uids.is_empty() {
            return Ok(Vec::new());
        }

        let mut params = values(uids);
        params.push(prefix.into());
        self.conn()?
            .exec(
                format!(
                    "SELECT uid FROM common_member WHERE uid IN ({}) AND username LIKE CONCAT(?, '%')",
                    placeholders(uids.len())
                ),
                params,
            )
            .map_err(query_error)
    }

    /// The user's primary Discuz group, used as an authorization subject.
    pub fn group_id(&self, uid: i32) -> QueryResult<Option<i32>> {
        self.conn()?
            .exec_first("SELECT groupid FROM common_member WHERE uid = ?", (uid,))
            .map_err(query_error)
    }

    fn conn(&self) -> QueryResult<mysql::PooledConn> {
        self.pool.get_conn().map_err(query_error)
    }
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

fn values(uids: &[i32]) -> Vec<Value> {
    uids.iter().map(|&uid| uid.into()).collect()
}

/// Surfaces MySQL failures through the diesel error type all query call sites
/// already handle.
fn query_error(err: mysql::Error) -> diesel::result::Error {
    diesel::result::Error::QueryBuilderError(err.into())
}
