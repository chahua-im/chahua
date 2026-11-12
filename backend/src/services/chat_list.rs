use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use diesel::prelude::*;

use crate::{
    dto::messages::{MessagePreview, MessagePreviewAttachment},
    models::{GroupKind, Message},
    schema::{attachments, group_membership, groups, media, messages, stickers},
    services::{
        avatars::AvatarService,
        messages::{
            build_message_preview, build_sender, extract_mention_uids, MessagePreviewInput,
        },
        notification_preferences::ChatNotificationSetting,
        single_forwarding::ForwardOrigins,
        user::lookup_user_profiles,
    },
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
        .filter(group_membership::archived.eq(archived))
        .select((
            groups::id,
            groups::name,
            // Resolve avatar keys after pagination, not by joining media across
            // every membership when a sparse-message page is underestimated.
            media::table
                .select(media::storage_key)
                .filter(media::id.nullable().eq(groups::avatar_image_id))
                .filter(media::deleted_at.is_null())
                .single_value(),
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

/// Hydrate one last-message preview per chat, without conversation-only metadata.
pub(crate) fn load_last_message_previews(
    conn: &mut PgConnection,
    messages: Vec<Message>,
    avatars: &AvatarService,
) -> HashMap<i64, MessagePreview> {
    if messages.is_empty() {
        return HashMap::new();
    }
    let origins = ForwardOrigins::load_attribution(conn, messages.iter()).unwrap_or_else(|error| {
        tracing::error!(?error, "failed to load chat preview attribution");
        Default::default()
    });
    let mut uids = HashSet::new();
    let mut mention_uids = Vec::with_capacity(messages.len());
    let mut message_ids = Vec::with_capacity(messages.len());
    let mut sticker_ids = HashSet::new();
    for message in &messages {
        uids.insert(message.sender_uid);
        let mentions = if message.deleted_at.is_none() {
            message_ids.push(message.id);
            sticker_ids.extend(message.sticker_id);
            message
                .message
                .as_deref()
                .map(extract_mention_uids)
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        uids.extend(&mentions);
        mention_uids.push(mentions);
    }
    let user_avatars = avatars.lookup(&uids.iter().copied().collect::<Vec<_>>());
    // Attribution displays only the origin's name, not its avatar or reply context.
    origins.collect_uids(&mut uids);
    let profiles =
        lookup_user_profiles(conn, &uids.into_iter().collect::<Vec<_>>()).unwrap_or_default();
    let sticker_emojis = if sticker_ids.is_empty() {
        HashMap::new()
    } else {
        stickers::table
            .filter(stickers::id.eq_any(&sticker_ids))
            .select((stickers::id, stickers::emoji))
            .load::<(i64, String)>(conn)
            .unwrap_or_default()
            .into_iter()
            .collect()
    };
    let mut attachment_previews: HashMap<i64, Vec<MessagePreviewAttachment>> = HashMap::new();
    if !message_ids.is_empty() {
        let rows = attachments::table
            .filter(attachments::message_id.eq_any(&message_ids))
            .filter(attachments::deleted_at.is_null())
            .order((
                attachments::message_id.asc(),
                attachments::order.asc(),
                attachments::id.asc(),
            ))
            .select((attachments::message_id, attachments::kind))
            .load::<(Option<i64>, String)>(conn)
            .unwrap_or_else(|error| {
                tracing::error!(?error, "failed to load chat preview attachments");
                Vec::new()
            });
        for (message_id, kind) in rows {
            if let Some(message_id) = message_id {
                attachment_previews
                    .entry(message_id)
                    .or_default()
                    .push(MessagePreviewAttachment { kind });
            }
        }
    }
    messages
        .into_iter()
        .zip(mention_uids)
        .map(|(message, mentions)| {
            let forwarded_from_name = origins.name_for(&message, &profiles);
            (
                message.chat_id,
                build_message_preview(
                    MessagePreviewInput {
                        metadata: message
                            .metadata
                            .as_ref()
                            .and_then(super::link_previews::preview_metadata),
                        system_kind: message.system_kind,
                        forwarded_from_name,
                        id: message.id,
                        client_generated_id: message.client_generated_id,
                        created_at: message.created_at,
                        sender: build_sender(message.sender_uid, &user_avatars, &profiles),
                        message: message.message,
                        message_type: message.message_type,
                        sticker_id: message.sticker_id,
                        attachments: attachment_previews.remove(&message.id).unwrap_or_default(),
                        deleted_at: message.deleted_at,
                        mention_source: None,
                        mention_uids: Some(mentions),
                    },
                    &sticker_emojis,
                    &user_avatars,
                    &profiles,
                ),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::connection::SimpleConnection;

    #[test]
    fn last_message_previews_preserve_display_data_and_redact_deleted_content() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.test_transaction::<_, diesel::result::Error, _>(|conn| {
            conn.batch_execute(
                "CREATE TEMP TABLE messages (LIKE public.messages INCLUDING ALL);
                 CREATE TEMP TABLE attachments (LIKE public.attachments INCLUDING ALL);
                 CREATE TEMP TABLE stickers (LIKE public.stickers INCLUDING ALL);
                 INSERT INTO discuz.common_member(uid, username, loginname) VALUES
                   (987665900, 'preview-sender', 'preview-sender'),
                   (987665901, 'preview-mention', 'preview-mention'),
                   (987665902, 'preview-origin', 'preview-origin');
                 INSERT INTO stickers(id, media_id, emoji) VALUES (77, 88, '🙂');
                 INSERT INTO messages(id, chat_id, sender_uid, message_type, system_kind, message,
                                      client_generated_id, created_at) VALUES
                   (1, 99, 987665902, 'text', NULL, 'origin @[uid:987665902]', 'preview-origin', NOW()),
                   (10, 10, 987665900, 'text', NULL, 'hello @[uid:987665901] @[uid:987665901]', 'preview-text', NOW()),
                   (11, 11, 987665900, 'sticker', NULL, NULL, 'preview-sticker', NOW()),
                   (12, 12, 987665900, 'text', NULL, 'forwarded text', 'preview-forward', NOW()),
                   (13, 13, 987665900, 'system', 'member_joined', '{\"text\":\"member joined\",\"links\":{\"uid\":987665901}}', 'preview-system', NOW()),
                   (14, 14, 987665900, 'text', NULL, 'secret @[uid:987665902]', 'preview-deleted', NOW());
                 UPDATE messages SET forwarded_from_message_id = 1 WHERE id IN (11, 12, 14);
                 UPDATE messages SET sticker_id = 77 WHERE id IN (11, 14);
                 UPDATE messages SET deleted_at = NOW() WHERE id = 14;
                 INSERT INTO attachments(id, message_id, kind, external_reference, size,
                                         created_at, \"order\", deleted_at) VALUES
                   (100, 10, 'image/png', 'second', 1, NOW(), 1, NULL),
                   (101, 10, 'image/jpeg', 'first', 1, NOW(), 0, NULL),
                   (102, 10, 'image/gif', 'removed', 1, NOW(), 0, NOW()),
                   (103, 14, 'application/pdf', 'secret', 1, NOW(), 0, NULL);",
            )?;
            let messages = messages::table
                .filter(messages::id.between(10, 14))
                .select(Message::as_select())
                .load(conn)?;
            let avatars = AvatarService::new(
                None,
                std::sync::Arc::new(super::super::avatars::AvatarMetrics::new(
                    &prometheus::Registry::new(),
                )),
            );
            let previews = load_last_message_previews(conn, messages, &avatars);
            let text = &previews[&10];
            assert_eq!(text.sender.name.as_deref(), Some("preview-sender"));
            assert_eq!(text.message.as_deref(), Some("hello @[uid:987665901] @[uid:987665901]"));
            assert_eq!(text.mentions.iter().map(|mention| (mention.uid, mention.username.as_deref())).collect::<Vec<_>>(),
                       [(987665901, Some("preview-mention"))]);
            assert_eq!(text.attachments.iter().map(|attachment| attachment.kind.as_str()).collect::<Vec<_>>(),
                       ["image/jpeg", "image/png"]);
            let sticker = &previews[&11];
            assert_eq!(sticker.sticker.as_ref().unwrap().emoji, "🙂");
            assert!(sticker.forwarded_from_name.is_none());
            let forwarded = &previews[&12];
            assert_eq!(forwarded.forwarded_from_name.as_deref(), Some("preview-origin"));
            assert!(forwarded.mentions.is_empty());
            let system = &previews[&13];
            assert_eq!(system.message.as_deref(), Some("member joined"));
            assert_eq!(system.system_links.as_ref().unwrap().uid, Some(987665901));
            let deleted = &previews[&14];
            assert!(deleted.is_deleted);
            assert_eq!(deleted.sender.name.as_deref(), Some("preview-sender"));
            assert!(deleted.message.is_none());
            assert!(deleted.sticker.is_none());
            assert!(deleted.attachments.is_empty());
            assert!(deleted.mentions.is_empty());
            assert!(deleted.forwarded_from_name.is_none());
            assert!(deleted.system_links.is_none());
            Ok(())
        });
    }

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
                INSERT INTO media(id, content_type, storage_key, size, created_at, purpose, deleted_at) VALUES
                  (987665401, 'image/png', 'avatars/live.png', 1, NOW(), 'avatar', NULL),
                  (987665402, 'image/png', 'avatars/deleted.png', 1, NOW(), 'avatar', NOW());
                UPDATE groups SET avatar_image_id = 987665401 WHERE id = 987665201;
                UPDATE groups SET avatar_image_id = 987665402 WHERE id = 987665204;
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
            assert_eq!(second[0].avatar_key.as_deref(), Some("avatars/live.png"));
            assert!(second[1].avatar_key.is_none());
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
