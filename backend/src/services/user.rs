use crate::{dto::users::UserGroupTagInfo, AppState};
use diesel::prelude::*;
use diesel::sql_query;
use diesel::PgConnection;
use serde::Deserialize;
use std::collections::HashMap;
use std::time::Instant;
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone)]
pub struct UserProfile {
    pub username: Option<String>,
    pub gender: i16,
    pub user_group: Option<UserGroupTagInfo>,
}

pub(crate) fn normalize_discuz_username(username: &str) -> String {
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
    sql_query(
        "SELECT cm.uid
         FROM discuz.common_member AS cm
         WHERE LOWER(BTRIM(cm.username::text)) LIKE LOWER($1) || '%'
         ORDER BY cm.uid ASC
         LIMIT $2",
    )
    .bind::<diesel::sql_types::Text, _>(username_prefix)
    .bind::<diesel::sql_types::BigInt, _>(limit)
    .load::<UserUidRow>(conn)
    .map(|rows| rows.into_iter().map(|row| row.uid).collect())
}

pub fn lookup_user_avatars(state: &AppState, uids: &[i32]) -> HashMap<i32, Option<String>> {
    let (public_url, avatar_path) =
        match (&state.discuz_avatar_public_url, &state.discuz_avatar_path) {
            (Some(url), Some(path)) => (url, path),
            _ => return HashMap::new(),
        };

    let start = Instant::now();
    let mut fs_duration_seconds = 0.0;
    let mut map = HashMap::with_capacity(uids.len());
    for &uid in uids {
        let uid1 = format!("{:0>9}", uid);
        let dir1 = &uid1[0..3];
        let dir2 = &uid1[3..5];
        let dir3 = &uid1[5..7];
        let stem = &uid1[7..9];
        let rel = format!("{}/{}/{}/{}_avatar_middle.jpg", dir1, dir2, dir3, stem);
        let full_path = format!("{}/{}", avatar_path, rel);
        let fs_start = Instant::now();
        let entry = std::fs::metadata(&full_path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| format!("{}/{}?ts={}", public_url, rel, d.as_secs()))
            .unwrap_or_else(|| format!("{}/noavatar.svg", public_url));
        fs_duration_seconds += fs_start.elapsed().as_secs_f64();
        map.insert(uid, Some(entry));
    }
    state.metrics.record_discuz_avatar_lookup(
        uids.len(),
        start.elapsed().as_secs_f64(),
        fs_duration_seconds,
    );
    map
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
