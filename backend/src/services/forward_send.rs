//! Send a forward from its current sources in one database transaction.
use diesel::prelude::*;
use uuid::Uuid;

use crate::{
    dto::rpc::messages::{ForwardTarget, MessagesSendForwardParams, SendForwardResponse},
    errors::AppError,
    models::{ForwardPlaceholder, GroupKind, Message, MessageType},
    schema::{forwarded_bundles, messages},
    services::{
        api::{
            chats::messages::{
                broadcast_thread_send_updates, ForwardMessageDeps, ThreadSendUpdateDeps,
            },
            members::check_membership,
        },
        forwarding::{
            acquire_forward_retry_lock, canonical_forward_message_ids, capture_forward_message,
            check_source_membership, load_locked_forward_sources, MAX_FORWARD_MESSAGES,
        },
        messages::{
            write_prepared_message, MessageSendAuthorizationError, MessageSendMembership,
            SendMessageOutcome, SendMessageResult,
        },
        single_forwarding::{capture_single_forward, SingleForwardDeps},
    },
    utils::transaction::AsyncTransaction,
};

#[derive(Queryable)]
struct SentForward {
    message_id: i64,
    chat_id: i64,
    thread_id: Option<i64>,
    sender_uid: i32,
}

impl SentForward {
    fn matches_target(&self, uid: i32, target: &ForwardTarget) -> bool {
        self.sender_uid == uid
            && self.chat_id == target.chat_id
            && self.thread_id == target.thread_id
    }
}

/// A recalled message still confirms that the original send committed.
fn find_sent_forward(
    conn: &mut PgConnection,
    operation_id: &str,
) -> QueryResult<Option<SentForward>> {
    messages::table
        .filter(messages::client_generated_id.eq(operation_id))
        .select((
            messages::id,
            messages::chat_id,
            messages::reply_root_id,
            messages::sender_uid,
        ))
        .first(conn)
        .optional()
}

pub(crate) fn load_topic_sources(
    conn: &mut PgConnection,
    uid: i32,
    chat_id: i64,
    root: i64,
) -> Result<Vec<Message>, AppError> {
    check_membership(conn, chat_id, uid)?;
    let sources = messages::table
        .filter(messages::chat_id.eq(chat_id))
        .filter(
            messages::reply_root_id
                .eq(root)
                .or(messages::id.eq(root).and(messages::reply_root_id.is_null())),
        )
        .filter(messages::is_published.eq(true))
        .filter(messages::deleted_at.is_null())
        .filter(messages::message_type.ne(MessageType::System))
        .order(messages::id.asc())
        .limit(MAX_FORWARD_MESSAGES as i64 + 1)
        .select(Message::as_select())
        .load(conn)?;
    if sources.len() > MAX_FORWARD_MESSAGES {
        return Err(AppError::PayloadTooLarge("Too many messages to forward"));
    }
    if sources.is_empty() {
        return Err(AppError::Gone("Forward sources unavailable"));
    }
    Ok(sources)
}

struct CommittedForward {
    sent: Box<SendMessageResult>,
    chat_kind: GroupKind,
    subscription_changes: Vec<i32>,
}

pub async fn send(
    conn: &mut PgConnection,
    uid: i32,
    params: MessagesSendForwardParams,
    deps: ForwardMessageDeps<'_>,
) -> Result<SendForwardResponse, AppError> {
    let target = &params.target;
    Uuid::parse_str(&target.client_generated_id)
        .map_err(|_| AppError::BadRequest("Invalid forward operation ID"))?;
    let ids = canonical_forward_message_ids(params.message_ids)?;
    let mut transaction = AsyncTransaction::begin(conn)?;
    let tx_conn = transaction.connection();
    let result = async {
        acquire_forward_retry_lock(tx_conn, &target.client_generated_id)?;
        if let Some(sent) = find_sent_forward(tx_conn, &target.client_generated_id)? {
            if !sent.matches_target(uid, target) {
                return Err(AppError::Conflict("Forward operation already used"));
            }
            return Ok((
                SendForwardResponse {
                    message: None,
                    message_id: sent.message_id,
                },
                None,
            ));
        }

        // Member removal locks the chat before the membership row.
        super::speaking::lock_chat(tx_conn, target.chat_id, false)?;
        let target_membership = if params.source_chat_id == target.chat_id {
            Some(
                MessageSendMembership::load(tx_conn, target.chat_id, uid)?
                    .ok_or(AppError::Gone("Forward source chat unavailable"))?,
            )
        } else {
            check_source_membership(tx_conn, params.source_chat_id, uid).map_err(|e| match e {
                AppError::Forbidden(_) => AppError::Gone("Forward source chat unavailable"),
                other => other,
            })?;
            None
        };
        let sources = load_locked_forward_sources(tx_conn, uid, params.source_chat_id, &ids)?;
        if sources.selected.len() != ids.len() {
            return Err(AppError::Gone("Forward sources unavailable"));
        }
        let membership = match target_membership {
            Some(member) => member,
            None => MessageSendMembership::load(tx_conn, target.chat_id, uid)?
                .ok_or(MessageSendAuthorizationError::NotChatMember)?,
        };
        let destination = membership.authorize(tx_conn, target.chat_id, target.thread_id, uid)?;
        let permits = |id, reason| params.confirmed_placeholders.get(&id) == Some(&reason);
        let prepared = if let [source] = sources.selected.as_slice() {
            capture_single_forward(
                tx_conn,
                SingleForwardDeps {
                    id_gen: deps.id_gen,
                    media: deps.media,
                    avatars: deps.avatars,
                },
                uid,
                target,
                destination.kind,
                source,
                permits(source.id, ForwardPlaceholder::PendingAudio),
            )
            .await?
        } else {
            let (prepared, bundle) = capture_forward_message(
                tx_conn,
                deps.id_gen,
                target,
                destination.kind,
                uid,
                sources,
                permits,
            )
            .await?;
            diesel::insert_into(forwarded_bundles::table)
                .values(&bundle)
                .execute(tx_conn)?;
            prepared
        };
        let SendMessageOutcome::Created(sent) =
            write_prepared_message(tx_conn, deps.id_gen, deps.media, deps.avatars, prepared)
                .await?
        else {
            return Err(AppError::Conflict("Forward operation already sent"));
        };
        let subscription_changes = if let Some(root) = &destination.thread_root {
            crate::services::threads::record_thread_send(
                tx_conn,
                &sent.response,
                &sent.member_uids,
                root,
                crate::services::threads::ThreadSendOptions {
                    publish_immediately: true,
                    subscribe_mentioned_users: false,
                    mark_read: false,
                },
            )?
            .subscription_changes
        } else {
            Vec::new()
        };

        let response = SendForwardResponse {
            message: Some(sent.response.clone()),
            message_id: sent.response.id,
        };
        Ok((
            response,
            Some(CommittedForward {
                sent,
                chat_kind: destination.kind,
                subscription_changes,
            }),
        ))
    }
    .await;
    let (response, committed) = transaction.finish(result)?;
    if let Some(committed) = committed {
        notify_forward(conn, uid, target, &deps, committed).await;
    }
    Ok(response)
}

async fn notify_forward(
    conn: &mut PgConnection,
    uid: i32,
    params: &ForwardTarget,
    deps: &ForwardMessageDeps<'_>,
    committed: CommittedForward,
) {
    let CommittedForward {
        sent,
        chat_kind,
        subscription_changes,
    } = committed;
    deps.metrics.chat.record_message(params.chat_id, chat_kind);
    sent.side_effects.fire(deps.ws_registry, deps.push_service);
    if let Some(search) = deps.message_search {
        search.upsert_response_best_effort(&sent.response);
    }
    if let Some(thread_id) = params.thread_id {
        for changed_uid in subscription_changes {
            if let Err(error) =
                crate::services::threads::broadcast_thread_membership_changed_to_user(
                    conn,
                    deps.ws_registry,
                    changed_uid,
                    params.chat_id,
                    thread_id,
                )
            {
                tracing::warn!(
                    ?error,
                    thread_id,
                    changed_uid,
                    "Failed to broadcast thread membership after forward"
                );
            }
        }
        if !sent.member_uids.is_empty() {
            broadcast_thread_send_updates(
                conn,
                ThreadSendUpdateDeps {
                    media: deps.media,
                    avatars: deps.avatars,
                    ws_registry: deps.ws_registry,
                },
                params.chat_id,
                thread_id,
                &sent.member_uids,
                uid,
            )
            .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::connection::SimpleConnection;

    fn deps(services: &crate::rpc::RpcServices) -> ForwardMessageDeps<'_> {
        ForwardMessageDeps {
            id_gen: &services.id_gen,
            media: &services.media,
            avatars: &services.avatars,
            metrics: &services.metrics,
            ws_registry: &services.ws_registry,
            push_service: &services.push_service,
            message_search: &services.message_search,
        }
    }

    fn seed(conn: &mut PgConnection) {
        conn.batch_execute("INSERT INTO groups(id,name) VALUES (-91400,'forward source'),(-91500,'forward target');
            INSERT INTO group_membership(chat_id,uid) VALUES (-91400,1),(-91500,1);
            INSERT INTO messages(id,chat_id,sender_uid,message_type,message,client_generated_id,created_at,is_published,reply_to_id)
            VALUES (-91403,-91400,2,'text','reply before','panel-reply',NOW(),true,NULL),
                (-91402,-91400,2,'text','before','panel-source',NOW(),true,-91403),
                (-91401,-91400,2,'text','second','panel-second',NOW(),true,NULL),
                (-91501,-91500,2,'text','thread root','panel-thread',NOW(),true,NULL);
            INSERT INTO attachments(id,message_id,uploader_uid,file_name,kind,external_reference,size,created_at)
            VALUES (-91410,-91402,2,'photo.png','image/png','forward-test-photo',20,NOW());
            UPDATE messages SET has_attachments=true, reply_root_id=-91403 WHERE id=-91402;").unwrap();
    }

    fn request(ids: &[i64], operation: &str) -> MessagesSendForwardParams {
        MessagesSendForwardParams {
            target: ForwardTarget {
                chat_id: -91500,
                thread_id: Some(-91501),
                client_generated_id: operation.into(),
            },
            source_chat_id: -91400,
            message_ids: ids.to_vec(),
            confirmed_placeholders: Default::default(),
        }
    }

    #[tokio::test]
    async fn database_send_captures_current_content_and_replays_after_recall() {
        let Some(services) = crate::rpc::test_support::services().await else {
            return;
        };
        let mut conn = services.db.get().unwrap();
        seed(&mut conn);
        let sources = load_topic_sources(&mut conn, 1, -91400, -91403).unwrap();
        let ids: Vec<_> = sources.iter().map(|m| m.id).collect();
        assert_eq!(ids, [-91403, -91402]);
        assert_eq!(sources[1].message.as_deref(), Some("before"));
        conn.batch_execute(
            "UPDATE messages SET message='after' WHERE id=-91402;
            UPDATE messages SET reply_to_id=-91401 WHERE id=-91403;
            UPDATE messages SET message='external at send' WHERE id=-91401;
            INSERT INTO group_membership(chat_id,uid) VALUES (-91500,3)",
        )
        .unwrap();

        let single = request(&[-91402], &Uuid::new_v4().to_string());
        let message = send(&mut conn, 1, single, deps(&services))
            .await
            .unwrap()
            .message
            .unwrap();
        assert_eq!(message.message.as_deref(), Some("after"));
        assert_eq!(message.attachments.len(), 1);
        assert_eq!(message.reply_root_id, Some(-91501));

        let operation = Uuid::new_v4().to_string();
        let merged = || request(&ids, &operation);
        let sent = send(&mut conn, 1, merged(), deps(&services)).await.unwrap();
        let preview = sent.message.unwrap().forwarded_preview.unwrap();
        assert_eq!(preview.messages[1].message.as_deref(), Some("after"));

        conn.batch_execute(
            "UPDATE messages SET deleted_at=NOW(),message=NULL WHERE id IN (-91401,-91402)",
        )
        .unwrap();
        let records = crate::services::api::chats::messages::get_forwarded_messages(
            3,
            -91500,
            sent.message_id,
            &mut conn,
            &services.media,
            &services.avatars,
        )
        .unwrap();
        use crate::dto::messages::ForwardedReplyResponse;
        assert!(
            matches!(&records.messages[0].reply, Some(ForwardedReplyResponse::External { preview: Some(quote) }) if quote.message.as_deref() == Some("external at send"))
        );
        assert!(matches!(
            &records.messages[1].reply,
            Some(ForwardedReplyResponse::Internal {
                original_message_id: -91403,
                ..
            })
        ));
        let fresh = request(&ids, &Uuid::new_v4().to_string());
        assert!(matches!(
            send(&mut conn, 1, fresh, deps(&services)).await,
            Err(AppError::Gone(_))
        ));
        diesel::update(messages::table.find(sent.message_id))
            .set(messages::created_at.eq(chrono::Utc::now() - chrono::Duration::days(1)))
            .execute(&mut conn)
            .unwrap();
        assert!(matches!(
            send(&mut conn, 2, merged(), deps(&services)).await,
            Err(AppError::Conflict(_))
        ));
        let replay = send(&mut conn, 1, merged(), deps(&services)).await.unwrap();
        assert_eq!(replay.message_id, sent.message_id);
        assert!(replay.message.is_none());
        let target_count = messages::table.filter(messages::chat_id.eq(-91500)).count();
        assert_eq!(target_count.get_result::<i64>(&mut conn).unwrap(), 3); // root + two forwards
    }

    #[tokio::test]
    async fn database_send_rechecks_source_membership_after_topic_selection() {
        let Some(services) = crate::rpc::test_support::services().await else {
            return;
        };
        let mut conn = services.db.get().unwrap();
        seed(&mut conn);
        let sources = load_topic_sources(&mut conn, 1, -91400, -91403).unwrap();
        let selected = || request(&[sources[0].id], &Uuid::new_v4().to_string());
        let same_chat = || {
            let mut params = selected();
            params.target.chat_id = params.source_chat_id;
            params.target.thread_id = Some(sources[0].id);
            params
        };
        let posted = send(&mut conn, 1, same_chat(), deps(&services))
            .await
            .unwrap();
        assert_eq!(posted.message.unwrap().reply_root_id, Some(sources[0].id));
        conn.batch_execute("DELETE FROM group_membership WHERE chat_id=-91400 AND uid=1")
            .unwrap();
        assert!(matches!(
            load_topic_sources(&mut conn, 1, -91400, -91403),
            Err(AppError::Forbidden(_))
        ));
        for params in [selected(), same_chat()] {
            assert!(matches!(
                send(&mut conn, 1, params, deps(&services)).await,
                Err(AppError::Gone("Forward source chat unavailable"))
            ));
        }
    }

    #[tokio::test]
    async fn database_placeholder_consent_uses_the_audio_state_at_send() {
        let Some(services) = crate::rpc::test_support::services().await else {
            return;
        };
        let mut conn = services.db.get().unwrap();
        seed(&mut conn);
        conn.batch_execute(
            "INSERT INTO forwarded_bundles (id,created_by_uid,item_count,payload,preview,child_bundle_ids,created_at)
             VALUES (-91610,1,2,'[]','[]',ARRAY[-91611]::bigint[],NOW());
            UPDATE messages SET message_type='forwarded',forwarded_bundle_id=-91610 WHERE id=-91403;
            UPDATE messages SET message_type='audio',transcode_status='pending' WHERE id=-91402;
            UPDATE messages SET message_type='invite',message='private-code' WHERE id=-91401;",
        )
        .unwrap();
        let operation = Uuid::new_v4().to_string();
        let ids = [-91403, -91402, -91401];
        let mut partial = request(&ids, &operation);
        partial
            .confirmed_placeholders
            .insert(-91403, ForwardPlaceholder::NestedForward);
        let Err(AppError::ForwardPlaceholderRequired(consent)) =
            send(&mut conn, 1, partial, deps(&services)).await
        else {
            panic!("confirming the nested card must not authorize replacing the audio");
        };
        assert_eq!(
            consent.by_message,
            [
                (-91403, ForwardPlaceholder::NestedForward),
                (-91402, ForwardPlaceholder::PendingAudio),
            ]
            .into()
        );
        let mut confirmed = request(&ids, &operation);
        confirmed.confirmed_placeholders = consent.by_message;
        conn.batch_execute("UPDATE messages SET transcode_status='done' WHERE id=-91402;")
            .unwrap();
        let posted = send(&mut conn, 1, confirmed, deps(&services))
            .await
            .unwrap()
            .message
            .unwrap();
        let preview = posted.forwarded_preview.unwrap();
        assert_eq!(
            preview.messages[0].message.as_deref(),
            Some("nestedForward")
        );
        assert_eq!(preview.messages[1].message_type, MessageType::Audio);
        assert_eq!(preview.messages[2].message.as_deref(), Some("groupInvite"));
        let bundle = crate::services::messages::load_forwarded_bundle(
            &mut conn,
            posted.forwarded_bundle_id.unwrap(),
        )
        .unwrap();
        assert!(!bundle.payload.to_string().contains("private-code"));
    }

    #[tokio::test]
    async fn database_failed_insert_rolls_back_bundle_and_allows_retry() {
        let Some(services) = crate::rpc::test_support::services().await else {
            return;
        };
        let mut conn = services.db.get().unwrap();
        seed(&mut conn);
        let operation = Uuid::new_v4().to_string();
        let ids = [-91402, -91401];
        let bundle_count = |conn: &mut PgConnection| {
            forwarded_bundles::table
                .count()
                .get_result::<i64>(conn)
                .unwrap()
        };
        let before = bundle_count(&mut conn);
        conn.batch_execute("CREATE FUNCTION pg_temp.reject_forward() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'reject forward'; END $$;
            CREATE TRIGGER reject_forward BEFORE INSERT ON pg_temp.messages FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_forward();").unwrap();
        assert!(
            send(&mut conn, 1, request(&ids, &operation), deps(&services))
                .await
                .is_err()
        );
        assert_eq!(bundle_count(&mut conn), before);
        assert!(find_sent_forward(&mut conn, &operation).unwrap().is_none());
        conn.batch_execute("DROP TRIGGER reject_forward ON pg_temp.messages;")
            .unwrap();
        let retry = send(&mut conn, 1, request(&ids, &operation), deps(&services))
            .await
            .unwrap();
        assert!(retry.message.is_some());
        assert_eq!(bundle_count(&mut conn), before + 1);
    }
}
