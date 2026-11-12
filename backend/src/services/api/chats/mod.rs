pub mod chat_attachments;
pub mod messages;
pub mod participants;
pub mod reactions;
pub mod saved_messages;

use std::sync::Arc;

use chrono::Utc;
use diesel::prelude::*;
use diesel::PgConnection;

use crate::dto::chats::{
    AcknowledgeReactionsBody, ChatListItem, ListChatsQuery, ListChatsResponse, MarkAsReadBody,
    MarkAsUnreadBody, MarkChatReadStateResponse, ReadReceiptQuery, UnreadCountResponse,
    UnreadMentionIdsResponse, UnreadMentionsQuery, UnreadReactionIdsResponse,
    UnreadReactionsAckResponse, UnreadReactionsQuery,
};
use crate::dto::read_receipts::ReadReceiptResponse;
use crate::errors::AppError;
use crate::models::GroupKind;
use crate::schema::{group_membership, messages as messages_schema};
use crate::services::api::{members::check_membership, users::build_member_summary_map};
use crate::services::authentication::Principal;
use crate::services::authz::{Action as AuthzAction, AuthorizationService};
use crate::services::avatars::AvatarService;
use crate::services::chat;
use crate::services::media::MediaStore;
use crate::services::notification_preferences::{
    load_chat_notification_setting, load_notification_defaults, publish_chat_notification_setting,
    set_chat_archived,
};
use crate::services::unread::UnreadService;
use crate::services::ws_registry::ConnectionRegistry;
use crate::utils::pagination::validate_limit;
use crate::MAX_CHATS_LIMIT;

pub async fn get_chats(
    uid: i32,
    query: ListChatsQuery,
    conn: &mut PgConnection,
    unread_service: &UnreadService,
    media: &MediaStore,
    avatars: &AvatarService,
    stages: crate::metrics::ApiStages<'_>,
) -> Result<ListChatsResponse, AppError> {
    let limit = validate_limit(query.limit, MAX_CHATS_LIMIT);
    let archived = query.archived.unwrap_or(false);
    let phase = stages.start("settings");
    let defaults = load_notification_defaults(conn, uid)?;
    let now = Utc::now();

    let chat_settings = crate::services::user::load_chat_settings(conn, uid)?;
    drop(phase);
    let phase = stages.start("page");
    let rows = crate::services::chat_list::load_chat_page(
        conn,
        uid,
        archived,
        query.chat_id,
        query.after,
        limit + 1,
        !chat_settings.show_membership_messages,
    )?;
    drop(phase);
    let has_more = rows.len() as i64 > limit;
    let mut items_to_process: Vec<_> = rows.into_iter().take(limit as usize).collect();

    let memberships = items_to_process
        .iter()
        .map(|row| crate::services::unread::ChatUnreadMembership {
            hide_membership_messages: crate::services::system_messages::hides_membership_messages(
                chat_settings.show_membership_messages && row.membership_allowed,
                row.kind,
                None,
            ),
            chat_id: row.chat_id,
            last_read_message_id: row.last_read_message_id,
            archived: row.archived,
            is_muted: row.notification_setting.is_muted(row.kind, defaults, now),
        })
        .collect::<Vec<_>>();
    let phase = stages.start("unread_counts");
    let unread_counts = unread_service.count_membership_unreads(conn, &memberships)?;
    drop(phase);
    let phase = stages.start("mention_counts");
    let mention_counts =
        unread_service.count_chat_unread_mentions_for_memberships(conn, uid, &memberships)?;
    drop(phase);
    let phase = stages.start("reaction_counts");
    let reaction_counts =
        unread_service.count_chat_unread_reactions_for_memberships(conn, uid, &memberships)?;
    drop(phase);
    let phase = stages.start("message_previews");

    let messages_to_process = items_to_process
        .iter_mut()
        .filter_map(|row| row.last_message.take())
        .collect();
    let mut message_previews =
        crate::services::chat_list::load_last_message_previews(conn, messages_to_process, avatars);
    drop(phase);
    let phase = stages.start("dm_peers");

    let dm_peer_uids: Vec<i32> = items_to_process
        .iter()
        .filter_map(|row| {
            if row.kind == GroupKind::Dm {
                if row.dm_uid1 == Some(uid) {
                    row.dm_uid2
                } else {
                    row.dm_uid1
                }
            } else {
                None
            }
        })
        .collect();
    let dm_peer_summaries = build_member_summary_map(conn, avatars, &dm_peer_uids)?;
    drop(phase);
    let phase = stages.start("read_receipts");
    let chat_ids: Vec<i64> = items_to_process.iter().map(|row| row.chat_id).collect();
    let peer_receipts =
        crate::services::read_receipts::visible_chat_receipts(conn, uid, &chat_ids)?;
    drop(phase);
    let _phase = stages.start("response_build");

    let chats: Vec<ChatListItem> = items_to_process
        .into_iter()
        .map(
            |crate::services::chat_list::ChatListRow {
                 chat_id: id,
                 name,
                 avatar_key,
                 last_message_at,
                 last_read_message_id,
                 last_message: _,
                 notification_setting: setting,
                 archived,
                 kind,
                 dm_uid1,
                 dm_uid2,
                 membership_visibility,
                 membership_allowed,
             }| {
                let unread_count = unread_counts.get(&id).copied().unwrap_or(0);
                let unread_mentions = mention_counts.get(&id).copied().unwrap_or(0);
                let unread_reactions = reaction_counts.get(&id).copied().unwrap_or(0);
                let message = message_previews.remove(&id);
                let peer = if kind == GroupKind::Dm {
                    let peer_uid = if dm_uid1 == Some(uid) {
                        dm_uid2
                    } else {
                        dm_uid1
                    };
                    peer_uid.and_then(|peer_uid| dm_peer_summaries.get(&peer_uid).cloned())
                } else {
                    None
                };
                ChatListItem {
                    membership_message_policy: crate::dto::groups::MembershipMessagePolicy {
                        visibility: membership_visibility,
                        can_view: membership_allowed,
                    },
                    id,
                    name: Some(name),
                    avatar: avatar_key
                        .as_deref()
                        .map(|storage_key| media.public_url(storage_key)),
                    last_message_at,
                    unread_count,
                    unread_mentions,
                    unread_reactions,
                    last_read_message_id,
                    peer_last_read_message_id: peer_receipts.get(&id).copied(),
                    last_message: message,
                    muted_until: setting.muted_until,
                    mute_override: setting.mute_override,
                    is_muted: setting.is_muted(kind, defaults, now),
                    archived,
                    kind,
                    peer,
                }
            },
        )
        .collect();

    let next_cursor = has_more.then(|| chats.last().map(|chat| chat.id)).flatten();

    Ok(ListChatsResponse {
        chats,
        next_cursor,
        chat_settings,
    })
}

pub fn mark_as_read(
    uid: i32,
    chat_id: i64,
    body: MarkAsReadBody,
    conn: &mut PgConnection,
    unread_service: &UnreadService,
    ws_registry: &Arc<ConnectionRegistry>,
) -> Result<MarkChatReadStateResponse, AppError> {
    check_membership(conn, chat_id, uid)?;
    crate::services::read_receipts::validate_chat_read_target(conn, chat_id, body.message_id)?;

    let read_state = crate::services::chat::mark_chat_as_read_state(
        conn,
        unread_service,
        chat_id,
        uid,
        body.message_id,
    )?;

    let unread_mentions = unread_service.count_chat_unread_mentions(
        conn,
        uid,
        chat_id,
        read_state.last_read_message_id,
        None,
    )?;
    // Ordinary message reads no longer advance the reaction cursor; this is
    // the live unread-reaction count for the unchanged cursor.
    let unread_reactions = unread_service.count_chat_unread_reactions(conn, uid, chat_id, None)?;

    if read_state.receipt_advanced {
        crate::services::read_receipts::broadcast_read_receipt_changed_if_dm(
            conn,
            ws_registry,
            chat_id,
            false,
            Some(uid),
            None,
        )?;
    }

    ws_registry.invalidate_unread(&[uid]);
    Ok(MarkChatReadStateResponse {
        last_read_message_id: read_state.last_read_message_id,
        unread_count: read_state.unread_count,
        unread_mentions,
        unread_reactions,
    })
}

pub fn get_chat_read_receipt(
    uid: i32,
    chat_id: i64,
    query: ReadReceiptQuery,
    conn: &mut PgConnection,
) -> Result<ReadReceiptResponse, AppError> {
    check_membership(conn, chat_id, uid)?;

    if let Some(thread_root_id) = query.thread_id {
        let is_thread_root: bool = diesel::select(diesel::dsl::exists(
            messages_schema::table.filter(
                messages_schema::id
                    .eq(thread_root_id)
                    .and(messages_schema::chat_id.eq(chat_id))
                    .and(messages_schema::reply_root_id.is_null()),
            ),
        ))
        .get_result(conn)?;
        if !is_thread_root {
            return Err(AppError::NotFound("Thread root message not found"));
        }
    }

    let last_read_message_id =
        crate::services::read_receipts::get_read_receipt(conn, uid, chat_id, query.thread_id)?;
    Ok(ReadReceiptResponse {
        last_read_message_id,
    })
}

pub fn mark_as_unread(
    uid: i32,
    chat_id: i64,
    body: Option<MarkAsUnreadBody>,
    conn: &mut PgConnection,
    unread_service: &UnreadService,
    ws_registry: &ConnectionRegistry,
) -> Result<MarkChatReadStateResponse, AppError> {
    check_membership(conn, chat_id, uid)?;

    let explicit_id = body.and_then(|body| body.message_id);

    let (new_read_id, unread_count) = if let Some(message_id) = explicit_id {
        use crate::schema::group_membership::dsl as gm_dsl;
        diesel::update(
            group_membership::table.filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(uid))),
        )
        .set(gm_dsl::last_read_message_id.eq(Some(message_id)))
        .execute(conn)?;

        let unread_count =
            unread_service.count_chat_unread(conn, uid, chat_id, Some(message_id))?;
        (Some(message_id), unread_count)
    } else {
        use crate::schema::messages::dsl;
        let hide =
            crate::services::system_messages::load_membership_message_filter(conn, uid, chat_id)?;
        let predicate = if hide {
            crate::services::system_messages::NON_MEMBERSHIP_PREDICATE
        } else {
            "TRUE"
        };
        let last_two: Vec<i64> = messages_schema::table
            .filter(diesel::dsl::sql::<diesel::sql_types::Bool>(predicate))
            .filter(
                dsl::chat_id
                    .eq(chat_id)
                    .and(dsl::reply_root_id.is_null())
                    .and(dsl::deleted_at.is_null())
                    .and(dsl::is_published.eq(true)),
            )
            .order(dsl::id.desc())
            .limit(2)
            .select(dsl::id)
            .load(conn)?;

        // If < 2 public messages, set to NULL (entire chat unread); otherwise second-to-last.
        let new_read_id = if last_two.len() >= 2 {
            Some(last_two[1])
        } else {
            None
        };

        use crate::schema::group_membership::dsl as gm_dsl;
        diesel::update(
            group_membership::table.filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(uid))),
        )
        .set(gm_dsl::last_read_message_id.eq(new_read_id))
        .execute(conn)?;

        let unread_count = if new_read_id.is_some() {
            1
        } else {
            last_two.len() as i64
        };
        (new_read_id, unread_count)
    };

    let unread_mentions =
        unread_service.count_chat_unread_mentions(conn, uid, chat_id, new_read_id, None)?;
    // Marking unread rewinds the message pointer only; the reaction cursor
    // never moves backwards, so this reports the live (unchanged) count.
    let unread_reactions = unread_service.count_chat_unread_reactions(conn, uid, chat_id, None)?;

    ws_registry.invalidate_unread(&[uid]);
    Ok(MarkChatReadStateResponse {
        last_read_message_id: new_read_id,
        unread_count,
        unread_mentions,
        unread_reactions,
    })
}

pub fn get_chat_unread_count(
    uid: i32,
    chat_id: i64,
    conn: &mut PgConnection,
    unread_service: &UnreadService,
) -> Result<MarkChatReadStateResponse, AppError> {
    check_membership(conn, chat_id, uid)?;

    use crate::schema::group_membership::dsl as gm_dsl;
    let last_read_message_id: Option<i64> = group_membership::table
        .filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(uid)))
        .select(gm_dsl::last_read_message_id)
        .first(conn)?;

    let unread_count =
        unread_service.count_chat_unread(conn, uid, chat_id, last_read_message_id)?;
    let unread_mentions = unread_service.count_chat_unread_mentions(
        conn,
        uid,
        chat_id,
        last_read_message_id,
        None,
    )?;
    let unread_reactions = unread_service.count_chat_unread_reactions(conn, uid, chat_id, None)?;

    Ok(MarkChatReadStateResponse {
        last_read_message_id,
        unread_count,
        unread_mentions,
        unread_reactions,
    })
}

pub fn get_chat_mentions(
    uid: i32,
    chat_id: i64,
    query: UnreadMentionsQuery,
    conn: &mut PgConnection,
    unread_service: &UnreadService,
) -> Result<UnreadMentionIdsResponse, AppError> {
    check_membership(conn, chat_id, uid)?;

    let limit = validate_limit(query.max, crate::constants::MAX_UNREAD_COUNT);

    let (last_read_message_id, thread_root_id) = match query.thread_id {
        Some(thread_id) => {
            let last_read = crate::services::threads::get_thread_last_read_message_id(
                conn, chat_id, thread_id, uid,
            )?;
            (last_read, Some(thread_id))
        }
        None => {
            let last_read = chat::get_chat_last_read_message_id(conn, chat_id, uid)?;
            (last_read, None)
        }
    };

    let ids = unread_service.list_chat_unread_mentions(
        conn,
        uid,
        chat_id,
        last_read_message_id,
        thread_root_id,
        limit,
    )?;

    Ok(UnreadMentionIdsResponse {
        message_ids: ids.into_iter().map(|id| id.to_string()).collect(),
    })
}

pub fn get_chat_reactions(
    uid: i32,
    chat_id: i64,
    query: UnreadReactionsQuery,
    conn: &mut PgConnection,
    unread_service: &UnreadService,
) -> Result<UnreadReactionIdsResponse, AppError> {
    check_membership(conn, chat_id, uid)?;

    let limit = validate_limit(query.max, crate::constants::MAX_UNREAD_COUNT);
    let snapshot = unread_service.snapshot_chat_unread_reactions(
        conn,
        uid,
        chat_id,
        query.thread_id,
        limit,
        query.after,
    )?;
    Ok(snapshot)
}

pub fn acknowledge_chat_reactions(
    uid: i32,
    chat_id: i64,
    body: AcknowledgeReactionsBody,
    conn: &mut PgConnection,
    unread_service: &UnreadService,
    ws_registry: &ConnectionRegistry,
) -> Result<UnreadReactionsAckResponse, AppError> {
    if let Some(thread_id) = body.thread_id {
        crate::services::api::threads::authorize_thread_in_chat(conn, chat_id, thread_id, uid)?;
    } else {
        check_membership(conn, chat_id, uid)?;
    }

    let unread_reactions = unread_service.acknowledge_chat_unread_reactions(
        conn,
        uid,
        chat_id,
        body.thread_id,
        body.read_through,
    )?;

    ws_registry.invalidate_unread(&[uid]);
    Ok(UnreadReactionsAckResponse { unread_reactions })
}

pub fn get_unread_count(
    principal: Principal,
    conn: &mut PgConnection,
    authz_service: &AuthorizationService,
    unread_service: &UnreadService,
) -> Result<UnreadCountResponse, AppError> {
    let uid =
        principal.require_user_action(conn, authz_service, AuthzAction::OnBehalfOfSocialRead)?;
    let counts = unread_service.count_user_unread_summary(conn, uid)?;
    let (unread_mentions, mention_badges, archived_mention_badges) =
        unread_service.count_user_mention_summary(conn, uid)?;

    Ok(UnreadCountResponse {
        mention_badges,
        archived_mention_badges,
        unread_count: counts.unread_count,
        archived_unread_count: counts.archived_unread_count,
        unread_chat_count: counts.unread_chat_count,
        archived_unread_chat_count: counts.archived_unread_chat_count,
        unread_mentions,
    })
}

pub fn archive_chat(
    uid: i32,
    chat_id: i64,
    conn: &mut PgConnection,
    ws_registry: &ConnectionRegistry,
) -> Result<(), AppError> {
    set_chat_archived_and_publish(uid, chat_id, true, conn, ws_registry)
}

pub fn unarchive_chat(
    uid: i32,
    chat_id: i64,
    conn: &mut PgConnection,
    ws_registry: &ConnectionRegistry,
) -> Result<(), AppError> {
    set_chat_archived_and_publish(uid, chat_id, false, conn, ws_registry)
}

fn set_chat_archived_and_publish(
    uid: i32,
    chat_id: i64,
    archived: bool,
    conn: &mut PgConnection,
    ws_registry: &ConnectionRegistry,
) -> Result<(), AppError> {
    check_membership(conn, chat_id, uid)?;
    let _update = crate::services::notification_preferences::lock_notification_update(uid);

    let setting = conn.transaction::<_, AppError, _>(|conn| {
        set_chat_archived(conn, chat_id, uid, archived)?;
        load_chat_notification_setting(conn, chat_id, uid)
    })?;
    publish_chat_notification_setting(ws_registry, uid, setting);

    Ok(())
}
