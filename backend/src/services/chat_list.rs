use chrono::{DateTime, Utc};
use diesel::prelude::*;

use crate::{
    models::{GroupKind, Message},
    schema::{group_membership, groups, media, messages},
    services::notification_preferences::ChatNotificationSetting,
};

#[derive(Queryable)]
pub(crate) struct ChatListRow {
    pub chat_id: i64,
    pub name: String,
    pub avatar_key: Option<String>,
    pub last_message_at: Option<DateTime<Utc>>,
    pub last_read_message_id: Option<i64>,
    pub last_message: Option<Message>,
    pub notification_setting: ChatNotificationSetting,
    pub archived: bool,
    pub kind: GroupKind,
    pub dm_uid1: Option<i32>,
    pub dm_uid2: Option<i32>,
    pub membership_visibility: crate::models::MembershipMessageVisibility,
    pub membership_allowed: bool,
}

/// Resolve the visible message before ordering or limiting the chat page. The
/// correlated LIMIT 1 uses the top-level index per joined chat, rather than
/// scanning message histories with DISTINCT ON. Diesel cannot express this
/// correlated join target directly; the remaining query uses its typed DSL.
pub(crate) fn load_chat_page(
    conn: &mut PgConnection,
    uid: i32,
    archived: bool,
    chat_id: Option<i64>,
    after: Option<i64>,
    limit: i64,
    hide_membership_messages: bool,
) -> QueryResult<Vec<ChatListRow>> {
    let last_id = format!(
        "CASE WHEN groups.kind = 'group' AND ({} OR NOT {}) THEN (
           SELECT id FROM messages WHERE chat_id = groups.id
             AND is_published = true AND reply_root_id IS NULL
             AND deleted_at IS NULL AND {}
           ORDER BY id DESC LIMIT 1
         ) ELSE groups.last_message_id END",
        hide_membership_messages,
        super::system_messages::MEMBERSHIP_ALLOWED_PREDICATE,
        super::system_messages::NON_MEMBERSHIP_PREDICATE,
    );
    macro_rules! base_query {
        () => {
            groups::table
                .inner_join(group_membership::table)
                .left_join(
                    messages::table.on(messages::id.nullable().eq(diesel::dsl::sql::<
                        diesel::sql_types::Nullable<diesel::sql_types::BigInt>,
                    >(&last_id))),
                )
                .filter(group_membership::uid.eq(uid))
        };
    }
    let mut query = base_query!()
        .left_join(
            media::table.on(groups::avatar_image_id
                .eq(media::id.nullable())
                .and(media::deleted_at.is_null())),
        )
        .filter(group_membership::archived.eq(archived))
        .select((
            groups::id,
            groups::name,
            media::storage_key.nullable(),
            messages::created_at.nullable(),
            group_membership::last_read_message_id,
            messages::all_columns.nullable(),
            (
                group_membership::muted_until,
                group_membership::mute_override,
            ),
            group_membership::archived,
            groups::kind,
            groups::dm_uid1,
            groups::dm_uid2,
            groups::membership_message_visibility,
            super::system_messages::membership_allowed(),
        ))
        .into_boxed();
    if let Some(id) = chat_id {
        query = query.filter(groups::id.eq(id));
    }
    if let Some(id) = after {
        let cursor = base_query!()
            .filter(groups::id.eq(id))
            .select(messages::created_at.nullable())
            .first::<Option<DateTime<Utc>>>(conn)
            .optional()?;
        match cursor {
            None => return Ok(vec![]),
            Some(Some(at)) => {
                query = query.filter(
                    messages::created_at
                        .lt(at)
                        .or(messages::created_at.eq(at).and(groups::id.lt(id)))
                        .or(messages::created_at.is_null()),
                );
            }
            Some(None) => {
                query = query.filter(messages::created_at.is_null().and(groups::id.lt(id)));
            }
        }
    }
    query
        .order((messages::created_at.desc().nulls_last(), groups::id.desc()))
        .limit(limit)
        .load(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::connection::SimpleConnection;

    #[test]
    fn visible_order_and_cursors_share_the_same_message_boundary() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
            conn.batch_execute("INSERT INTO groups(id, name) VALUES
                (987665201, 'A'), (987665202, 'B'), (987665203, 'hidden'),
                (987665204, 'empty'), (987665205, 'same-time'), (987665206, 'archived'),
                (987665207, 'not-a-member');
                INSERT INTO group_membership(chat_id, uid, archived)
                  SELECT id, 987665200, id = 987665206 FROM groups
                  WHERE id BETWEEN 987665201 AND 987665206;
                INSERT INTO messages(id, chat_id, sender_uid, client_generated_id, message_type, system_kind, message, created_at) VALUES
                  (987665301, 987665201, 1717, 'visible-A', 'text', NULL, 'A', '2026-10-24 10:00Z'),
                  (987665302, 987665201, 1717, 'hidden-A', 'system', 'member_joined', 'joined', '2026-10-24 12:00Z'),
                  (987665303, 987665202, 1717, 'visible-B', 'text', NULL, 'B', '2026-10-24 11:00Z'),
                  (987665304, 987665203, 1717, 'hidden-only', 'system', 'member_left', 'left', '2026-10-24 13:00Z'),
                  (987665305, 987665205, 1717, 'same-time', 'text', NULL, 'C', '2026-10-24 11:00Z'),
                  (987665306, 987665206, 1717, 'archived', 'text', NULL, 'D', '2026-10-24 14:00Z');
                UPDATE groups SET last_message_id = latest.id, last_message_at = latest.created_at
                  FROM (SELECT DISTINCT ON (chat_id) chat_id, id, created_at FROM messages
                    WHERE chat_id BETWEEN 987665201 AND 987665206 ORDER BY chat_id, id DESC) latest
                  WHERE groups.id = latest.chat_id;")?;
            let uid = 987665200;
            let first = load_chat_page(conn, uid, false, None, None, 2, true)?;
            assert_eq!(first.iter().map(|r| r.chat_id).collect::<Vec<_>>(), [987665205, 987665202]);
            let second = load_chat_page(conn, uid, false, None, Some(first[1].chat_id), 2, true)?;
            assert_eq!(second.iter().map(|r| r.chat_id).collect::<Vec<_>>(), [987665201, 987665204]);
            assert_eq!(second[0].last_message.as_ref().unwrap().id, 987665301);
            assert_eq!(second[0].last_message_at, Some(second[0].last_message.as_ref().unwrap().created_at));
            let tail = load_chat_page(conn, uid, false, None, Some(second[1].chat_id), 2, true)?;
            assert_eq!(tail.len(), 1);
            assert_eq!(tail[0].chat_id, 987665203);
            assert!(tail[0].last_message_at.is_none() && tail[0].last_message.is_none());
            assert!(load_chat_page(conn, uid, false, None, Some(987665207), 2, true)?.is_empty());
            let archived = load_chat_page(conn, uid, true, None, None, 10, true)?;
            assert_eq!(archived.len(), 1);
            assert_eq!(archived[0].chat_id, 987665206);
            let unfiltered = load_chat_page(conn, uid, false, None, None, 10, false)?;
            assert_eq!(unfiltered[0].chat_id, 987665203);
            assert_eq!(unfiltered[1].chat_id, 987665201);
            // A hidden arrival changes neither visible order nor cursor.
            conn.batch_execute("INSERT INTO messages(id, chat_id, sender_uid, client_generated_id, message_type, system_kind, created_at)
                VALUES (987665308, 987665201, 1717, 'later-hidden', 'system', 'member_added', '2026-10-24 15:00Z');
                UPDATE groups SET last_message_id = 987665308, last_message_at = '2026-10-24 15:00Z' WHERE id = 987665201;")?;
            let next = load_chat_page(conn, uid, false, None, Some(987665202), 2, true)?;
            assert_eq!(next[0].last_message.as_ref().unwrap().id, 987665301);
            assert!(crate::services::user::load_chat_settings(conn, uid)?.show_membership_messages);
            crate::services::user::save_chat_settings(conn, uid, crate::dto::users::UpdateChatSettings { show_membership_messages: false })?;
            assert!(!crate::services::user::load_chat_settings(conn, uid)?.show_membership_messages);
            Ok(())
        });
    }
}
