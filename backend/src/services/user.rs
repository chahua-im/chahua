use crate::dto::users::UserGroupTagInfo;
use diesel::prelude::*;
use diesel::sql_query;
use diesel::PgConnection;
use serde::Deserialize;
use std::collections::HashMap;

pub fn load_chat_settings(
    conn: &mut PgConnection,
    uid: i32,
) -> QueryResult<crate::dto::users::ChatSettings> {
    use crate::schema::user_extra;
    let show_membership_messages = user_extra::table
        .find(uid)
        .select(user_extra::show_membership_messages)
        .first::<bool>(conn)
        .optional()?
        .unwrap_or(true);
    Ok(crate::dto::users::ChatSettings {
        show_membership_messages,
    })
}

/// Read the account preference, group policy and current role in one query.
pub fn load_chat_settings_for_chat(
    conn: &mut PgConnection,
    uid: i32,
    chat_id: i64,
) -> QueryResult<(
    crate::dto::users::ChatSettings,
    crate::models::GroupKind,
    crate::dto::groups::MembershipMessagePolicy,
)> {
    use crate::schema::{group_membership, groups, user_extra};
    let (kind, show, visibility, role) = groups::table
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
            groups::membership_message_visibility,
            group_membership::role.nullable(),
        ))
        .first::<(
            crate::models::GroupKind,
            Option<bool>,
            crate::models::MembershipMessageVisibility,
            Option<crate::models::GroupRole>,
        )>(conn)?;
    Ok((
        crate::dto::users::ChatSettings {
            show_membership_messages: show.unwrap_or(true),
        },
        kind,
        crate::dto::groups::MembershipMessagePolicy {
            visibility,
            can_view: kind == crate::models::GroupKind::Dm || visibility.allows(role.as_ref()),
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
    let user = NewUserExtra::new(uid, chrono::Utc::now().naive_utc());
    // Update only this preference; concurrent callers use the last committed value.
    let show_membership_messages = diesel::insert_into(user_extra::table)
        .values((
            user,
            user_extra::show_membership_messages.eq(settings.show_membership_messages),
        ))
        .on_conflict(user_extra::uid)
        .do_update()
        .set(user_extra::show_membership_messages.eq(settings.show_membership_messages))
        .returning(user_extra::show_membership_messages)
        .get_result(conn)?;
    Ok(crate::dto::users::ChatSettings {
        show_membership_messages,
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
struct MemberUidRow {
    #[diesel(sql_type = diesel::sql_types::Integer)]
    uid: i32,
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

pub fn search_group_member_uids(
    conn: &mut PgConnection,
    chat_id: i64,
    after: Option<i32>,
    limit: i64,
    search: Option<&ParsedUserSearch>,
) -> QueryResult<Vec<i32>> {
    let username_prefix = search.map(|search| search.username_prefix.clone());
    let exact_uid = search.and_then(|search| search.exact_uid);

    let query = sql_query(
        "SELECT gm.uid
         FROM group_membership AS gm
         JOIN discuz.common_member AS cm
           ON cm.uid = gm.uid
         WHERE gm.chat_id = $1
           AND ($2::int4 IS NULL OR gm.uid > $2)
           AND (
             $3::text IS NULL
             OR LOWER(BTRIM(cm.username::text)) LIKE LOWER($3) || '%'
             OR ($4::bool AND gm.uid = $5)
           )
         ORDER BY gm.uid ASC
         LIMIT $6",
    )
    .bind::<diesel::sql_types::BigInt, _>(chat_id)
    .bind::<diesel::sql_types::Nullable<diesel::sql_types::Integer>, _>(after)
    .bind::<diesel::sql_types::Nullable<diesel::sql_types::Text>, _>(username_prefix)
    .bind::<diesel::sql_types::Bool, _>(exact_uid.is_some())
    .bind::<diesel::sql_types::Nullable<diesel::sql_types::Integer>, _>(exact_uid)
    .bind::<diesel::sql_types::BigInt, _>(limit);

    query
        .load::<MemberUidRow>(conn)
        .map(|rows| rows.into_iter().map(|row| row.uid).collect())
}

pub fn search_user_uids_by_prefix(
    conn: &mut PgConnection,
    username_prefix: &str,
    limit: i64,
) -> QueryResult<Vec<i32>> {
    // Preserve UID ordering while preventing PostgreSQL from favoring a full
    // primary-key scan solely to satisfy the outer ORDER BY.
    sql_query(
        "SELECT matches.uid
         FROM (
             SELECT cm.uid
             FROM discuz.common_member AS cm
             WHERE LOWER(BTRIM(cm.username::text)) LIKE LOWER($1) || '%'
             OFFSET 0
         ) AS matches
         ORDER BY matches.uid ASC
         LIMIT $2",
    )
    .bind::<diesel::sql_types::Text, _>(username_prefix)
    .bind::<diesel::sql_types::BigInt, _>(limit)
    .load::<UserUidRow>(conn)
    .map(|rows| rows.into_iter().map(|row| row.uid).collect())
}

pub fn lookup_user_profiles(
    conn: &mut diesel::PgConnection,
    uids: &[i32],
) -> QueryResult<HashMap<i32, UserProfile>> {
    use crate::schema::discuz::discuz::common_member::dsl as cm_dsl;
    use crate::schema::discuz::discuz::common_usergroup::dsl as cug_dsl;
    use crate::schema::discuz_manual::discuz::common_member_profile::dsl as cmp_dsl;
    use crate::schema::usergroup_extra::dsl as uge_dsl;

    if uids.is_empty() {
        return Ok(HashMap::new());
    }

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
}

#[cfg(test)]
mod tests {
    use super::normalize_discuz_username;

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
            diesel::update(u::table.find(uid))
                .set((u::mute_group_chats_by_default.eq(true), u::token_gen.eq(7)))
                .execute(conn)?;
            assert!(
                !super::save_chat_settings(
                    conn,
                    uid,
                    UpdateChatSettings {
                        show_membership_messages: false
                    }
                )?
                .show_membership_messages
            );
            assert!(
                !super::save_chat_settings(
                    conn,
                    uid + 1,
                    UpdateChatSettings {
                        show_membership_messages: false
                    }
                )?
                .show_membership_messages
            );
            assert!(
                super::save_chat_settings(
                    conn,
                    uid,
                    UpdateChatSettings {
                        show_membership_messages: true
                    }
                )?
                .show_membership_messages
            );
            let saved: (bool, bool, i32) = u::table
                .find(uid)
                .select((
                    u::show_membership_messages,
                    u::mute_group_chats_by_default,
                    u::token_gen,
                ))
                .first(conn)?;
            assert_eq!(saved, (true, true, 7));
            assert!(!u::table
                .find(uid + 1)
                .select(u::show_membership_messages)
                .first::<bool>(conn)?);
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
}
