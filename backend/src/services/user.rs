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
    pub gender: i16,
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
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::SmallInt>)]
    gender: Option<i16>,
    #[diesel(sql_type = diesel::sql_types::Integer)]
    group_id: i32,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
    group_name: Option<String>,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
    chat_group_color: Option<String>,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
    chat_group_color_dark: Option<String>,
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
    #[diesel(sql_type = diesel::sql_types::Integer)]
    uid: i32,
    #[diesel(sql_type = crate::schema::sql_types::GroupRole)]
    role: GroupRole,
    #[diesel(sql_type = diesel::sql_types::Timestamptz)]
    joined_at: DateTime<Utc>,
    #[diesel(sql_type = crate::schema::sql_types::SpeakingMode)]
    speaking_mode: SpeakingMode,
    #[diesel(sql_type = diesel::sql_types::Text)]
    username: String,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::SmallInt>)]
    gender: Option<i16>,
    #[diesel(sql_type = diesel::sql_types::Integer)]
    group_id: i32,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
    group_name: Option<String>,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
    chat_group_color: Option<String>,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
    chat_group_color_dark: Option<String>,
}

pub struct UserSearchRow {
    pub uid: i32,
    pub profile: UserProfile,
    pub is_excluded: bool,
}

#[derive(QueryableByName)]
struct DiscuzUserSearchRow {
    #[diesel(sql_type = diesel::sql_types::Integer)]
    uid: i32,
    #[diesel(sql_type = diesel::sql_types::Text)]
    username: String,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::SmallInt>)]
    gender: Option<i16>,
    #[diesel(sql_type = diesel::sql_types::Integer)]
    group_id: i32,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
    group_name: Option<String>,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
    chat_group_color: Option<String>,
    #[diesel(sql_type = diesel::sql_types::Nullable<diesel::sql_types::Text>)]
    chat_group_color_dark: Option<String>,
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
        "SELECT uid, username::text AS username
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
                 cm.username::text AS username,
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
             cug.grouptitle::text AS group_name,
             uge.chat_group_color::text AS chat_group_color,
             uge.chat_group_color_dark::text AS chat_group_color_dark
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
            uid: row.uid,
            role: row.role,
            joined_at: row.joined_at,
            speaking_mode: row.speaking_mode,
            profile: UserProfile {
                username: Some(normalize_discuz_username(&row.username)),
                gender: row.gender.unwrap_or(0),
                user_group: Some(UserGroupTagInfo {
                    group_id: row.group_id,
                    name: row.group_name,
                    chat_group_color: row.chat_group_color,
                    chat_group_color_dark: row.chat_group_color_dark,
                }),
            },
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
             cm.username::text AS username,
             cmp.gender,
             cm.groupid AS group_id,
             cug.grouptitle::text AS group_name,
             uge.chat_group_color::text AS chat_group_color,
             uge.chat_group_color_dark::text AS chat_group_color_dark,
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
            uid: row.uid,
            profile: UserProfile {
                username: Some(normalize_discuz_username(&row.username)),
                gender: row.gender.unwrap_or(0),
                user_group: Some(UserGroupTagInfo {
                    group_id: row.group_id,
                    name: row.group_name,
                    chat_group_color: row.chat_group_color,
                    chat_group_color_dark: row.chat_group_color_dark,
                }),
            },
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
                 cm.username::text AS username,
                 cmp.gender,
                 cm.groupid AS group_id,
                 cug.grouptitle::text AS group_name,
                 uge.chat_group_color::text AS chat_group_color,
                 uge.chat_group_color_dark::text AS chat_group_color_dark
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
    })();
    if let Some(metrics) = metrics {
        metrics.record_profile_lookup(uids.len(), started, result.is_ok());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::normalize_discuz_username;

    #[test]
    fn profile_lookup_records_empty_success_and_database_failure() {
        use diesel::connection::SimpleConnection;
        use diesel::prelude::*;
        use std::sync::Arc;

        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        let registry = prometheus::Registry::new();
        crate::metrics::queries::attach_connection_metrics(
            &mut conn,
            Arc::new(crate::metrics::queries::QueryMetrics::new(&registry)),
        );
        assert!(super::lookup_user_profiles(&mut conn, &[])
            .unwrap()
            .is_empty());
        conn.batch_execute("BEGIN").unwrap();
        assert!(conn.batch_execute("SELECT 1 / 0").is_err());
        assert!(super::lookup_user_profiles(&mut conn, &[42, 42]).is_err());
        conn.batch_execute("ROLLBACK").unwrap();

        let rendered = crate::metrics::encode(&registry).unwrap();
        assert!(rendered.contains("profile_lookup_duration_seconds_count{outcome=\"success\"} 1"));
        assert!(rendered.contains("profile_lookup_duration_seconds_count{outcome=\"error\"} 1"));
        assert!(rendered.contains("profile_lookup_batch_size_count 2"));
        assert!(rendered.contains("profile_lookup_batch_size_sum 2"));
    }

    #[test]
    fn account_chat_settings_persist_without_changing_other_accounts_or_settings() {
        use crate::dto::users::UpdateChatSettings;
        use crate::schema::user_extra as u;
        use diesel::prelude::*;
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
            let uid = 987_665_100;
            assert!(super::load_chat_settings(conn, uid)?.show_membership_messages);
            assert!(!super::load_chat_settings(conn, uid)?.show_unread_message_count);
            // Existing accounts acquire the migration's default; a new row also defaults to visible.
            let now = chrono::Utc::now().naive_utc();
            diesel::insert_into(u::table)
                .values((
                    u::uid.eq(uid),
                    u::first_seen_at.eq(now),
                    u::last_seen_at.eq(now),
                ))
                .execute(conn)?;
            assert!(u::table
                .find(uid)
                .select(u::show_membership_messages)
                .first::<bool>(conn)?);
            assert!(!u::table
                .find(uid)
                .select(u::show_unread_message_count)
                .first::<bool>(conn)?);
            diesel::update(u::table.find(uid))
                .set((u::mute_group_chats_by_default.eq(true), u::token_gen.eq(7)))
                .execute(conn)?;
            assert!(
                !super::save_chat_settings(
                    conn,
                    uid,
                    UpdateChatSettings {
                        show_membership_messages: Some(false),
                        ..Default::default()
                    }
                )?
                .show_membership_messages
            );
            assert!(
                !super::save_chat_settings(
                    conn,
                    uid + 1,
                    UpdateChatSettings {
                        show_membership_messages: Some(false),
                        ..Default::default()
                    }
                )?
                .show_membership_messages
            );
            assert!(
                super::save_chat_settings(
                    conn,
                    uid,
                    UpdateChatSettings {
                        show_membership_messages: Some(true),
                        ..Default::default()
                    }
                )?
                .show_membership_messages
            );
            let saved = super::save_chat_settings(
                conn,
                uid,
                UpdateChatSettings {
                    show_unread_message_count: Some(true),
                    ..Default::default()
                },
            )?;
            assert!(saved.show_membership_messages && saved.show_unread_message_count);
            let saved = super::save_chat_settings(
                conn,
                uid,
                UpdateChatSettings {
                    show_membership_messages: Some(false),
                    ..Default::default()
                },
            )?;
            assert!(!saved.show_membership_messages && saved.show_unread_message_count);
            assert_eq!(
                super::save_chat_settings(conn, uid, UpdateChatSettings::default())?,
                saved
            );
            let saved: (bool, bool, i32) = u::table
                .find(uid)
                .select((
                    u::show_membership_messages,
                    u::mute_group_chats_by_default,
                    u::token_gen,
                ))
                .first(conn)?;
            assert_eq!(saved, (false, true, 7));
            assert!(!u::table
                .find(uid + 1)
                .select(u::show_membership_messages)
                .first::<bool>(conn)?);
            assert!(!super::load_chat_settings(conn, uid + 1)?.show_unread_message_count);
            Ok(())
        });
    }

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

    #[test]
    fn queries_read_from_configured_discuz_schema() {
        use diesel::connection::SimpleConnection;
        use diesel::prelude::*;

        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
            let schema = "custom_discuz_test_schema";
            let bootstrap_sql =
                include_str!("../../../runspace/discuz_bootstrap.sql").replace("discuz", schema);
            conn.batch_execute(&bootstrap_sql)?;
            conn.batch_execute(&format!(
                "INSERT INTO {schema}.common_usergroup (groupid, grouptitle)
                 VALUES (777001, 'Custom Schema Group');
                 INSERT INTO {schema}.common_member (uid, username, loginname, groupid)
                 VALUES (987665201, 'CustomPrefixAlice   ', 'custom-alice', 777001),
                        (987665202, 'CustomPrefixBob', 'custom-bob', 777001);
                 INSERT INTO {schema}.common_member_profile (uid, gender, bio, interest, field1, field2, field3, field4, field5, field6, field7, field8)
                 VALUES (987665201, 2, '', '', '', '', '', '', '', '', '', '');
                 INSERT INTO usergroup_extra (groupid, chat_group_color, chat_group_color_dark)
                 VALUES (777001, '#112233', '#445566')
                 ON CONFLICT (groupid) DO UPDATE SET
                     chat_group_color = EXCLUDED.chat_group_color,
                     chat_group_color_dark = EXCLUDED.chat_group_color_dark;
                 INSERT INTO groups (id, name)
                 VALUES (987665200, 'Custom Schema Chat')
                 ON CONFLICT (id) DO NOTHING;
                 INSERT INTO group_membership (chat_id, uid)
                 VALUES (987665200, 987665201), (987665200, 987665202);"
            ))?;

            crate::metrics::queries::attach_connection_discuz_schema(conn, schema);

            assert_eq!(
                super::lookup_discuz_group_id(conn, 987665201)?,
                Some(777001)
            );
            assert_eq!(super::lookup_discuz_group_id(conn, 987665299)?, None);

            let usernames = super::lookup_usernames(conn, &[987665201, 987665299])?;
            assert_eq!(usernames.len(), 1);
            assert_eq!(
                usernames.get(&987665201).map(String::as_str),
                Some("CustomPrefixAlice")
            );

            let profiles = super::lookup_user_profiles(conn, &[987665201, 987665202])?;
            let alice = profiles.get(&987665201).expect("alice profile");
            assert_eq!(alice.username.as_deref(), Some("CustomPrefixAlice"));
            assert_eq!(alice.gender, 2);
            let group = alice.user_group.as_ref().expect("user group");
            assert_eq!(group.group_id, 777001);
            assert_eq!(group.name.as_deref(), Some("Custom Schema Group"));
            assert_eq!(group.chat_group_color.as_deref(), Some("#112233"));
            assert_eq!(group.chat_group_color_dark.as_deref(), Some("#445566"));

            let bob = profiles.get(&987665202).expect("bob profile");
            assert_eq!(bob.username.as_deref(), Some("CustomPrefixBob"));
            assert_eq!(bob.gender, 0);

            let searched = super::search_users_with_profiles(
                conn,
                "customprefix",
                true,
                Some(987665202),
                10,
                Some(987665200),
            )?;
            assert_eq!(
                searched.iter().map(|row| row.uid).collect::<Vec<_>>(),
                vec![987665202, 987665201]
            );
            assert!(searched.iter().all(|row| row.is_excluded));

            let parsed = super::parse_user_search_query(
                Some("customprefixa"),
                super::UserSearchMode::Autocomplete,
            );
            let members =
                super::search_group_members(conn, 987665200, None, 10, parsed.as_ref())?;
            assert_eq!(members.len(), 1);
            assert_eq!(members[0].uid, 987665201);
            assert_eq!(
                members[0].profile.username.as_deref(),
                Some("CustomPrefixAlice")
            );
            assert_eq!(members[0].profile.gender, 2);
            Ok(())
        });
    }
}
