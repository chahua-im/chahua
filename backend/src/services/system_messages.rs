//! Persist link destinations alongside system text without changing legacy client text.
use serde::{Deserialize, Serialize};

use crate::{
    dto::messages::SystemMessageLinks,
    models::{GroupKind, MessageType},
};

/// Keep this literal identical to the partial-index predicate.
pub const NON_MEMBERSHIP_PREDICATE: &str = "(system_kind IS NULL OR system_kind NOT IN ('member_joined', 'member_left', 'member_added', 'member_removed'))";

/// Shared by the correlated chat-preview SQL and bulk membership joins.
/// Keeping one predicate avoids per-user policy queries in fanout and unread paths.
pub const MEMBERSHIP_ALLOWED_PREDICATE: &str = "(groups.kind = 'dm' OR groups.membership_message_visibility = 'members' OR (groups.membership_message_visibility = 'admins' AND group_membership.role = 'admin'))";

pub fn membership_allowed() -> diesel::expression::SqlLiteral<diesel::sql_types::Bool> {
    diesel::dsl::sql(MEMBERSHIP_ALLOWED_PREDICATE)
}

pub fn hides_membership_messages(
    show_membership_messages: bool,
    kind: GroupKind,
    thread_id: Option<i64>,
) -> bool {
    !show_membership_messages && kind == GroupKind::Group && thread_id.is_none()
}

pub fn load_membership_message_filter(
    conn: &mut diesel::PgConnection,
    uid: i32,
    chat_id: i64,
) -> diesel::QueryResult<bool> {
    let (settings, kind, policy) = super::user::load_chat_settings_for_chat(conn, uid, chat_id)?;
    Ok(hides_membership_messages(
        settings.show_membership_messages && policy.can_view,
        kind,
        None,
    ))
}

#[derive(Serialize, Deserialize)]
struct StoredSystemMessage {
    text: String,
    links: SystemMessageLinks,
}

pub fn with_user(text: String, uid: i32) -> String {
    serde_json::json!({ "text": text, "links": { "uid": uid } }).to_string()
}

pub fn with_message(text: &str, message_id: i64) -> String {
    serde_json::json!({ "text": text, "links": { "messageId": message_id.to_string() } })
        .to_string()
}

/// Legacy system strings and ordinary user text pass through unchanged.
pub fn decode(
    message_type: &MessageType,
    message: Option<String>,
) -> (Option<String>, Option<SystemMessageLinks>) {
    if *message_type == MessageType::System {
        if let Some(stored) = message
            .as_deref()
            .and_then(|text| serde_json::from_str::<StoredSystemMessage>(text).ok())
        {
            return (Some(stored.text), Some(stored.links));
        }
    }
    (message, None)
}

/// Notify members to reload the current policy; event delivery order carries no state.
pub fn broadcast_policy(
    conn: &mut diesel::PgConnection,
    registry: &super::ws_registry::ConnectionRegistry,
    chat_id: i64,
) -> diesel::QueryResult<()> {
    use crate::{
        dto::{groups::MembershipMessagePolicyChanged, ws::ServerWsMessage},
        schema::group_membership,
    };
    use diesel::prelude::*;
    let uids = group_membership::table
        .filter(group_membership::chat_id.eq(chat_id))
        .select(group_membership::uid)
        .load::<i32>(conn)?;
    registry.broadcast_to_uids(
        &uids,
        std::sync::Arc::new(ServerWsMessage::MembershipMessagePolicyChanged(
            MembershipMessagePolicyChanged { chat_id },
        )),
    );
    registry.invalidate_unread(&uids);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_membership_policy_controls_queries_realtime_and_read_cursors() {
        use crate::{
            dto::ws::ServerWsMessage,
            models::{GroupRole, MembershipMessageVisibility as Visibility},
            schema::{group_membership, groups},
            services::{
                unread::UnreadService,
                ws_registry::{ConnectionRegistry, WsMetrics},
            },
        };
        use diesel::{connection::SimpleConnection, prelude::*};
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            return;
        };
        let mut conn = diesel::PgConnection::establish(&url).unwrap();
        conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
            let chat_id = 9876760000_i64;
            let admin = 987676001;
            let member = 987676002;
            conn.batch_execute("INSERT INTO groups(id,name) VALUES (9876760000,'membership-policy-test');
                INSERT INTO group_membership(chat_id,uid,role,mute_override) VALUES (9876760000,987676001,'admin',false),(9876760000,987676002,'member',false);
                INSERT INTO messages(id,chat_id,sender_uid,client_generated_id,message_type,system_kind,message,created_at)
                    VALUES (9876760001,9876760000,987676001,'policy-text','text',NULL,'hello',NOW()),
                           (9876760002,9876760000,987676001,'policy-join','system','member_joined','joined the chat',NOW());
                UPDATE groups SET last_message_id=9876760002 WHERE id=9876760000;")?;
            let registry = ConnectionRegistry::new(std::sync::Arc::new(WsMetrics::new(&prometheus::Registry::new())));
            let (_, mut admin_rx) = registry.register(admin, "policy-admin".into());
            let (_, mut member_rx) = registry.register(member, "policy-member".into());
            while admin_rx.try_recv().is_ok() {}
            while member_rx.try_recv().is_ok() {}
            let unread = UnreadService::new();
            for visibility in [Visibility::Members, Visibility::Admins, Visibility::Nobody] {
                diesel::update(groups::table.find(chat_id)).set(groups::membership_message_visibility.eq(visibility)).execute(conn)?;
                for (uid, role) in [(admin, GroupRole::Admin), (member, GroupRole::Member)] {
                    let allowed = visibility.allows(Some(&role));
                    let (_, _, policy) = super::super::user::load_chat_settings_for_chat(conn, uid, chat_id)?;
                    assert_eq!(policy.can_view, allowed);
                    assert_eq!(load_membership_message_filter(conn, uid, chat_id)?, !allowed);
                    let rows = super::super::chat_list::load_chat_page(conn, uid, false, Some(chat_id), None, 10, false)?;
                    assert_eq!(rows[0].last_message.as_ref().unwrap().id, if allowed {chat_id+2} else {chat_id+1});
                    assert_eq!(unread.count_chat_unread(conn, uid, chat_id, None)?, if allowed {2} else {1});
                    assert_eq!(unread.count_users_unread_totals(conn, &[uid])?[&uid], if allowed {2} else {1});
                }
                broadcast_policy(conn, &registry, chat_id)?;
                for rx in [&mut admin_rx, &mut member_rx] {
                    let event = rx.try_recv().unwrap();
                    let ServerWsMessage::MembershipMessagePolicyChanged(payload) = &*event else { panic!("expected policy event") };
                    assert_eq!(payload.chat_id, chat_id);
                }
                // Joining must still reach the new member when announcements are denied.
                super::super::chat::publish_membership_changed(&registry, member, chat_id);
                let event = member_rx.try_recv().unwrap();
                assert!(matches!(&*event, ServerWsMessage::ChatMembershipChanged(payload) if payload.chat_id == chat_id));
                assert!(admin_rx.try_recv().is_err());
            }
            // A personal preference can hide an allowed message, never grant access.
            diesel::update(groups::table.find(chat_id)).set(groups::membership_message_visibility.eq(Visibility::Members)).execute(conn)?;
            super::super::user::save_chat_settings(conn, member, crate::dto::users::UpdateChatSettings { show_membership_messages: false })?;
            assert!(load_membership_message_filter(conn, member, chat_id)?);
            // Reading the last visible message advances over the hidden tail; restoring policy never rewinds it.
            super::super::chat::mark_chat_as_read(conn, chat_id, member, chat_id + 1)?;
            assert_eq!(super::super::chat::get_chat_last_read_message_id(conn, chat_id, member)?, Some(chat_id+2));
            super::super::user::save_chat_settings(conn, member, crate::dto::users::UpdateChatSettings { show_membership_messages: true })?;
            assert_eq!(unread.count_chat_unread(conn, member, chat_id, Some(chat_id+2))?, 0);
            // Demotion immediately changes the same query predicate used by WS recipient selection.
            diesel::update(groups::table.find(chat_id)).set(groups::membership_message_visibility.eq(Visibility::Admins)).execute(conn)?;
            let recipients = || group_membership::table.inner_join(groups::table).filter(groups::id.eq(chat_id)).filter(membership_allowed()).select(group_membership::uid);
            assert_eq!(recipients().load::<i32>(conn)?, vec![admin]);
            diesel::update(group_membership::table.filter(group_membership::chat_id.eq(chat_id)).filter(group_membership::uid.eq(admin))).set(group_membership::role.eq(GroupRole::Member)).execute(conn)?;
            assert!(recipients().load::<i32>(conn)?.is_empty());
            assert!(load_membership_message_filter(conn, admin, chat_id)?);
            Ok(())
        });
    }

    #[test]
    fn membership_visibility_only_filters_group_main_timelines() {
        for show in [true, false] {
            assert!(!hides_membership_messages(show, GroupKind::Dm, None));
            assert!(!hides_membership_messages(show, GroupKind::Dm, Some(1)));
            assert!(!hides_membership_messages(show, GroupKind::Group, Some(1)));
        }
        assert!(!hides_membership_messages(true, GroupKind::Group, None));
        assert!(hides_membership_messages(false, GroupKind::Group, None));
    }

    #[test]
    fn single_chat_visibility_uses_account_defaults_and_one_query() {
        use diesel::{
            connection::{InstrumentationEvent, SimpleConnection},
            prelude::*,
        };
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            return;
        };
        let mut conn = diesel::PgConnection::establish(&url).unwrap();
        conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
            let uid = 987672100;
            let group = 987672200;
            let dm = 987672201;
            conn.batch_execute(
                "INSERT INTO groups(id, name) VALUES (987672200, 'visibility-group');
                INSERT INTO groups(id, name, kind, dm_uid1, dm_uid2)
                    VALUES (987672201, 'visibility-dm', 'dm', 987672100, 987672101);
                INSERT INTO group_membership(chat_id, uid) VALUES (987672200, 987672100), (987672200, 987672101);",
            )?;
            let (settings, kind, _) =
                crate::services::user::load_chat_settings_for_chat(conn, uid, group)?;
            assert!(settings.show_membership_messages);
            assert_eq!(kind, GroupKind::Group);
            let saved = crate::services::user::save_chat_settings(
                conn,
                uid,
                crate::dto::users::UpdateChatSettings {
                    show_membership_messages: false,
                },
            )?;
            let (settings, _, _) =
                crate::services::user::load_chat_settings_for_chat(conn, uid, group)?;
            assert!(!settings.show_membership_messages);
            assert_eq!(settings.show_membership_messages, saved.show_membership_messages);
            let queries = Arc::new(AtomicUsize::new(0));
            let recorded = queries.clone();
            conn.set_instrumentation(move |event: InstrumentationEvent<'_>| {
                if matches!(event, InstrumentationEvent::StartQuery { .. }) {
                    recorded.fetch_add(1, Ordering::Relaxed);
                }
            });
            for (account, chat, hidden) in [
                (uid, group, true),
                (uid, dm, false),
                (uid + 1, group, false),
            ] {
                queries.store(0, Ordering::Relaxed);
                assert_eq!(load_membership_message_filter(conn, account, chat)?, hidden);
                assert_eq!(queries.load(Ordering::Relaxed), 1);
            }
            Ok(())
        });
    }

    fn without_membership_messages() -> diesel::expression::SqlLiteral<diesel::sql_types::Bool> {
        diesel::dsl::sql(NON_MEMBERSHIP_PREDICATE)
    }

    #[test]
    fn membership_filter_skips_long_tails_using_explicit_kinds() {
        use crate::models::Message;
        use crate::schema::messages::dsl as m;
        use diesel::prelude::*;
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = diesel::PgConnection::establish(&url).unwrap();
        conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
            let chat_id = 9_876_650_000_i64;
            diesel::sql_query("INSERT INTO groups (id, name) VALUES ($1, 'membership-filter-test')")
                .bind::<diesel::sql_types::BigInt, _>(chat_id).execute(conn)?;
            // 120 visible messages followed by more than two pages of hidden events.
            diesel::sql_query(
                "INSERT INTO messages (id, chat_id, sender_uid, client_generated_id, message_type, system_kind, message, created_at)
                 SELECT $1 + n, $1, 1717, 'membership-filter-' || n,
                    CASE WHEN n <= 120 THEN 'text'::message_type ELSE 'system'::message_type END,
                    CASE WHEN n <= 120 THEN NULL ELSE 'member_joined'::system_message_kind END,
                    'joined the chat', NOW()
                 FROM generate_series(1, 260) AS n"
            ).bind::<diesel::sql_types::BigInt, _>(chat_id).execute(conn)?;
            #[derive(QueryableByName)]
            struct Plan {
                #[diesel(column_name = "QUERY PLAN", sql_type = diesel::sql_types::Text)]
                text: String,
            }
            let plan = diesel::sql_query(
                "EXPLAIN SELECT id FROM messages WHERE chat_id = $1
                   AND is_published = true AND reply_root_id IS NULL
                   AND (deleted_at IS NULL OR has_thread = true)
                   AND (system_kind IS NULL OR system_kind NOT IN ('member_joined', 'member_left', 'member_added', 'member_removed'))
                 ORDER BY id DESC LIMIT 50"
            ).bind::<diesel::sql_types::BigInt, _>(chat_id).load::<Plan>(conn)?;
            eprintln!("{}", plan.into_iter().map(|line| line.text).collect::<Vec<_>>().join("\n"));
            let visible: Vec<i64> = m::messages.filter(m::chat_id.eq(chat_id))
                .filter(without_membership_messages()).order(m::id.desc()).limit(50)
                .select(m::id).load(conn)?;
            assert_eq!(visible.len(), 50);
            assert_eq!(visible[0], chat_id + 120);
            assert_eq!(visible[49], chat_id + 71);
            let older: Vec<i64> = m::messages.filter(m::chat_id.eq(chat_id))
                .filter(without_membership_messages()).filter(m::id.lt(visible[49]))
                .order(m::id.desc()).limit(50).select(m::id).load(conn)?;
            assert_eq!((older[0], older[49]), (chat_id + 70, chat_id + 21));
            let newer: Vec<i64> = m::messages.filter(m::chat_id.eq(chat_id))
                .filter(without_membership_messages()).filter(m::id.gt(chat_id + 120))
                .select(m::id).load(conn)?;
            assert!(newer.is_empty());

            use crate::models::SystemMessageKind as Kind;
            for (kind, hidden) in [
                (Kind::MemberJoined, true), (Kind::MemberLeft, true),
                (Kind::MemberAdded, true), (Kind::MemberRemoved, true),
                (Kind::MessagePinned, false), (Kind::MessageUnpinned, false),
                (Kind::ThreadMessagePinned, false), (Kind::ThreadMessageUnpinned, false),
                (Kind::FriendRequestAccepted, false), (Kind::Unknown, false),
            ] {
                // Neither a changed body nor a misleading legacy phrase can override the kind.
                for text in ["arbitrary new wording", "joined the chat", "{invalid json}"] {
                    diesel::update(m::messages.find(chat_id + 260))
                        .set((m::system_kind.eq(kind), m::message.eq(text))).execute(conn)?;
                    let row = m::messages.find(chat_id + 260).select(Message::as_select()).first::<Message>(conn)?;
                    assert_eq!(row.system_kind.unwrap().is_membership(), hidden, "{kind:?}: {text}");
                    let visible = m::messages.find(row.id).filter(without_membership_messages())
                        .select(m::id).first::<i64>(conn).optional()?;
                    assert_eq!(visible.is_none(), hidden, "{kind:?}: {text}");
                }
            }
            // An entirely hidden chat has no fallback preview, not a fake empty page cursor.
            diesel::update(m::messages.filter(m::chat_id.eq(chat_id)))
                .set((m::message_type.eq(MessageType::System), m::system_kind.eq(Kind::MemberLeft), m::message.eq("left the chat")))
                .execute(conn)?;
            assert!(m::messages.filter(m::chat_id.eq(chat_id)).filter(without_membership_messages())
                .select(m::id).load::<i64>(conn)?.is_empty());
            Ok(())
        });
    }

    #[test]
    fn system_kind_migration_backfills_legacy_data_and_enforces_message_shape() {
        use diesel::{
            connection::SimpleConnection,
            prelude::*,
            sql_types::{BigInt, Nullable, Text},
        };
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = diesel::PgConnection::establish(&url).unwrap();
        conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
            // Return to the pre-feature schema, then exercise backfill and index creation.
            conn.batch_execute(include_str!("../../migrations/2026-10-24-163403-0000_classify_system_messages/down.sql"))?;
            let chat_id = 9_876_660_000_i64;
            diesel::sql_query("INSERT INTO groups (id, name) VALUES ($1, 'system-kind-migration-test')")
                .bind::<BigInt, _>(chat_id).execute(conn)?;
            let cases = [
                (Some("joined the chat".to_owned()), "member_joined"),
                (Some("left the chat".to_owned()), "member_left"),
                (Some("added 小花".to_owned()), "member_added"),
                (Some(with_user("removed 小花".into(), 42)), "member_removed"),
                (Some(with_user("added 小花\n小雨".into(), 42)), "member_added"),
                (Some(with_message("pinned a message", 99)), "message_pinned"),
                (Some("unpinned a message".into()), "message_unpinned"),
                (Some("pinned a message in this thread".into()), "thread_message_pinned"),
                (Some(with_message("unpinned a message in this thread", 99)), "thread_message_unpinned"),
                (Some(with_user("accepted O'Brien\n小花's friend request".into(), 42)), "friend_request_accepted"),
                (Some("changed the theme".into()), "unknown"),
                (Some("{invalid json}".into()), "unknown"),
                (Some(r#"{"text":"joined the chat","links":null}"#.into()), "unknown"),
                (None, "unknown"),
            ];
            for (index, (body, _)) in cases.iter().enumerate() {
                diesel::sql_query("INSERT INTO messages (id, chat_id, sender_uid, client_generated_id, message_type, message, created_at)
                    VALUES ($1, $2, 1717, $1::text, 'system', $3, NOW())")
                    .bind::<BigInt, _>(chat_id + index as i64).bind::<BigInt, _>(chat_id)
                    .bind::<Nullable<Text>, _>(body).execute(conn)?;
            }
            diesel::sql_query("INSERT INTO messages (id, chat_id, sender_uid, client_generated_id, message_type, message, created_at)
                VALUES ($1, $2, 1717, $1::text, 'text', 'joined the chat', NOW())")
                .bind::<BigInt, _>(chat_id + 100).bind::<BigInt, _>(chat_id).execute(conn)?;
            conn.batch_execute(include_str!("../../migrations/2026-10-24-163403-0000_classify_system_messages/up.sql"))?;
            #[derive(QueryableByName)]
            struct Row {
                #[diesel(sql_type = Nullable<Text>)]
                message: Option<String>,
                #[diesel(sql_type = Nullable<Text>)]
                kind: Option<String>,
            }
            let rows = diesel::sql_query("SELECT message, system_kind::text AS kind FROM messages WHERE chat_id = $1 ORDER BY id")
                .bind::<BigInt, _>(chat_id).load::<Row>(conn)?;
            for (row, (body, kind)) in rows.iter().zip(&cases) {
                assert_eq!(&row.message, body);
                assert_eq!(row.kind.as_deref(), Some(*kind));
            }
            assert_eq!(rows.len(), cases.len() + 1);
            assert!(rows.last().unwrap().kind.is_none());
            for (id, kind) in [(chat_id, "NULL"), (chat_id + 100, "'member_joined'")] {
                let invalid = conn.transaction::<_, diesel::result::Error, _>(|conn| {
                    diesel::sql_query(format!("UPDATE messages SET system_kind = {kind} WHERE id = $1"))
                        .bind::<BigInt, _>(id).execute(conn)
                });
                assert!(matches!(invalid, Err(diesel::result::Error::DatabaseError(diesel::result::DatabaseErrorKind::CheckViolation, _))));
            }
            Ok(())
        });
    }

    #[test]
    fn preserves_user_names_and_stable_destinations() {
        let text = "accepted 小花 <b>O'Brien</b>'s friend request";
        let (decoded, links) = decode(&MessageType::System, Some(with_user(text.into(), 42)));
        assert_eq!(decoded.as_deref(), Some(text));
        assert_eq!(links.unwrap().uid, Some(42));
    }

    #[test]
    fn message_ids_round_trip_without_javascript_precision_loss() {
        let id = 9_007_199_254_740_993;
        let (text, links) = decode(
            &MessageType::System,
            Some(with_message("unpinned a message", id)),
        );
        assert_eq!(text.as_deref(), Some("unpinned a message"));
        let links = links.unwrap();
        assert_eq!(links.message_id, Some(id));
        assert_eq!(
            serde_json::to_value(links).unwrap()["messageId"],
            id.to_string()
        );
    }

    #[test]
    fn preserves_legacy_unknown_and_user_authored_text() {
        for text in ["joined the chat", "changed the theme", "{invalid json}"] {
            assert_eq!(
                decode(&MessageType::System, Some(text.into())),
                (Some(text.into()), None)
            );
        }
        let text = with_user("added Bob".into(), 42);
        assert_eq!(
            decode(&MessageType::Text, Some(text.clone())),
            (Some(text), None)
        );
    }
}
