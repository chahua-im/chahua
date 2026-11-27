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

macro_rules! chat_base_query {
    ($uid:expr, $last_id:expr) => {
        groups::table
            .inner_join(group_membership::table)
            .left_join(
                messages::table.on(messages::id.nullable().eq(diesel::dsl::sql::<
                    diesel::sql_types::Nullable<diesel::sql_types::BigInt>,
                >($last_id))),
            )
            .filter(group_membership::uid.eq($uid))
    };
}

macro_rules! chat_projection {
    ($query:expr) => {
        $query.select((
            groups::id,
            groups::name,
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
    };
}

fn visible_last_message_id(hide_membership_messages: bool) -> String {
    format!(
        "CASE WHEN groups.kind = 'group' AND ({} OR NOT {}) THEN (
           SELECT id FROM messages WHERE chat_id = groups.id
             AND is_published = true AND reply_root_id IS NULL
             AND deleted_at IS NULL AND {}
           ORDER BY id DESC LIMIT 1
         ) ELSE groups.last_message_id END",
        hide_membership_messages,
        super::system_messages::MEMBERSHIP_ALLOWED_PREDICATE,
        super::system_messages::NON_MEMBERSHIP_PREDICATE,
    )
}

pub(crate) fn load_chat_rows_by_ids(
    conn: &mut PgConnection,
    uid: i32,
    chat_ids: &[i64],
    hide_membership_messages: bool,
) -> QueryResult<Vec<ChatListRow>> {
    if chat_ids.is_empty() {
        return Ok(Vec::new());
    }
    let last_id = visible_last_message_id(hide_membership_messages);
    chat_projection!(chat_base_query!(uid, &last_id))
        .filter(groups::id.eq_any(chat_ids))
        .load(conn)
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
    let last_id = visible_last_message_id(hide_membership_messages);
    let mut query = chat_projection!(chat_base_query!(uid, &last_id))
        .filter(group_membership::archived.eq(archived))
        .into_boxed();
    if let Some(id) = chat_id {
        query = query.filter(groups::id.eq(id));
    }
    if let Some(id) = after {
        let cursor = chat_base_query!(uid, &last_id)
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
mod tests;
