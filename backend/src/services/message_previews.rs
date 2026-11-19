use std::collections::{HashMap, HashSet};

use diesel::prelude::*;

use crate::{
    dto::messages::{MessagePreview, MessagePreviewAttachment},
    models::Message,
    schema::{attachments, stickers},
    services::{
        avatars::AvatarService,
        messages::{
            build_message_preview, build_sender, extract_mention_uids, MessagePreviewInput,
        },
        single_forwarding::ForwardOrigins,
        user::lookup_user_profiles,
    },
};

/// Batch the display fields shared by chat-list summaries and captured external quotes.
pub(crate) fn load_message_previews(
    conn: &mut PgConnection,
    messages: Vec<Message>,
    avatars: Option<&AvatarService>,
    key: impl Fn(&Message) -> i64,
) -> HashMap<i64, MessagePreview> {
    if messages.is_empty() {
        return HashMap::new();
    }
    let mut origins = ForwardOrigins::default();
    if let Err(error) = origins.load_attribution(conn, messages.iter()) {
        tracing::error!(?error, "failed to load message preview attribution");
    }
    let mut uids = HashSet::new();
    let mut mention_uids = Vec::with_capacity(messages.len());
    let mut message_ids = Vec::with_capacity(messages.len());
    let mut sticker_ids = HashSet::new();
    for message in &messages {
        uids.insert(message.sender_uid);
        let mentions = if message.deleted_at.is_none() {
            if message.has_attachments {
                message_ids.push(message.id);
            }
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
    let user_avatars = avatars
        .map(|service| service.lookup(&uids.iter().copied().collect::<Vec<_>>()))
        .unwrap_or_default();
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
                tracing::error!(?error, "failed to load message preview attachments");
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
                key(&message),
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
