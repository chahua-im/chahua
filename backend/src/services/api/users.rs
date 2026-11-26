use std::collections::HashMap;
use std::sync::Arc;

use diesel::prelude::*;
use diesel::PgConnection;

use crate::dto::users::{
    ChatSettings, MeResponse, MemberSummary, SearchUsersQuery, SearchUsersResponse,
    StickerPackOrderItem, UpdateChatSettings, UpdateStickerPackOrderRequest,
};
use crate::dto::ws::{ServerWsMessage, StickerPackOrderUpdatePayload};
use crate::errors::AppError;
use crate::models::UserExtra;
use crate::schema::{group_membership, user_extra};
use crate::services::authz::{
    Action as AuthzAction, AuthorizationService, Resource as AuthzResource,
};
use crate::services::avatars::AvatarService;
use crate::services::sticker_order;
use crate::services::user::{lookup_user_profiles, search_users_with_profiles};
use crate::services::ws_registry::ConnectionRegistry;

const DEFAULT_USER_SEARCH_LIMIT: i64 = 20;
const MAX_USER_SEARCH_LIMIT: i64 = 50;

pub fn put_stickerpack_order(
    uid: i32,
    req: UpdateStickerPackOrderRequest,
    conn: &mut PgConnection,
    ws_registry: &ConnectionRegistry,
) -> Result<(), AppError> {
    let current_order = sticker_order::update_order(conn, uid, req.order)?;
    let msg = Arc::new(ServerWsMessage::StickerPackOrderUpdated(
        StickerPackOrderUpdatePayload {
            order: current_order,
        },
    ));
    ws_registry.broadcast_to_uids(&[uid], msg);
    Ok(())
}

/// Gets the current logged in user's information.
pub fn get_me(
    uid: i32,
    conn: &mut PgConnection,
    avatars: &AvatarService,
    authz_service: &AuthorizationService,
    restricted_user_group_ids: &[i32],
) -> Result<MeResponse, AppError> {
    let profiles = lookup_user_profiles(conn, &[uid])?;
    let profile = profiles.get(&uid);
    let username = profile
        .and_then(|profile| profile.username.clone())
        .unwrap_or_else(|| "Unknown".to_string());

    let mut avatar_urls = avatars.lookup(&[uid]);
    let avatar_url = avatar_urls.remove(&uid).flatten();

    let extra = user_extra::table
        .filter(user_extra::uid.eq(uid))
        .select(UserExtra::as_select())
        .first::<UserExtra>(conn)
        .optional()?;

    let notification_defaults = extra
        .as_ref()
        .map(
            |extra| crate::services::notification_preferences::NotificationDefaults {
                group_chats_muted: extra.mute_group_chats_by_default,
                direct_chats_muted: extra.mute_direct_chats_by_default,
            },
        )
        .unwrap_or_default();
    let show_membership_messages = extra
        .as_ref()
        .is_none_or(|extra| extra.show_membership_messages);
    let show_unread_message_count = extra
        .as_ref()
        .is_some_and(|extra| extra.show_unread_message_count);
    let sticker_pack_order = extra
        .and_then(|extra| {
            serde_json::from_value::<Vec<StickerPackOrderItem>>(extra.sticker_pack_order).ok()
        })
        .unwrap_or_default();
    let user_group = profile.and_then(|profile| profile.user_group.clone());
    let discuz_group_id = user_group.as_ref().map(|group| group.group_id);
    let permissions = authz_service.list_permissions_with_group_id(
        conn,
        uid,
        discuz_group_id,
        AuthzResource::Global,
    )?;
    let group_chat_write_restricted = crate::services::social::discuz_group_write_is_restricted(
        discuz_group_id,
        restricted_user_group_ids,
    );
    Ok(MeResponse {
        uid,
        username,
        avatar_url,
        gender: profile.map(|profile| profile.gender).unwrap_or(0),
        user_group,
        sticker_pack_order,
        permissions,
        mute_group_chats_by_default: notification_defaults.group_chats_muted,
        mute_direct_chats_by_default: notification_defaults.direct_chats_muted,
        show_membership_messages,
        show_unread_message_count,
        group_chat_write_restricted,
    })
}

pub fn put_chat_settings(
    uid: i32,
    settings: UpdateChatSettings,
    conn: &mut PgConnection,
    ws_registry: &ConnectionRegistry,
) -> Result<ChatSettings, AppError> {
    let previous_membership = if settings.show_membership_messages.is_some() {
        Some(crate::services::user::load_chat_settings(conn, uid)?.show_membership_messages)
    } else {
        None
    };
    let settings = crate::services::user::save_chat_settings(conn, uid, settings)?;
    if previous_membership.is_some_and(|previous| previous != settings.show_membership_messages) {
        ws_registry.invalidate_unread(&[uid]);
    } else {
        ws_registry.invalidate_unread_counts(&[uid]);
    }
    ws_registry.broadcast_to_uids(
        &[uid],
        Arc::new(ServerWsMessage::ChatSettingsChanged(settings)),
    );
    Ok(settings)
}

/// Searches global users for targeted invites.
pub fn get_user_search(
    uid: i32,
    query: SearchUsersQuery,
    conn: &mut PgConnection,
    avatars: &AvatarService,
    authz_service: &AuthorizationService,
) -> Result<SearchUsersResponse, AppError> {
    let q = query.q.as_deref().map(str::trim).unwrap_or("");
    let limit = normalize_user_search_limit(query.limit);
    let exact_uid = q.parse::<i32>().ok();
    let allow_prefix_search = !q.is_empty()
        && authz_service.has_permission(
            conn,
            uid,
            AuthzAction::MemberViewAll,
            AuthzResource::Global,
        )?;

    if !allow_prefix_search && exact_uid.is_none() {
        return Ok(SearchUsersResponse {
            members: Vec::new(),
            excluded: Vec::new(),
        });
    }

    let exclude_member_of = match query.exclude_member_of {
        Some(chat_id) if can_exclude_members_of_chat(conn, uid, chat_id)? => Some(chat_id),
        _ => None,
    };
    let rows = search_users_with_profiles(
        conn,
        q,
        allow_prefix_search,
        exact_uid,
        limit,
        exclude_member_of,
    )?;
    let uids: Vec<i32> = rows.iter().map(|row| row.uid).collect();
    let mut avatar_urls = avatars.lookup(&uids);
    let summaries = rows
        .into_iter()
        .map(|row| {
            (
                MemberSummary {
                    uid: row.uid,
                    username: row.profile.username,
                    avatar_url: avatar_urls.remove(&row.uid).flatten(),
                    gender: row.profile.gender,
                    user_group: row.profile.user_group,
                },
                row.is_excluded,
            )
        })
        .collect();
    let (members, excluded) = split_excluded_member_summaries(summaries);

    Ok(SearchUsersResponse { members, excluded })
}

pub fn build_member_summary_map(
    conn: &mut PgConnection,
    avatars: &AvatarService,
    uids: &[i32],
) -> Result<HashMap<i32, MemberSummary>, AppError> {
    let profiles = lookup_user_profiles(conn, uids)?;
    let mut avatars = avatars.lookup(uids);

    Ok(uids
        .iter()
        .filter_map(|uid| {
            profiles.get(uid).map(|profile| {
                (
                    *uid,
                    MemberSummary {
                        uid: *uid,
                        username: profile.username.clone(),
                        avatar_url: avatars.remove(uid).flatten(),
                        gender: profile.gender,
                        user_group: profile.user_group.clone(),
                    },
                )
            })
        })
        .collect())
}

fn normalize_user_search_limit(limit: Option<i64>) -> i64 {
    limit
        .unwrap_or(DEFAULT_USER_SEARCH_LIMIT)
        .clamp(1, MAX_USER_SEARCH_LIMIT)
}

fn can_exclude_members_of_chat(
    conn: &mut PgConnection,
    requester_uid: i32,
    chat_id: i64,
) -> Result<bool, AppError> {
    use crate::schema::group_membership::dsl as gm_dsl;

    let count = group_membership::table
        .filter(
            gm_dsl::chat_id
                .eq(chat_id)
                .and(gm_dsl::uid.eq(requester_uid)),
        )
        .count()
        .get_result::<i64>(conn)?;

    Ok(count > 0)
}

fn split_excluded_member_summaries(
    summaries: Vec<(MemberSummary, bool)>,
) -> (Vec<MemberSummary>, Vec<MemberSummary>) {
    let mut members = Vec::new();
    let mut excluded = Vec::new();
    for (summary, is_excluded) in summaries {
        if is_excluded {
            excluded.push(summary);
        } else {
            members.push(summary);
        }
    }

    (members, excluded)
}

#[cfg(test)]
mod tests {
    use super::{normalize_user_search_limit, split_excluded_member_summaries};
    use crate::dto::users::MemberSummary;

    fn make_summary(uid: i32) -> MemberSummary {
        MemberSummary {
            uid,
            username: Some(format!("user{uid}")),
            avatar_url: None,
            gender: 0,
            user_group: None,
        }
    }

    #[tokio::test]
    async fn chat_settings_broadcast_both_preferences_without_count_only_visibility_work() {
        use crate::dto::{users::UpdateChatSettings, ws::ServerWsMessage};
        use diesel::{Connection, PgConnection};
        use futures::FutureExt;
        use std::sync::Arc;
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        let registry = crate::services::ws_registry::ConnectionRegistry::new(Arc::new(
            crate::services::ws_registry::WsMetrics::new(&prometheus::Registry::new()),
        ));
        let uid = 987_675_100;
        let (first, mut first_rx) = registry.register(uid, "settings-first".into());
        let (second, mut second_rx) = registry.register(uid, "settings-second".into());
        let (_, mut other_rx) = registry.register(uid + 1, "settings-other".into());
        while first_rx.try_recv().is_ok() {}
        while second_rx.try_recv().is_ok() {}
        while other_rx.try_recv().is_ok() {}
        conn.test_transaction::<_, crate::errors::AppError, _>(|conn| {
            for (patch, expected_membership, expected_count, visibility_changed) in [
                (UpdateChatSettings { show_unread_message_count: Some(true), ..Default::default() }, true, true, false),
                (UpdateChatSettings { show_membership_messages: Some(false), ..Default::default() }, false, true, true),
                (UpdateChatSettings { show_membership_messages: Some(false), ..Default::default() }, false, true, false),
                (UpdateChatSettings { show_unread_message_count: Some(false), ..Default::default() }, false, false, false),
            ] {
                let saved = super::put_chat_settings(uid, patch, conn, &registry)?;
                assert_eq!(saved.show_membership_messages, expected_membership);
                assert_eq!(saved.show_unread_message_count, expected_count);
                for rx in [&mut first_rx, &mut second_rx] {
                    let event = rx.try_recv().unwrap();
                    assert!(matches!(&*event, ServerWsMessage::ChatSettingsChanged(settings) if *settings == saved));
                }
                assert!(other_rx.try_recv().is_err());
                for entry in [&first, &second] {
                    assert!(entry.unread_changed.notified().now_or_never().is_some());
                    assert_eq!(entry.states_changed.notified().now_or_never().is_some(), visibility_changed);
                }
            }
            Ok(())
        });
    }

    #[test]
    fn normalize_user_search_limit_clamps_to_max() {
        assert_eq!(normalize_user_search_limit(None), 20);
        assert_eq!(normalize_user_search_limit(Some(999)), 50);
        assert_eq!(normalize_user_search_limit(Some(5)), 5);
        assert_eq!(normalize_user_search_limit(Some(0)), 1);
    }

    #[test]
    fn split_excluded_uses_membership_flag() {
        let summaries = vec![
            (make_summary(1), false),
            (make_summary(2), true),
            (make_summary(3), true),
        ];
        let result = split_excluded_member_summaries(summaries);

        assert_eq!(
            result
                .0
                .iter()
                .map(|summary| summary.uid)
                .collect::<Vec<_>>(),
            vec![1]
        );
        assert_eq!(
            result
                .1
                .iter()
                .map(|summary| summary.uid)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
    }
}
