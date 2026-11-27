use crate::dto::users::UserGroupTagInfo;
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::sql_query;
use diesel::PgConnection;
use serde::Deserialize;
use std::collections::HashMap;

use crate::{
    dto::{groups::MembershipMessagePolicy, users::ChatSettings},
    models::{GroupKind, GroupRole, MembershipMessageVisibility, SpeakingMode},
};

fn quoted_discuz_schema(conn: &mut PgConnection) -> String {
    let schema = crate::metrics::queries::connection_discuz_schema(conn);
    debug_assert!(crate::config::validate_discuz_schema(&schema).is_ok());
    format!("\"{schema}\"")
}

#[derive(QueryableByName)]
struct GroupIdRow {
    #[diesel(sql_type = diesel::sql_types::Integer)]
    groupid: i32,
}

pub(super) fn lookup_discuz_group_id(
    conn: &mut PgConnection,
    uid: i32,
) -> QueryResult<Option<i32>> {
    let schema = quoted_discuz_schema(conn);
    sql_query(format!(
        "SELECT groupid FROM {schema}.common_member WHERE uid = $1"
    ))
    .bind::<diesel::sql_types::Integer, _>(uid)
    .get_result::<GroupIdRow>(conn)
    .optional()
    .map(|row| row.map(|row| row.groupid))
}

pub fn load_chat_settings(
    conn: &mut PgConnection,
    uid: i32,
) -> QueryResult<crate::dto::users::ChatSettings> {
    use crate::schema::user_extra;
    let (show_membership_messages, show_unread_message_count) = user_extra::table
        .find(uid)
        .select((
            user_extra::show_membership_messages,
            user_extra::show_unread_message_count,
        ))
        .first::<(bool, bool)>(conn)
        .optional()?
        .unwrap_or((true, false));
    Ok(crate::dto::users::ChatSettings {
        show_membership_messages,
        show_unread_message_count,
    })
}

/// Read the account preference, group policy and current role in one query.
pub fn load_chat_settings_for_chat(
    conn: &mut PgConnection,
    uid: i32,
    chat_id: i64,
) -> QueryResult<(ChatSettings, GroupKind, MembershipMessagePolicy)> {
    let viewer = load_chat_viewer(conn, uid, chat_id)?.ok_or(diesel::result::Error::NotFound)?;
    Ok((viewer.settings, viewer.kind, viewer.policy))
}

pub(crate) struct ChatViewer {
    pub settings: ChatSettings,
    pub kind: GroupKind,
    pub policy: MembershipMessagePolicy,
    pub role: Option<GroupRole>,
    pub joined_at: Option<DateTime<Utc>>,
}

pub(crate) fn load_chat_viewer(
    conn: &mut PgConnection,
    uid: i32,
    chat_id: i64,
) -> QueryResult<Option<ChatViewer>> {
    use crate::schema::{group_membership, groups, user_extra};
    let row = groups::table
        .left_join(user_extra::table.on(user_extra::uid.eq(uid)))
        .left_join(
            group_membership::table.on(group_membership::chat_id
                .eq(groups::id)
                .and(group_membership::uid.eq(uid))),
        )
        .filter(groups::id.eq(chat_id))
        .select((
            groups::kind,
            user_extra::show_membership_messages.nullable(),
            user_extra::show_unread_message_count.nullable(),
            groups::membership_message_visibility,
            group_membership::role.nullable(),
            group_membership::joined_at.nullable(),
        ))
        .first::<(
            GroupKind,
            Option<bool>,
            Option<bool>,
            MembershipMessageVisibility,
            Option<GroupRole>,
            Option<DateTime<Utc>>,
        )>(conn)
        .optional()?;
    Ok(row.map(
        |(kind, show, show_unread_message_count, visibility, role, joined_at)| ChatViewer {
            settings: ChatSettings {
                show_membership_messages: show.unwrap_or(true),
                show_unread_message_count: show_unread_message_count.unwrap_or(false),
            },
            kind,
            policy: MembershipMessagePolicy {
                visibility,
                can_view: kind == GroupKind::Dm || visibility.allows(role.as_ref()),
            },
            role,
            joined_at,
        },
    ))
}

pub fn save_chat_settings(
    conn: &mut PgConnection,
    uid: i32,
    settings: crate::dto::users::UpdateChatSettings,
) -> QueryResult<crate::dto::users::ChatSettings> {
    use crate::models::NewUserExtra;
    use crate::schema::user_extra;
    conn.transaction(|conn| {
        diesel::insert_into(user_extra::table)
            .values(NewUserExtra::new(uid, chrono::Utc::now().naive_utc()))
            .on_conflict(user_extra::uid)
            .do_nothing()
            .execute(conn)?;
        // Diesel's optional changeset writes only supplied fields, never a stale sibling.
        if settings.show_membership_messages.is_some()
            || settings.show_unread_message_count.is_some()
        {
            diesel::update(user_extra::table.find(uid))
                .set(settings)
                .execute(conn)?;
        }
        load_chat_settings(conn, uid)
    })
}

#[derive(Debug, Clone)]
pub struct UserProfile {
    pub username: Option<String>,
    pub gender: i32,
    pub user_group: Option<UserGroupTagInfo>,
}

pub fn normalize_discuz_username(username: &str) -> String {
    username.trim_end().to_string()
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum UserSearchMode {
    Autocomplete,
    Submitted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedUserSearch {
    pub username_prefix: String,
    pub exact_uid: Option<i32>,
}

#[derive(QueryableByName)]
struct UsernameRow {
    #[diesel(sql_type = diesel::sql_types::Integer)]
    uid: i32,
    #[diesel(sql_type = diesel::sql_types::Text)]
    username: String,
}

#[derive(QueryableByName)]
struct DiscuzUserProfileRow {
    #[diesel(sql_type = diesel::sql_types::Integer)]
    uid: i32,
    #[diesel(sql_type = diesel::sql_types::Text)]
    username: String,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Integer>)]
    gender: Option<i32>,
    #[diesel(sql_type = diesel::sql_types::Integer)]
    group_id: i32,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
    group_name: Option<String>,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
    chat_group_color: Option<String>,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
    chat_group_color_dark: Option<String>,
}

impl DiscuzUserProfileRow {
    fn into_profile(self) -> UserProfile {
        UserProfile {
            username: Some(normalize_discuz_username(&self.username)),
            gender: self.gender.unwrap_or(0),
            user_group: Some(UserGroupTagInfo {
                group_id: self.group_id,
                name: self.group_name,
                chat_group_color: self.chat_group_color,
                chat_group_color_dark: self.chat_group_color_dark,
            }),
        }
    }
}

pub struct GroupMemberProfileRow {
    pub uid: i32,
    pub role: GroupRole,
    pub joined_at: DateTime<Utc>,
    pub speaking_mode: SpeakingMode,
    pub profile: UserProfile,
}

#[derive(QueryableByName)]
struct DiscuzGroupMemberRow {
    #[diesel(embed)]
    profile: DiscuzUserProfileRow,
    #[diesel(sql_type = crate::schema::sql_types::GroupRole)]
    role: GroupRole,
    #[diesel(sql_type = diesel::sql_types::Timestamptz)]
    joined_at: DateTime<Utc>,
    #[diesel(sql_type = crate::schema::sql_types::SpeakingMode)]
    speaking_mode: SpeakingMode,
}

pub struct UserSearchRow {
    pub uid: i32,
    pub profile: UserProfile,
    pub is_excluded: bool,
}

#[derive(QueryableByName)]
struct DiscuzUserSearchRow {
    #[diesel(embed)]
    profile: DiscuzUserProfileRow,
    #[diesel(sql_type = diesel::sql_types::Bool)]
    is_excluded: bool,
}

pub fn parse_user_search_query(
    raw_query: Option<&str>,
    mode: UserSearchMode,
) -> Option<ParsedUserSearch> {
    let query = raw_query?.trim();
    if query.is_empty() {
        return None;
    }

    let exact_uid = (mode == UserSearchMode::Submitted)
        .then(|| query.parse::<i32>().ok())
        .flatten();

    Some(ParsedUserSearch {
        username_prefix: query.to_string(),
        exact_uid,
    })
}

pub fn lookup_usernames(
    conn: &mut PgConnection,
    uids: &[i32],
) -> QueryResult<HashMap<i32, String>> {
    if uids.is_empty() {
        return Ok(HashMap::new());
    }
    let schema = quoted_discuz_schema(conn);
    let rows = sql_query(format!(
        "SELECT uid, username
         FROM {schema}.common_member
         WHERE uid = ANY($1)",
    ))
    .bind::<diesel::sql_types::Array<diesel::sql_types::Integer>, _>(uids)
    .load::<UsernameRow>(conn)?;

    Ok(rows
        .into_iter()
        .map(|row| (row.uid, normalize_discuz_username(&row.username)))
        .collect())
}

pub fn search_group_members(
    conn: &mut PgConnection,
    chat_id: i64,
    after: Option<i32>,
    limit: i64,
    search: Option<&ParsedUserSearch>,
) -> QueryResult<Vec<GroupMemberProfileRow>> {
    let username_prefix = search.map(|search| search.username_prefix.clone());
    let exact_uid = search.and_then(|search| search.exact_uid);

    let schema = quoted_discuz_schema(conn);
    let rows = sql_query(format!(
        "WITH page AS (
             SELECT
                 gm.uid,
                 gm.role,
                 gm.joined_at,
                 gm.speaking_mode,
                 cm.username,
                 cm.groupid AS group_id
             FROM group_membership AS gm
             JOIN {schema}.common_member AS cm
               ON cm.uid = gm.uid
             WHERE gm.chat_id = $1
               AND ($2::int4 IS NULL OR gm.uid > $2)
               AND (
                 $3::text IS NULL
                 OR LOWER(BTRIM(cm.username::text)) LIKE LOWER($3) || '%'
                 OR ($4::bool AND gm.uid = $5)
               )
             ORDER BY gm.uid ASC
             LIMIT $6
         )
         SELECT
             page.uid,
             page.role,
             page.joined_at,
             page.speaking_mode,
             page.username,
             cmp.gender,
             page.group_id,
             cug.grouptitle AS group_name,
             uge.chat_group_color,
             uge.chat_group_color_dark
         FROM page
         LEFT JOIN {schema}.common_member_profile AS cmp
           ON page.uid = cmp.uid
         LEFT JOIN {schema}.common_usergroup AS cug
           ON page.group_id = cug.groupid
         LEFT JOIN usergroup_extra AS uge
           ON page.group_id = uge.groupid
         ORDER BY page.uid ASC",
    ))
    .bind::<diesel::sql_types::BigInt, _>(chat_id)
    .bind::<diesel::sql_types::Nullable<diesel::sql_types::Integer>, _>(after)
    .bind::<diesel::sql_types::Nullable<diesel::sql_types::Text>, _>(username_prefix)
    .bind::<diesel::sql_types::Bool, _>(exact_uid.is_some())
    .bind::<diesel::sql_types::Nullable<diesel::sql_types::Integer>, _>(exact_uid)
    .bind::<diesel::sql_types::BigInt, _>(limit)
    .load::<DiscuzGroupMemberRow>(conn)?;

    Ok(rows
        .into_iter()
        .map(|row| GroupMemberProfileRow {
            uid: row.profile.uid,
            role: row.role,
            joined_at: row.joined_at,
            speaking_mode: row.speaking_mode,
            profile: row.profile.into_profile(),
        })
        .collect())
}

pub fn search_users_with_profiles(
    conn: &mut PgConnection,
    username_prefix: &str,
    allow_prefix_search: bool,
    exact_uid: Option<i32>,
    limit: i64,
    exclude_chat_id: Option<i64>,
) -> QueryResult<Vec<UserSearchRow>> {
    if !allow_prefix_search && exact_uid.is_none() {
        return Ok(Vec::new());
    }

    let schema = quoted_discuz_schema(conn);
    // Keep only cm.uid inside the OFFSET 0 subquery so PostgreSQL uses an
    // Index-Only Scan on idx_common_member_username_prefix before LIMIT.
    let rows = sql_query(format!(
        "WITH prefix_uids AS (
             SELECT matches.uid
             FROM (
                 SELECT cm.uid
                 FROM {schema}.common_member AS cm
                 WHERE $1::bool
                   AND LOWER(BTRIM(cm.username::text)) LIKE LOWER($2) || '%'
                 OFFSET 0
             ) AS matches
             ORDER BY matches.uid ASC
             LIMIT $3
         ),
         combined_uids AS (
             SELECT $4::int4 AS uid, 0 AS sort_rank
             WHERE $4::int4 IS NOT NULL
             UNION ALL
             SELECT uid, 1 AS sort_rank
             FROM prefix_uids
             WHERE $4::int4 IS NULL OR uid <> $4
         )
         SELECT
             cm.uid,
             cm.username,
             cmp.gender,
             cm.groupid AS group_id,
             cug.grouptitle AS group_name,
             uge.chat_group_color,
             uge.chat_group_color_dark,
             (gm.uid IS NOT NULL) AS is_excluded
         FROM combined_uids AS c
         JOIN {schema}.common_member AS cm
           ON cm.uid = c.uid
         LEFT JOIN {schema}.common_member_profile AS cmp
           ON cm.uid = cmp.uid
         LEFT JOIN {schema}.common_usergroup AS cug
           ON cm.groupid = cug.groupid
         LEFT JOIN usergroup_extra AS uge
           ON cm.groupid = uge.groupid
         LEFT JOIN group_membership AS gm
           ON $5::int8 IS NOT NULL AND gm.chat_id = $5 AND gm.uid = cm.uid
         ORDER BY c.sort_rank ASC, cm.uid ASC",
    ))
    .bind::<diesel::sql_types::Bool, _>(allow_prefix_search)
    .bind::<diesel::sql_types::Text, _>(username_prefix)
    .bind::<diesel::sql_types::BigInt, _>(limit)
    .bind::<diesel::sql_types::Nullable<diesel::sql_types::Integer>, _>(exact_uid)
    .bind::<diesel::sql_types::Nullable<diesel::sql_types::BigInt>, _>(exclude_chat_id)
    .load::<DiscuzUserSearchRow>(conn)?;

    Ok(rows
        .into_iter()
        .map(|row| UserSearchRow {
            uid: row.profile.uid,
            profile: row.profile.into_profile(),
            is_excluded: row.is_excluded,
        })
        .collect())
}

pub fn lookup_user_profiles(
    conn: &mut diesel::PgConnection,
    uids: &[i32],
) -> QueryResult<HashMap<i32, UserProfile>> {
    let started = std::time::Instant::now();
    let metrics = crate::metrics::queries::connection_metrics(conn);
    let schema = quoted_discuz_schema(conn);
    let result = (|| {
        if uids.is_empty() {
            return Ok(HashMap::new());
        }

        let rows = sql_query(format!(
            "SELECT
                 cm.uid,
                 cm.username,
                 cmp.gender,
                 cm.groupid AS group_id,
                 cug.grouptitle AS group_name,
                 uge.chat_group_color,
                 uge.chat_group_color_dark
             FROM {schema}.common_member AS cm
             LEFT JOIN {schema}.common_member_profile AS cmp
               ON cm.uid = cmp.uid
             LEFT JOIN {schema}.common_usergroup AS cug
               ON cm.groupid = cug.groupid
             LEFT JOIN usergroup_extra AS uge
               ON cm.groupid = uge.groupid
             WHERE cm.uid = ANY($1)",
        ))
        .bind::<diesel::sql_types::Array<diesel::sql_types::Integer>, _>(uids)
        .load::<DiscuzUserProfileRow>(conn)?;

        Ok(rows
            .into_iter()
            .map(|row| (row.uid, row.into_profile()))
            .collect())
    })();
    if let Some(metrics) = metrics {
        metrics.record_profile_lookup(uids.len(), started, result.is_ok());
    }
    result
}

#[cfg(test)]
mod tests;
