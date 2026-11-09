use std::sync::Arc;

use chrono::Utc;
use diesel::prelude::*;
use diesel::PgConnection;
use diesel::PgTextExpressionMethods;

use crate::dto::groups::{
    AvatarUploadUrlRequest, AvatarUploadUrlResponse, ChatNotificationSettingResponse,
    CreateChatBody, CreateChatResponse, GroupInfoResponse, GroupSearchMode, GroupSelectorItem,
    GroupSelectorScope, ListGroupsQuery, ListGroupsResponse, MuteBody, MuteResponse,
    UpdateChatBody, UpdateNotificationSettingRequest,
};
use crate::dto::speaking::{GroupSpeakingModeResponse, UpdateSpeakingModeRequest};
use crate::errors::AppError;
use crate::models::{
    GroupJoinReason, GroupKind, GroupRole, GroupVisibility, Media, MediaPurpose, NewGroup,
    NewGroupMembership, NewMedia, UpdateGroup,
};
use crate::schema::{group_membership, groups, media};
use crate::services::api::members::{check_membership, require_admin_role};
use crate::services::authz::{
    Action as AuthzAction, AuthorizationService, Resource as AuthzResource,
};
use crate::services::avatars::AvatarService;
use crate::services::media::MediaStore;
use crate::services::notification_preferences::{
    load_chat_notification_setting, load_notification_defaults, publish_chat_notification_setting,
    update_chat_notification_setting, ChatNotificationCommand, ChatNotificationSetting,
};
use crate::services::ws_registry::ConnectionRegistry;
use crate::utils::ids::{self, IdGen};
use crate::utils::pagination::validate_limit;

const MAX_GROUP_AVATAR_BYTES: i64 = 10 * 1024 * 1024;
const MAX_GROUP_SELECTOR_LIMIT: i64 = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedGroupSearch {
    pattern: String,
    exact_id: Option<i64>,
}

fn parse_group_search_query(
    raw_query: Option<&str>,
    mode: GroupSearchMode,
) -> Option<ParsedGroupSearch> {
    let query = raw_query?.trim();
    if query.is_empty() {
        return None;
    }

    let exact_id = (mode == GroupSearchMode::Submitted)
        .then(|| query.parse::<i64>().ok())
        .flatten();
    let pattern = match mode {
        GroupSearchMode::Autocomplete => format!("{query}%"),
        GroupSearchMode::Submitted => format!("%{query}%"),
    };

    Some(ParsedGroupSearch { pattern, exact_id })
}

pub(crate) fn load_requester_group_role(
    conn: &mut PgConnection,
    chat_id: i64,
    uid: i32,
) -> Result<Option<GroupRole>, AppError> {
    use crate::schema::group_membership::dsl as gm_dsl;

    Ok(group_membership::table
        .filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(uid)))
        .select(gm_dsl::role)
        .first(conn)
        .optional()?)
}

pub fn load_group_info(
    conn: &mut PgConnection,
    media_store: &MediaStore,
    avatars: &AvatarService,
    chat_id: i64,
    requester_uid: i32,
) -> Result<GroupInfoResponse, AppError> {
    use crate::schema::groups::dsl as groups_dsl;

    let group: crate::models::Group = groups::table
        .filter(groups_dsl::id.eq(chat_id))
        .select(crate::models::Group::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Chat not found"))?;

    let avatar_image = match group.avatar_image_id {
        Some(avatar_image_id) => media::table
            .filter(
                media::id
                    .eq(avatar_image_id)
                    .and(media::deleted_at.is_null()),
            )
            .select(Media::as_select())
            .first(conn)
            .optional()?,
        None => None,
    };

    let my_role = load_requester_group_role(conn, chat_id, requester_uid)?;
    let (archived, notification_setting, my_speaking_mode) = group_membership::table
        .filter(
            group_membership::chat_id
                .eq(chat_id)
                .and(group_membership::uid.eq(requester_uid)),
        )
        .select((
            group_membership::archived,
            (
                group_membership::muted_until,
                group_membership::mute_override,
            ),
            group_membership::speaking_mode.nullable(),
        ))
        .first::<(
            bool,
            ChatNotificationSetting,
            Option<crate::models::SpeakingMode>,
        )>(conn)
        .optional()?
        .unwrap_or((
            false,
            ChatNotificationSetting {
                muted_until: None,
                mute_override: None,
            },
            None,
        ));
    let defaults = load_notification_defaults(conn, requester_uid)?;

    let peer = if group.kind == GroupKind::Dm {
        let peer_uid = if group.dm_uid1 == Some(requester_uid) {
            group.dm_uid2
        } else {
            group.dm_uid1
        };
        if let Some(peer_uid) = peer_uid {
            let mut summaries =
                crate::services::api::users::build_member_summary_map(conn, avatars, &[peer_uid])?;
            summaries.remove(&peer_uid)
        } else {
            None
        }
    } else {
        None
    };

    Ok(GroupInfoResponse {
        id: group.id,
        name: group.name,
        description: group.description,
        avatar_image_id: group.avatar_image_id,
        avatar: avatar_image
            .as_ref()
            .filter(|image| image.deleted_at.is_none())
            .map(|image| media_store.public_url(&image.storage_key)),
        visibility: group.visibility,
        created_at: group.created_at,
        archived,
        muted_until: notification_setting.muted_until,
        mute_override: notification_setting.mute_override,
        is_muted: notification_setting.is_muted(group.kind, defaults, Utc::now()),
        membership_message_policy: crate::dto::groups::MembershipMessagePolicy {
            visibility: group.membership_message_visibility,
            can_view: group.kind == GroupKind::Dm
                || group.membership_message_visibility.allows(my_role.as_ref()),
        },
        speaking_mode: group.speaking_mode,
        my_speaking_mode,
        effective_speaking_mode: my_role.as_ref().zip(my_speaking_mode).map(|(role, mode)| {
            crate::services::speaking::effective_mode(role, group.speaking_mode, mode)
        }),
        my_role,
        kind: group.kind,
        peer,
    })
}

pub async fn post_group(
    uid: i32,
    body: CreateChatBody,
    conn: &mut PgConnection,
    authz_service: &AuthorizationService,
    id_gen: &Arc<IdGen>,
) -> Result<CreateChatResponse, AppError> {
    authz_service.require_permission(conn, uid, AuthzAction::ChatCreate, AuthzResource::Global)?;

    let id = ids::next_gid(id_gen).await.map_err(|error| {
        tracing::error!("ferroid next_gid: {:?}", error);
        AppError::Internal("ID generation failed")
    })?;
    let now = Utc::now();
    let name = body
        .name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_default();

    diesel::insert_into(groups::table)
        .values(&NewGroup {
            id,
            name: name.clone(),
            description: None,
            avatar_image_id: None,
            created_at: now,
            visibility: GroupVisibility::Public,
            kind: GroupKind::Group,
            dm_uid1: None,
            dm_uid2: None,
        })
        .execute(conn)?;
    diesel::insert_into(group_membership::table)
        .values(&NewGroupMembership {
            chat_id: id,
            uid,
            role: GroupRole::Admin,
            joined_at: now,
            join_reason: GroupJoinReason::Creator,
            join_reason_extra: None,
            last_read_message_id: None,
        })
        .execute(conn)?;

    Ok(CreateChatResponse {
        id,
        name: (!name.is_empty()).then_some(name),
        created_at: now,
    })
}

pub async fn get_groups(
    uid: i32,
    query: ListGroupsQuery,
    conn: &mut PgConnection,
    media_store: &MediaStore,
) -> Result<ListGroupsResponse, AppError> {
    let limit = validate_limit(query.limit, MAX_GROUP_SELECTOR_LIMIT);
    let scope = query.scope.unwrap_or(GroupSelectorScope::Joined);
    let search = parse_group_search_query(
        query.q.as_deref(),
        query.mode.unwrap_or(GroupSearchMode::Autocomplete),
    );

    type Row = (
        i64,
        String,
        Option<String>,
        Option<String>,
        GroupVisibility,
        Option<GroupRole>,
    );
    let mut query_builder = groups::table
        .left_join(
            media::table.on(groups::avatar_image_id
                .eq(media::id.nullable())
                .and(media::deleted_at.is_null())),
        )
        .left_join(
            group_membership::table.on(group_membership::chat_id
                .eq(groups::id)
                .and(group_membership::uid.eq(uid))),
        )
        .select((
            groups::id,
            groups::name,
            groups::description,
            media::storage_key.nullable(),
            groups::visibility,
            group_membership::role.nullable(),
        ))
        .into_boxed();

    query_builder = query_builder.filter(groups::kind.eq(GroupKind::Group));
    query_builder = match scope {
        GroupSelectorScope::Joined => query_builder
            .filter(groups::id.eq_any(crate::services::chat_access::accessible_chat_ids(uid))),
        GroupSelectorScope::Manageable => {
            query_builder.filter(group_membership::role.eq(GroupRole::Admin))
        }
        GroupSelectorScope::Public => {
            query_builder.filter(groups::visibility.eq(GroupVisibility::Public))
        }
    };
    if let Some(after) = query.after {
        query_builder = query_builder.filter(groups::id.gt(after));
    }
    if let Some(search) = search {
        let filter = groups::name.ilike(search.pattern);
        query_builder = match search.exact_id {
            Some(exact_id) => query_builder.filter(filter.or(groups::id.eq(exact_id))),
            None => query_builder.filter(filter),
        };
    }

    let rows: Vec<Row> = query_builder
        .order_by(groups::id.asc())
        .limit(limit + 1)
        .load(conn)?;
    let has_more = rows.len() as i64 > limit;
    let page_rows: Vec<Row> = rows.into_iter().take(limit as usize).collect();
    let next_cursor = has_more
        .then(|| page_rows.last().map(|(id, _, _, _, _, _)| *id))
        .flatten();

    Ok(ListGroupsResponse {
        groups: page_rows
            .into_iter()
            .map(
                |(id, name, description, avatar_key, visibility, role)| GroupSelectorItem {
                    id,
                    name,
                    description,
                    avatar: avatar_key.map(|key| media_store.public_url(&key)),
                    visibility,
                    role,
                },
            )
            .collect(),
        next_cursor,
    })
}

pub async fn get_group(
    uid: i32,
    chat_id: i64,
    conn: &mut PgConnection,
    media_store: &MediaStore,
    avatars: &AvatarService,
) -> Result<GroupInfoResponse, AppError> {
    check_membership(conn, chat_id, uid)?;
    load_group_info(conn, media_store, avatars, chat_id, uid)
}

pub async fn post_avatar_upload_url(
    uid: i32,
    chat_id: i64,
    payload: AvatarUploadUrlRequest,
    conn: &mut PgConnection,
    id_gen: &Arc<IdGen>,
    media_store: &MediaStore,
) -> Result<AvatarUploadUrlResponse, AppError> {
    if !payload.content_type.starts_with("image/") {
        return Err(AppError::BadRequest("Avatar uploads must be images"));
    }
    if payload.size <= 0 || payload.size > MAX_GROUP_AVATAR_BYTES {
        return Err(AppError::BadRequest("Avatar size is invalid"));
    }
    require_admin_role(conn, chat_id, uid)?;

    let id = ids::next_message_id(id_gen).await.map_err(|error| {
        tracing::error!("next_message_id for group avatar: {:?}", error);
        AppError::Internal("Failed to generate ID")
    })?;
    let s3_item_id = uuid::Uuid::new_v4().to_string();
    let storage_key = media_store.attachment_key(&payload.filename, &s3_item_id);
    let presigned_upload = media_store
        .presign_upload(
            &storage_key,
            &payload.content_type,
            payload.size,
            None,
            chrono::Duration::minutes(15),
        )
        .await?;

    diesel::insert_into(media::table)
        .values(&NewMedia {
            id,
            content_type: payload.content_type,
            storage_key,
            size: payload.size,
            created_at: Utc::now(),
            deleted_at: None,
            file_name: payload.filename,
            width: payload.width,
            height: payload.height,
            purpose: MediaPurpose::Avatar,
            reference: Some(chat_id.to_string()),
        })
        .execute(conn)?;

    Ok(AvatarUploadUrlResponse {
        image_id: id.to_string(),
        upload_url: presigned_upload.upload_url,
        upload_headers: presigned_upload.upload_headers,
    })
}

pub async fn patch_group(
    uid: i32,
    chat_id: i64,
    body: UpdateChatBody,
    conn: &mut PgConnection,
    media_store: &MediaStore,
    avatars: &AvatarService,
    ws_registry: &ConnectionRegistry,
) -> Result<GroupInfoResponse, AppError> {
    require_admin_role(conn, chat_id, uid)?;
    let current_group: crate::models::Group = groups::table
        .filter(groups::id.eq(chat_id))
        .select(crate::models::Group::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Chat not found"))?;
    if body.membership_message_visibility.is_some() && current_group.kind != GroupKind::Group {
        return Err(AppError::BadRequest(
            "Membership message visibility is only available for groups",
        ));
    }
    if let Some(Some(image_id)) = body.avatar_image_id {
        let owned_image_exists = media::table
            .filter(
                media::id
                    .eq(image_id)
                    .and(media::purpose.eq(MediaPurpose::Avatar))
                    .and(media::deleted_at.is_null()),
            )
            .count()
            .get_result::<i64>(conn)?;
        if owned_image_exists == 0 {
            return Err(AppError::BadRequest("Invalid avatar image"));
        }
    }

    use crate::schema::groups::dsl as groups_dsl;
    let changeset = UpdateGroup {
        name: body.name,
        description: body.description,
        visibility: body.visibility,
    };
    let has_metadata_changes = changeset.name.is_some()
        || changeset.description.is_some()
        || changeset.visibility.is_some();
    conn.transaction::<_, diesel::result::Error, _>(|conn| {
        if let Some(visibility) = body.membership_message_visibility {
            diesel::update(groups::table.find(chat_id))
                .set(groups::membership_message_visibility.eq(visibility))
                .execute(conn)?;
        }
        if has_metadata_changes {
            diesel::update(groups::table.filter(groups_dsl::id.eq(chat_id)))
                .set(&changeset)
                .execute(conn)?;
        }
        if let Some(next_avatar_image_id) = body.avatar_image_id {
            diesel::update(groups::table.filter(groups_dsl::id.eq(chat_id)))
                .set(groups_dsl::avatar_image_id.eq(next_avatar_image_id))
                .execute(conn)?;
            if let Some(previous_avatar_image_id) = current_group.avatar_image_id {
                if Some(previous_avatar_image_id) != next_avatar_image_id {
                    diesel::update(media::table.filter(media::id.eq(previous_avatar_image_id)))
                        .set(media::deleted_at.eq(Some(Utc::now())))
                        .execute(conn)?;
                }
            }
        }
        Ok(())
    })?;

    if body.membership_message_visibility.is_some() {
        crate::services::system_messages::broadcast_policy(conn, ws_registry, chat_id)?;
    }
    load_group_info(conn, media_store, avatars, chat_id, uid)
}

pub async fn put_mute(
    uid: i32,
    chat_id: i64,
    body: MuteBody,
    conn: &mut PgConnection,
    ws_registry: &ConnectionRegistry,
) -> Result<MuteResponse, AppError> {
    check_membership(conn, chat_id, uid)?;
    let _update = crate::services::notification_preferences::lock_notification_update(uid);
    let setting = conn.transaction::<_, AppError, _>(|conn| {
        update_chat_notification_setting(
            conn,
            chat_id,
            uid,
            ChatNotificationCommand::LegacyMute {
                duration_seconds: body.duration_seconds,
            },
            Utc::now(),
        )?;
        load_chat_notification_setting(conn, chat_id, uid)
    })?;
    let muted_until = setting
        .muted_until
        .expect("legacy mute always writes an expiry or permanent timestamp");
    publish_chat_notification_setting(ws_registry, uid, setting);
    Ok(MuteResponse { muted_until })
}

pub async fn delete_mute(
    uid: i32,
    chat_id: i64,
    conn: &mut PgConnection,
    ws_registry: &ConnectionRegistry,
) -> Result<(), AppError> {
    check_membership(conn, chat_id, uid)?;
    let _update = crate::services::notification_preferences::lock_notification_update(uid);
    let setting = conn.transaction::<_, AppError, _>(|conn| {
        update_chat_notification_setting(
            conn,
            chat_id,
            uid,
            ChatNotificationCommand::LegacyUnmuteAndUnarchive,
            Utc::now(),
        )?;
        load_chat_notification_setting(conn, chat_id, uid)
    })?;
    publish_chat_notification_setting(ws_registry, uid, setting);
    Ok(())
}

pub async fn put_notification_setting(
    uid: i32,
    chat_id: i64,
    body: UpdateNotificationSettingRequest,
    conn: &mut PgConnection,
    ws_registry: &ConnectionRegistry,
) -> Result<ChatNotificationSettingResponse, AppError> {
    check_membership(conn, chat_id, uid)?;
    let _update = crate::services::notification_preferences::lock_notification_update(uid);
    let command = body.try_into()?;
    let setting = conn.transaction::<_, AppError, _>(|conn| {
        update_chat_notification_setting(conn, chat_id, uid, command, Utc::now())?;
        load_chat_notification_setting(conn, chat_id, uid)
    })?;
    publish_chat_notification_setting(ws_registry, uid, setting.clone());
    Ok(setting)
}

pub async fn put_speaking_mode(
    uid: i32,
    chat_id: i64,
    body: UpdateSpeakingModeRequest,
    conn: &mut PgConnection,
    ws_registry: &ConnectionRegistry,
) -> Result<GroupSpeakingModeResponse, AppError> {
    let updated =
        crate::services::speaking::update_group_mode(conn, chat_id, uid, body.speaking_mode)?;
    crate::services::speaking::broadcast_group_mode(conn, ws_registry, chat_id)?;
    Ok(updated)
}
