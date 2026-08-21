use diesel::prelude::*;
use diesel::PgConnection;
use serde::Deserialize;

use crate::services::discuz::DiscuzProvider;

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
    discuz: &DiscuzProvider,
    chat_id: i64,
    after: Option<i32>,
    limit: i64,
    search: Option<&ParsedUserSearch>,
) -> QueryResult<Vec<i32>> {
    use crate::schema::group_membership::dsl as gm_dsl;

    let Some(search) = search else {
        let mut query = gm_dsl::group_membership
            .filter(gm_dsl::chat_id.eq(chat_id))
            .into_boxed();
        if let Some(after) = after {
            query = query.filter(gm_dsl::uid.gt(after));
        }
        return query
            .order(gm_dsl::uid.asc())
            .limit(limit)
            .select(gm_dsl::uid)
            .load(conn);
    };

    let member_uids: Vec<i32> = gm_dsl::group_membership
        .filter(gm_dsl::chat_id.eq(chat_id))
        .select(gm_dsl::uid)
        .load(conn)?;

    let mut uids = discuz.filter_uids_by_username_prefix(&member_uids, &search.username_prefix)?;
    if let Some(exact_uid) = search.exact_uid {
        if member_uids.contains(&exact_uid) && !uids.contains(&exact_uid) {
            uids.push(exact_uid);
        }
    }
    uids.retain(|&uid| after.is_none_or(|after| uid > after));
    uids.sort_unstable();
    uids.truncate(limit as usize);
    Ok(uids)
}
