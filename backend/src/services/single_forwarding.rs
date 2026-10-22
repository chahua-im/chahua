//! Single-message forwarding keeps message content, shared bundles and a flattened origin.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use diesel::prelude::*;

use crate::{
    dto::messages::{ForwardMessageBody, ForwardedFromInfo},
    errors::AppError,
    models::{Attachment, Message, MessageType, NewAttachment},
    schema::{attachments, messages},
    services::{
        forwarding::{
            acquire_forward_retry_lock, check_source_membership, validate_forwardable_source,
        },
        messages::{
            attachment_previews, build_message_preview, build_sender, extract_mention_uids,
            MessagePreviewInput, PreparedMessageSend,
        },
        user::UserProfile,
    },
    utils::ids::{self, IdGen},
};

pub(crate) enum PreparedSingleForward {
    Existing(Box<Message>),
    New(Box<PreparedMessageSend>),
}

fn validate_retry(
    existing: &Message,
    uid: i32,
    destination_chat_id: i64,
    thread_id: Option<i64>,
    origin_id: i64,
    bundle_id: Option<i64>,
) -> Result<(), AppError> {
    if existing.sender_uid == uid
        && existing.chat_id == destination_chat_id
        && existing.reply_root_id == thread_id
        && existing.forwarded_from_message_id == Some(origin_id)
        && existing.forwarded_bundle_id == bundle_id
    {
        return Ok(());
    }
    Err(AppError::Conflict(
        "clientGeneratedId already exists with different payload",
    ))
}

/// Must run inside the caller's send transaction, after destination authorization.
/// Retries intentionally still require access to the selected source. Different
/// copies of the same flattened origin are equivalent for this API.
pub(crate) async fn prepare_single_forward(
    conn: &mut PgConnection,
    id_gen: &IdGen,
    uid: i32,
    destination_chat_id: i64,
    source_message_id: i64,
    body: &ForwardMessageBody,
) -> Result<PreparedSingleForward, AppError> {
    acquire_forward_retry_lock(conn, &body.client_generated_id)?;
    check_source_membership(conn, body.source_chat_id, uid)?;
    // Edits lock the message before replacing its attachments. Hold the same
    // lock through copying so both reads see one version of the source.
    let source = messages::table
        .filter(messages::id.eq(source_message_id))
        .filter(messages::chat_id.eq(body.source_chat_id))
        .filter(messages::deleted_at.is_null())
        .filter(messages::is_published.eq(true))
        .for_update()
        .select(Message::as_select())
        .first::<Message>(conn)
        .optional()?
        .ok_or(AppError::NotFound("Message not found"))?;
    validate_forwardable_source(&source.message_type, source.transcode_status)?;
    let origin_id = source.forwarded_from_message_id.unwrap_or(source.id);
    if let Some(existing) = messages::table
        .filter(messages::client_generated_id.eq(&body.client_generated_id))
        .for_update()
        .select(Message::as_select())
        .first::<Message>(conn)
        .optional()?
    {
        validate_retry(
            &existing,
            uid,
            destination_chat_id,
            body.thread_id,
            origin_id,
            source.forwarded_bundle_id,
        )?;
        return Ok(PreparedSingleForward::Existing(Box::new(existing)));
    }

    let source_attachments = attachments::table
        .filter(attachments::message_id.eq(source.id))
        .filter(attachments::deleted_at.is_null())
        .order((attachments::order.asc(), attachments::id.asc()))
        .select(Attachment::as_select())
        .load::<Attachment>(conn)?;
    let mut cloned = Vec::with_capacity(source_attachments.len());
    for attachment in source_attachments {
        let id = ids::next_id(id_gen).await.map_err(|error| {
            tracing::error!(?error, "failed to allocate forwarded attachment ID");
            AppError::Internal("ID generation failed")
        })?;
        cloned.push(NewAttachment {
            id,
            message_id: None,
            uploader_uid: Some(uid),
            file_name: attachment.file_name,
            kind: attachment.kind,
            external_reference: attachment.external_reference,
            size: attachment.size,
            created_at: Utc::now(),
            deleted_at: None,
            width: attachment.width,
            height: attachment.height,
            order: attachment.order,
        });
    }
    let attachment_ids = cloned.iter().map(|attachment| attachment.id).collect();
    if !cloned.is_empty() {
        diesel::insert_into(attachments::table)
            .values(&cloned)
            .execute(conn)?;
    }
    Ok(PreparedSingleForward::New(Box::new(PreparedMessageSend {
        chat_id: destination_chat_id,
        sender_uid: uid,
        message: source.message,
        message_type: source.message_type,
        sticker_id: source.sticker_id,
        reply_to_id: None,
        reply_root_id: body.thread_id,
        client_generated_id: body.client_generated_id.clone(),
        attachment_ids,
        publish_immediately: true,
        forwarded_from_message_id: Some(origin_id),
        // Bundles are immutable. Reuse the selected bundle without adding a nesting level;
        // the normal message hydrator loads its compact preview for the send response.
        forwarded_bundle_id: source.forwarded_bundle_id,
        forwarded_preview_total: None,
        forwarded_preview_contains_forwarded_messages: None,
        forwarded_preview_items: None,
    })))
}

/// Loaded once for a page, including origins used by ordinary reply previews and
/// by the original reply context inside a forwarded message.
#[derive(Default)]
pub(crate) struct ForwardOrigins {
    originals: HashMap<i64, Message>,
    replies: HashMap<i64, Message>,
}

fn load_messages(
    conn: &mut PgConnection,
    ids: &HashSet<i64>,
) -> QueryResult<HashMap<i64, Message>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    messages::table
        .filter(messages::id.eq_any(ids))
        .select(Message::as_select())
        .load::<Message>(conn)
        .map(|rows| rows.into_iter().map(|row| (row.id, row)).collect())
}

impl ForwardOrigins {
    /// Lightweight previews only need attribution, without original replies.
    pub(crate) fn load_attribution<'a>(
        conn: &mut PgConnection,
        sources: impl Iterator<Item = &'a Message>,
    ) -> QueryResult<Self> {
        let ids = sources
            .filter(|message| message.deleted_at.is_none())
            .filter_map(|message| message.forwarded_from_message_id)
            .collect();
        Ok(Self {
            originals: load_messages(conn, &ids)?,
            replies: HashMap::new(),
        })
    }

    pub(crate) fn load<'a>(
        conn: &mut PgConnection,
        sources: impl Iterator<Item = &'a Message>,
    ) -> QueryResult<Self> {
        let mut origins = Self::load_attribution(conn, sources)?;
        let reply_ids = origins
            .originals
            .values()
            .filter_map(|message| message.reply_to_id)
            .collect();
        let mut replies = load_messages(conn, &reply_ids)?;
        replies.retain(|_, message| message.is_published);
        let nested_origin_ids = replies
            .values()
            .filter_map(|message| message.forwarded_from_message_id)
            .filter(|id| !origins.originals.contains_key(id))
            .collect();
        origins
            .originals
            .extend(load_messages(conn, &nested_origin_ids)?);
        origins.replies = replies;
        Ok(origins)
    }

    pub(crate) fn replies(&self) -> impl Iterator<Item = &Message> {
        self.replies.values()
    }

    pub(crate) fn collect_uids(&self, uids: &mut HashSet<i32>) {
        for message in self.originals.values().chain(self.replies.values()) {
            uids.insert(message.sender_uid);
        }
        for reply in self
            .replies
            .values()
            .filter(|reply| reply.deleted_at.is_none())
        {
            if let Some(text) = &reply.message {
                uids.extend(extract_mention_uids(text));
            }
        }
    }

    pub(crate) fn name_for(
        &self,
        message: &Message,
        profiles: &HashMap<i32, UserProfile>,
    ) -> Option<String> {
        if message.deleted_at.is_some() || message.message_type == MessageType::Sticker {
            return None;
        }
        let original = self.originals.get(&message.forwarded_from_message_id?)?;
        profiles.get(&original.sender_uid)?.username.clone()
    }

    pub(crate) fn info_for(
        &self,
        message: &Message,
        avatars: &HashMap<i32, Option<String>>,
        profiles: &HashMap<i32, UserProfile>,
        sticker_emojis: &HashMap<i64, String>,
        attachments: &HashMap<i64, Vec<Attachment>>,
    ) -> Option<ForwardedFromInfo> {
        if message.deleted_at.is_some() || message.message_type == MessageType::Sticker {
            return None;
        }
        let original = self.originals.get(&message.forwarded_from_message_id?)?;
        let original_reply_to = original
            .reply_to_id
            .and_then(|id| self.replies.get(&id))
            .map(|reply| {
                Box::new(build_message_preview(
                    MessagePreviewInput {
                        forwarded_from_name: self.name_for(reply, profiles),
                        id: reply.id,
                        client_generated_id: reply.client_generated_id.clone(),
                        created_at: reply.created_at,
                        sender: build_sender(reply.sender_uid, avatars, profiles),
                        message: reply.message.clone(),
                        message_type: reply.message_type.clone(),
                        sticker_id: reply.sticker_id,
                        attachments: attachment_previews(attachments, reply.id),
                        deleted_at: reply.deleted_at,
                        mention_source: reply.message.clone(),
                        mention_uids: None,
                    },
                    sticker_emojis,
                    avatars,
                    profiles,
                ))
            });
        Some(ForwardedFromInfo {
            sender: build_sender(original.sender_uid, avatars, profiles),
            original_chat_id: original.chat_id,
            original_message_id: original.id,
            original_reply_to,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TranscodeStatus;

    fn test_id_gen() -> &'static IdGen {
        static GENERATOR: std::sync::OnceLock<IdGen> = std::sync::OnceLock::new();
        GENERATOR.get_or_init(ids::new_generator)
    }

    fn message(id: i64) -> Message {
        Message {
            id,
            message: Some("hello @[uid:9]".into()),
            message_type: MessageType::Text,
            reply_to_id: None,
            reply_root_id: None,
            client_generated_id: format!("single-forward-{id}"),
            sender_uid: 7,
            chat_id: 42,
            created_at: Utc::now(),
            updated_at: None,
            deleted_at: None,
            has_attachments: false,
            has_thread: false,
            has_reactions: false,
            sticker_id: None,
            is_published: true,
            transcode_status: TranscodeStatus::None,
            forwarded_bundle_id: None,
            forwarded_from_message_id: None,
        }
    }

    #[test]
    fn retry_matches_origin_and_destination_without_comparing_mutable_content() {
        let mut existing = message(100);
        existing.forwarded_from_message_id = Some(1);
        existing.reply_root_id = Some(80);
        existing.message = Some("copied before source edit".into());
        assert!(validate_retry(&existing, 7, 42, Some(80), 1, None).is_ok());
        for (uid, chat, thread, origin) in [
            (8, 42, Some(80), 1),
            (7, 43, Some(80), 1),
            (7, 42, None, 1),
            (7, 42, Some(81), 1),
            (7, 42, Some(80), 2),
        ] {
            assert!(matches!(
                validate_retry(&existing, uid, chat, thread, origin, None),
                Err(AppError::Conflict(_))
            ));
        }
        existing.forwarded_from_message_id = None;
        assert!(validate_retry(&existing, 7, 42, Some(80), 1, None).is_err());
    }

    #[test]
    fn bundle_retry_requires_the_same_origin_bundle_and_destination() {
        let mut existing = message(100);
        existing.message_type = MessageType::Forwarded;
        existing.forwarded_from_message_id = Some(1);
        existing.forwarded_bundle_id = Some(90);
        existing.reply_root_id = Some(80);
        assert!(validate_retry(&existing, 7, 42, Some(80), 1, Some(90)).is_ok());
        for (uid, chat, thread, origin, bundle) in [
            (8, 42, Some(80), 1, Some(90)),
            (7, 43, Some(80), 1, Some(90)),
            (7, 42, None, 1, Some(90)),
            (7, 42, Some(80), 2, Some(90)),
            (7, 42, Some(80), 1, Some(91)),
            (7, 42, Some(80), 1, None),
        ] {
            assert!(matches!(
                validate_retry(&existing, uid, chat, thread, origin, bundle),
                Err(AppError::Conflict(_))
            ));
        }
        // A merged send using the same bundle is a different operation.
        existing.forwarded_from_message_id = None;
        assert!(validate_retry(&existing, 7, 42, Some(80), 1, Some(90)).is_err());
    }

    #[test]
    fn attribution_preserves_root_author_and_complete_nested_reply_preview() {
        let mut original = message(1);
        original.sender_uid = 8;
        original.reply_to_id = Some(2);
        let mut reply = message(2);
        reply.forwarded_from_message_id = Some(3);
        let mut reply_origin = message(3);
        reply_origin.sender_uid = 9;
        let mut forwarded = message(100);
        forwarded.forwarded_from_message_id = Some(1);
        let mut origins = ForwardOrigins {
            originals: HashMap::from([(1, original), (3, reply_origin)]),
            replies: HashMap::from([(2, reply)]),
        };
        let profiles = [7, 8, 9]
            .into_iter()
            .map(|uid| {
                (
                    uid,
                    UserProfile {
                        username: Some(format!("user-{uid}")),
                        gender: 0,
                        user_group: None,
                    },
                )
            })
            .collect();
        let avatars = HashMap::new();
        let emojis = HashMap::from([(50, "🙂".into())]);
        let attachments = HashMap::from([(
            2,
            vec![Attachment {
                id: 20,
                message_id: Some(2),
                uploader_uid: Some(7),
                file_name: "image.png".into(),
                kind: "image/png".into(),
                external_reference: "image".into(),
                size: 10,
                created_at: Utc::now(),
                deleted_at: None,
                width: Some(10),
                height: Some(10),
                order: 0,
            }],
        )]);
        let info = origins
            .info_for(&forwarded, &avatars, &profiles, &emojis, &attachments)
            .unwrap();
        assert_eq!(info.sender.uid, 8);
        assert_eq!(info.original_message_id, 1);
        let preview = info.original_reply_to.unwrap();
        assert_eq!(preview.forwarded_from_name.as_deref(), Some("user-9"));
        assert_eq!(preview.attachments[0].kind, "image/png");
        assert_eq!(preview.mentions[0].username.as_deref(), Some("user-9"));

        let reply = origins.replies.get_mut(&2).unwrap();
        reply.message_type = MessageType::Sticker;
        reply.sticker_id = Some(50);
        let info = origins
            .info_for(&forwarded, &avatars, &profiles, &emojis, &attachments)
            .unwrap();
        let preview = info.original_reply_to.unwrap();
        assert_eq!(
            preview
                .sticker
                .as_ref()
                .map(|sticker| sticker.emoji.as_str()),
            Some("🙂")
        );
        assert!(preview.forwarded_from_name.is_none());

        origins.replies.get_mut(&2).unwrap().deleted_at = Some(Utc::now());
        let info = origins
            .info_for(&forwarded, &avatars, &profiles, &emojis, &attachments)
            .unwrap();
        let preview = info.original_reply_to.unwrap();
        assert!(preview.is_deleted);
        assert!(preview.message.is_none());
        assert!(preview.attachments.is_empty());
        assert!(preview.mentions.is_empty());
        assert!(preview.sticker.is_none());

        // Removing the original content does not remove attribution on copies.
        origins.originals.get_mut(&1).unwrap().deleted_at = Some(Utc::now());
        assert!(origins
            .info_for(&forwarded, &avatars, &profiles, &emojis, &attachments)
            .is_some());
        forwarded.message_type = MessageType::Sticker;
        assert!(origins
            .info_for(&forwarded, &avatars, &profiles, &emojis, &attachments)
            .is_none());
        forwarded.message_type = MessageType::Text;
        forwarded.deleted_at = Some(Utc::now());
        assert!(origins
            .info_for(&forwarded, &avatars, &profiles, &emojis, &attachments)
            .is_none());
    }

    #[test]
    fn request_accepts_string_ids_and_optional_thread() {
        let mut json = serde_json::json!({"sourceChatId": "42", "clientGeneratedId": "retry"});
        let body: ForwardMessageBody = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(body.source_chat_id, 42);
        assert_eq!(body.thread_id, None);
        json["threadId"] = "80".into();
        let body: ForwardMessageBody = serde_json::from_value(json).unwrap();
        assert_eq!(body.thread_id, Some(80));
    }

    /// Run against a migrated disposable database. Dropping the connection
    /// rolls back the fixture, including when an assertion fails.
    #[tokio::test]
    async fn database_attachment_copy_and_retry_require_live_source_access() {
        use diesel::connection::SimpleConnection;
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).expect("connect to test database");
        conn.batch_execute(
            "BEGIN;
             INSERT INTO groups(id, name) VALUES (-76000, 'single-forward-test');
             INSERT INTO group_membership(chat_id, uid) VALUES (-76000, 76000);
             INSERT INTO messages(id, chat_id, sender_uid, message_type, message,
                                  client_generated_id, created_at, has_attachments)
             VALUES (-76001, -76000, 76001, 'file', NULL, 'single-forward-source-test', NOW(), true);
             INSERT INTO attachments(id, message_id, kind, external_reference, size,
                                     created_at, file_name, \"order\", deleted_at)
             VALUES (-76002, -76001, 'application/pdf', 'last', 2, NOW(), 'last.pdf', 2, NULL),
                    (-76003, -76001, 'application/pdf', 'first', 1, NOW(), 'first.pdf', 0, NULL),
                    (-76004, -76001, 'application/pdf', 'deleted', 3, NOW(), 'deleted.pdf', 1, NOW());",
        ).unwrap();
        let id_gen = test_id_gen();
        let body = ForwardMessageBody {
            source_chat_id: -76000,
            client_generated_id: "single-forward-retry-test".into(),
            thread_id: None,
        };
        let PreparedSingleForward::New(prepared) =
            prepare_single_forward(&mut conn, id_gen, 76000, -76000, -76001, &body)
                .await
                .unwrap()
        else {
            panic!("first attempt must prepare a new copy")
        };
        assert_eq!(prepared.attachment_ids.len(), 2);
        let copies = attachments::table
            .filter(attachments::id.eq_any(&prepared.attachment_ids))
            .order(attachments::order.asc())
            .select(Attachment::as_select())
            .load::<Attachment>(&mut conn)
            .unwrap();
        assert_eq!(
            copies
                .iter()
                .map(|a| a.external_reference.as_str())
                .collect::<Vec<_>>(),
            ["first", "last"]
        );
        assert_eq!(
            copies.iter().map(|a| a.id).collect::<Vec<_>>(),
            prepared.attachment_ids
        );
        assert!(copies
            .iter()
            .all(|a| a.uploader_uid == Some(76000) && a.message_id.is_none()));

        // Simulate the committed send, then retry: no attachment copies added.
        conn.batch_execute(
            "INSERT INTO messages(id, chat_id, sender_uid, message_type, client_generated_id,
                                  created_at, forwarded_from_message_id)
             VALUES (-76005, -76000, 76000, 'file', 'single-forward-retry-test', NOW(), -76001);",
        )
        .unwrap();
        let before = attachments::table
            .filter(attachments::uploader_uid.eq(Some(76000)))
            .count()
            .get_result::<i64>(&mut conn)
            .unwrap();
        let PreparedSingleForward::Existing(existing) =
            prepare_single_forward(&mut conn, id_gen, 76000, -76000, -76001, &body)
                .await
                .unwrap()
        else {
            panic!("retry must reuse the existing message")
        };
        assert_eq!(existing.id, -76005);
        assert_eq!(
            attachments::table
                .filter(attachments::uploader_uid.eq(Some(76000)))
                .count()
                .get_result::<i64>(&mut conn)
                .unwrap(),
            before
        );
        conn.batch_execute("UPDATE messages SET deleted_at=NOW() WHERE id=-76001;")
            .unwrap();
        assert!(matches!(
            prepare_single_forward(&mut conn, id_gen, 76000, -76000, -76001, &body,).await,
            Err(AppError::NotFound(_))
        ));
        conn.batch_execute(
            "UPDATE messages SET deleted_at=NULL WHERE id=-76001;
                            DELETE FROM group_membership WHERE chat_id=-76000;",
        )
        .unwrap();
        assert!(matches!(
            prepare_single_forward(&mut conn, id_gen, 76000, -76000, -76001, &body,).await,
            Err(AppError::Forbidden(_))
        ));
        conn.batch_execute("ROLLBACK").unwrap();
    }

    #[tokio::test]
    async fn database_single_forward_reuses_flat_and_nested_bundles() {
        use crate::{
            dto::messages::ForwardMessagesBody,
            schema::forwarded_bundles,
            services::{
                forwarding::prepare_forward_message,
                messages::{load_chat_forwarded_bundle_id, load_target_forwarded_bundle_from_root},
            },
        };
        use diesel::connection::SimpleConnection;

        fn persist(conn: &mut PgConnection, id: i64, prepared: &PreparedMessageSend) {
            diesel::insert_into(messages::table)
                .values((
                    messages::id.eq(id),
                    messages::chat_id.eq(prepared.chat_id),
                    messages::sender_uid.eq(prepared.sender_uid),
                    messages::message.eq(&prepared.message),
                    messages::message_type.eq(&prepared.message_type),
                    messages::client_generated_id.eq(&prepared.client_generated_id),
                    messages::created_at.eq(Utc::now()),
                    messages::reply_root_id.eq(prepared.reply_root_id),
                    messages::forwarded_bundle_id.eq(prepared.forwarded_bundle_id),
                    messages::forwarded_from_message_id.eq(prepared.forwarded_from_message_id),
                ))
                .execute(conn)
                .unwrap();
        }

        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).expect("connect to test database");
        conn.batch_execute(
            "BEGIN;
             INSERT INTO groups(id, name) VALUES (-76200, 'bundle-source'), (-76210, 'bundle-destination');
             INSERT INTO group_membership(chat_id, uid) VALUES (-76200, 76200), (-76210, 76200);
             INSERT INTO messages(id, chat_id, sender_uid, message_type, message, client_generated_id, created_at)
             VALUES (-76201, -76200, 76201, 'text', 'first', 'bundle-first', NOW()),
                    (-76202, -76200, 76201, 'text', 'second', 'bundle-second', NOW()),
                    (-76211, -76210, 76200, 'text', 'thread root', 'bundle-thread', NOW());",
        ).unwrap();
        let id_gen = test_id_gen();
        let mut flat_bundle_id = None;
        for (source_id, selection) in [
            (-76203, vec![-76201, -76202]),
            (-76204, vec![-76203, -76201]),
        ] {
            let merged = prepare_forward_message(
                &mut conn,
                id_gen,
                76200,
                -76200,
                &ForwardMessagesBody {
                    source_chat_id: -76200,
                    message_ids: selection,
                    client_generated_id: format!("bundle-merged-{source_id}"),
                    thread_id: None,
                },
            )
            .await
            .unwrap();
            persist(&mut conn, source_id, &merged);
            let bundle_id = merged.forwarded_bundle_id.unwrap();
            let count_before = forwarded_bundles::table
                .count()
                .get_result::<i64>(&mut conn)
                .unwrap();
            let body = ForwardMessageBody {
                source_chat_id: -76200,
                client_generated_id: format!("bundle-single-{source_id}"),
                thread_id: Some(-76211),
            };
            let PreparedSingleForward::New(prepared) =
                prepare_single_forward(&mut conn, id_gen, 76200, -76210, source_id, &body)
                    .await
                    .unwrap()
            else {
                panic!("expected a new bundle copy")
            };
            assert_eq!(prepared.message_type, MessageType::Forwarded);
            assert_eq!(prepared.message, merged.message);
            assert_eq!(prepared.forwarded_bundle_id, Some(bundle_id));
            assert_eq!(prepared.forwarded_from_message_id, Some(source_id));
            assert_eq!(prepared.reply_root_id, Some(-76211));
            assert!(prepared.attachment_ids.is_empty());
            let copy_id = source_id - 10;
            persist(&mut conn, copy_id, &prepared);
            let PreparedSingleForward::Existing(existing) =
                prepare_single_forward(&mut conn, id_gen, 76200, -76210, source_id, &body)
                    .await
                    .unwrap()
            else {
                panic!("retry must reuse the existing copy")
            };
            assert_eq!(existing.id, copy_id);

            // Deleting the source wrapper leaves the destination's bundle and
            // its child details accessible through destination membership.
            diesel::update(messages::table.find(source_id))
                .set(messages::deleted_at.eq(Utc::now()))
                .execute(&mut conn)
                .unwrap();
            let root = load_chat_forwarded_bundle_id(&mut conn, -76210, copy_id, 76200).unwrap();
            assert_eq!(root, bundle_id);
            let bundle = load_target_forwarded_bundle_from_root(&mut conn, root, root).unwrap();
            assert_eq!(bundle.item_count, 2);
            assert_eq!(bundle.preview.as_array().unwrap().len(), 2);
            if let Some(child) = flat_bundle_id {
                assert_eq!(bundle.child_bundle_ids, vec![child]);
                assert_eq!(
                    load_target_forwarded_bundle_from_root(&mut conn, root, child)
                        .unwrap()
                        .id,
                    child
                );
            } else {
                assert!(bundle.child_bundle_ids.is_empty());
                flat_bundle_id = Some(root);
            }
            assert!(load_chat_forwarded_bundle_id(&mut conn, -76210, copy_id, 76201).is_err());
            assert!(matches!(
                prepare_single_forward(&mut conn, id_gen, 76200, -76210, source_id, &body).await,
                Err(AppError::NotFound(_))
            ));

            // Re-forwarding a copy retains the root origin even after deletion,
            // and must not add a bundle or increase the nesting depth.
            let PreparedSingleForward::New(repeated) = prepare_single_forward(
                &mut conn,
                id_gen,
                76200,
                -76210,
                copy_id,
                &ForwardMessageBody {
                    source_chat_id: -76210,
                    client_generated_id: format!("bundle-repeat-{source_id}"),
                    thread_id: None,
                },
            )
            .await
            .unwrap() else {
                panic!("expected a repeated bundle copy")
            };
            assert_eq!(repeated.forwarded_bundle_id, Some(bundle_id));
            assert_eq!(repeated.forwarded_from_message_id, Some(source_id));
            assert_eq!(
                forwarded_bundles::table
                    .count()
                    .get_result::<i64>(&mut conn)
                    .unwrap(),
                count_before
            );
            // Restore the flat wrapper so the next iteration can select it.
            diesel::update(messages::table.find(source_id))
                .set(messages::deleted_at.eq(None::<chrono::DateTime<Utc>>))
                .execute(&mut conn)
                .unwrap();
        }
        conn.batch_execute("ROLLBACK").unwrap();
    }

    #[tokio::test]
    async fn database_forward_holds_source_lock_until_copy_transaction_ends() {
        use diesel::connection::SimpleConnection;
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        // Two connections need committed fixtures. Drop this after both
        // connections, so failed assertions release locks before cleanup.
        struct Fixture(String);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let mut conn = PgConnection::establish(&self.0).unwrap();
                conn.batch_execute(
                    "BEGIN;
                     DELETE FROM attachments WHERE id IN (-76102, -76103);
                     DELETE FROM messages WHERE chat_id = -76100;
                     DELETE FROM group_membership WHERE chat_id = -76100;
                     DELETE FROM groups WHERE id = -76100;
                     COMMIT;",
                )
                .unwrap();
            }
        }
        let _fixture = Fixture(url.clone());
        let mut conn = PgConnection::establish(&url).unwrap();
        let mut editor = PgConnection::establish(&url).unwrap();
        conn.batch_execute(
            "BEGIN;
             INSERT INTO groups(id, name) VALUES (-76100, 'forward-lock-test');
             INSERT INTO group_membership(chat_id, uid) VALUES (-76100, 76100);
             INSERT INTO messages(id, chat_id, sender_uid, message_type, message,
                                  client_generated_id, created_at, has_attachments)
             VALUES (-76101, -76100, 76100, 'text', 'old caption', 'forward-lock-source', NOW(), true);
             INSERT INTO attachments(id, message_id, uploader_uid, kind, external_reference,
                                     size, created_at, file_name)
             VALUES (-76102, -76101, 76100, 'image/png', 'old.png', 1, NOW(), 'old.png'),
                    (-76103, NULL, 76100, 'image/png', 'new.png', 1, NOW(), 'new.png');
             COMMIT;
             BEGIN;",
        ).unwrap();
        let id_gen = test_id_gen();
        let body = ForwardMessageBody {
            source_chat_id: -76100,
            client_generated_id: "forward-lock-copy".into(),
            thread_id: None,
        };
        let PreparedSingleForward::New(prepared) =
            prepare_single_forward(&mut conn, id_gen, 76100, -76100, -76101, &body)
                .await
                .unwrap()
        else {
            panic!("expected a new copy");
        };
        // Match patch_message's lock-before-replacing-attachments protocol.
        let edit = "BEGIN;
                    SET LOCAL lock_timeout = '100ms';
                    SELECT id FROM messages WHERE id = -76101 FOR UPDATE;
                    UPDATE messages SET message = 'new caption' WHERE id = -76101;
                    UPDATE attachments SET message_id = NULL WHERE id = -76102;
                    UPDATE attachments SET message_id = -76101 WHERE id = -76103;
                    COMMIT;";
        let error = editor
            .batch_execute(edit)
            .expect_err("edit must wait for the source lock");
        assert!(error.to_string().contains("lock timeout"), "{error}");
        editor.batch_execute("ROLLBACK").unwrap();
        let copied_file = attachments::table
            .filter(attachments::id.eq(prepared.attachment_ids[0]))
            .select(attachments::file_name)
            .first::<String>(&mut conn)
            .unwrap();
        assert_eq!(prepared.message.as_deref(), Some("old caption"));
        assert_eq!(copied_file, "old.png");
        conn.batch_execute("ROLLBACK").unwrap();

        // After the forwarding transaction ends, the edit succeeds and the
        // next copy sees the complete new version.
        editor.batch_execute(edit).unwrap();
        conn.batch_execute("BEGIN").unwrap();
        let PreparedSingleForward::New(prepared) =
            prepare_single_forward(&mut conn, id_gen, 76100, -76100, -76101, &body)
                .await
                .unwrap()
        else {
            panic!("expected a new copy");
        };
        let copied_file = attachments::table
            .filter(attachments::id.eq(prepared.attachment_ids[0]))
            .select(attachments::file_name)
            .first::<String>(&mut conn)
            .unwrap();
        assert_eq!(prepared.message.as_deref(), Some("new caption"));
        assert_eq!(copied_file, "new.png");
        conn.batch_execute("ROLLBACK").unwrap();
    }
}
