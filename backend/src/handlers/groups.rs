use axum::{
    extract::{Json, Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::PgConnection;
use diesel::PgTextExpressionMethods;
use utoipa_axum::router::OpenApiRouter;

use crate::dto::groups::{
    AvatarUploadUrlResponse, CreateChatResponse, GroupInfoResponse, GroupSelectorItem,
    ListGroupsResponse, MuteResponse,
};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::handlers::members::{check_membership, require_admin_role};
use crate::models::{
    GroupJoinReason, GroupRole, GroupVisibility, Media, MediaPurpose, NewGroup, NewGroupMembership,
    NewMedia, UpdateGroup,
};
use crate::schema::{group_membership, groups, media};
use crate::services::authz::{Action as AuthzAction, Resource as AuthzResource};
use crate::services::media::{build_public_object_url, build_storage_key, presign_public_upload};
use crate::utils::ids;
use crate::utils::{auth::CurrentUid, pagination::validate_limit};
use crate::AppState;

/// Maximum mute duration: 7 days in seconds.
const MAX_MUTE_DURATION_SECS: i64 = 7 * 24 * 3600;
const MAX_GROUP_AVATAR_BYTES: i64 = 10 * 1024 * 1024;
const MAX_GROUP_SELECTOR_LIMIT: i64 = 50;

/// Far-future date used for "mute indefinitely".
fn indefinite_mute_until() -> DateTime<Utc> {
    crate::services::chat::indefinite_mute_until()
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct CreateChatBody {
    name: Option<String>,
}

#[derive(serde::Deserialize)]
pub(super) struct ChatIdPath {
    pub(super) chat_id: i64,
}

#[derive(Debug, Clone, Copy, serde::Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
enum GroupSearchMode {
    Autocomplete,
    Submitted,
}

#[derive(Debug, Clone, Copy, serde::Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
enum GroupSelectorScope {
    Manageable,
    Joined,
    Public,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct ListGroupsQuery {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    mode: Option<GroupSearchMode>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    after: Option<i64>,
    #[serde(default)]
    scope: Option<GroupSelectorScope>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedGroupSearch {
    pattern: String,
    exact_id: Option<i64>,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpdateChatBody {
    name: Option<String>,
    description: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::double_opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    avatar_image_id: Option<Option<i64>>,
    visibility: Option<GroupVisibility>,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct AvatarUploadUrlRequest {
    filename: String,
    content_type: String,
    size: i64,
    width: Option<i32>,
    height: Option<i32>,
}

#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct MuteBody {
    /// Duration in seconds, or null/absent for indefinite mute.
    duration_seconds: Option<i64>,
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

pub(super) fn load_requester_group_role(
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

pub(super) fn load_group_info(
    conn: &mut PgConnection,
    state: &AppState,
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

    let muted_until: Option<DateTime<Utc>> = group_membership::table
        .filter(
            group_membership::chat_id
                .eq(chat_id)
                .and(group_membership::uid.eq(requester_uid)),
        )
        .select(group_membership::muted_until)
        .first(conn)
        .optional()?
        .flatten();

    Ok(GroupInfoResponse {
        id: group.id,
        name: group.name,
        description: group.description,
        avatar_image_id: group.avatar_image_id,
        avatar: avatar_image
            .as_ref()
            .filter(|image| image.deleted_at.is_none())
            .map(|image| build_public_object_url(state, &image.storage_key)),
        visibility: group.visibility,
        created_at: group.created_at,
        muted_until,
        my_role,
    })
}

/// POST /group — Create a new chat.
#[utoipa::path(
    post,
    path = "/",
    tag = "groups",
    request_body = CreateChatBody,
    responses(
        (status = CREATED, body = CreateChatResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn post_group(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<CreateChatBody>,
) -> Result<impl IntoResponse, AppError> {
    let conn = &mut *conn;

    state.authz_service.require_permission(
        conn,
        uid,
        AuthzAction::ChatCreate,
        AuthzResource::Global,
    )?;

    let id = ids::next_gid(state.id_gen.as_ref()).await.map_err(|e| {
        tracing::error!("ferroid next_gid: {:?}", e);
        AppError::Internal("ID generation failed")
    })?;

    let now = Utc::now();
    let name = body
        .name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(String::new);

    diesel::insert_into(groups::table)
        .values(&NewGroup {
            id,
            name: name.clone(),
            description: None,
            avatar_image_id: None,
            created_at: now,
            visibility: GroupVisibility::Public,
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

    Ok((
        StatusCode::CREATED,
        Json(CreateChatResponse {
            id,
            name: if name.is_empty() { None } else { Some(name) },
            created_at: now,
        }),
    ))
}

/// GET /group — List groups for selector/search.
#[utoipa::path(
    get,
    path = "/",
    tag = "groups",
    params(
        ("q" = Option<String>, Query, description = "Search query"),
        ("mode" = Option<GroupSearchMode>, Query, description = "Search mode"),
        ("limit" = Option<i64>, Query, description = "Page size limit"),
        ("after" = Option<String>, Query, description = "Cursor for pagination"),
        ("scope" = Option<GroupSelectorScope>, Query, description = "Group scope filter"),
    ),
    responses(
        (status = OK, body = ListGroupsResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn get_groups(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(q): Query<ListGroupsQuery>,
) -> Result<Json<ListGroupsResponse>, AppError> {
    let conn = &mut *conn;

    let limit = validate_limit(q.limit, MAX_GROUP_SELECTOR_LIMIT);
    let scope = q.scope.unwrap_or(GroupSelectorScope::Joined);
    let search = parse_group_search_query(
        q.q.as_deref(),
        q.mode.unwrap_or(GroupSearchMode::Autocomplete),
    );

    type Row = (
        i64,
        String,
        Option<String>,
        Option<String>,
        GroupVisibility,
        Option<GroupRole>,
    );

    let mut query = groups::table
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

    query = match scope {
        GroupSelectorScope::Joined => query.filter(group_membership::uid.is_not_null()),
        GroupSelectorScope::Manageable => query.filter(group_membership::role.eq(GroupRole::Admin)),
        GroupSelectorScope::Public => query.filter(groups::visibility.eq(GroupVisibility::Public)),
    };

    if let Some(after) = q.after {
        query = query.filter(groups::id.gt(after));
    }

    if let Some(search) = search {
        let filter = groups::name.ilike(search.pattern);
        query = match search.exact_id {
            Some(exact_id) => query.filter(filter.or(groups::id.eq(exact_id))),
            None => query.filter(filter),
        };
    }

    let rows: Vec<Row> = query
        .order_by(groups::id.asc())
        .limit(limit + 1)
        .load(conn)?;

    let has_more = rows.len() as i64 > limit;
    let page_rows: Vec<Row> = rows.into_iter().take(limit as usize).collect();
    let next_cursor = has_more
        .then(|| page_rows.last().map(|(id, _, _, _, _, _)| *id))
        .flatten();

    let groups = page_rows
        .into_iter()
        .map(
            |(id, name, description, avatar_key, visibility, role)| GroupSelectorItem {
                id,
                name,
                description,
                avatar: avatar_key.map(|key| build_public_object_url(&state, &key)),
                visibility,
                role,
            },
        )
        .collect();

    Ok(Json(ListGroupsResponse {
        groups,
        next_cursor,
    }))
}

/// GET /group/:chat_id — Get chat details.
#[utoipa::path(
    get,
    path = "/{chat_id}",
    tag = "groups",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    responses(
        (status = OK, body = GroupInfoResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn get_group(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
) -> Result<Json<GroupInfoResponse>, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    Ok(Json(load_group_info(conn, &state, chat_id, uid)?))
}

/// POST /group/:chat_id/avatar/upload-url — Create a group avatar upload URL.
#[utoipa::path(
    post,
    path = "/{chat_id}/avatar/upload-url",
    tag = "groups",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    request_body = AvatarUploadUrlRequest,
    responses(
        (status = CREATED, body = AvatarUploadUrlResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn post_avatar_upload_url(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Json(payload): Json<AvatarUploadUrlRequest>,
) -> Result<impl IntoResponse, AppError> {
    let conn = &mut *conn;

    if !payload.content_type.starts_with("image/") {
        return Err(AppError::BadRequest("Avatar uploads must be images"));
    }
    if payload.size <= 0 || payload.size > MAX_GROUP_AVATAR_BYTES {
        return Err(AppError::BadRequest("Avatar size is invalid"));
    }
    require_admin_role(conn, chat_id, uid)?;

    let id = ids::next_message_id(state.id_gen.as_ref())
        .await
        .map_err(|e| {
            tracing::error!("next_message_id for group avatar: {:?}", e);
            AppError::Internal("Failed to generate ID")
        })?;

    let s3_item_id = uuid::Uuid::new_v4().to_string();
    let storage_key =
        build_storage_key(&state.s3_attachment_prefix, &payload.filename, &s3_item_id);
    let presigned_upload = presign_public_upload(
        &state.s3_client,
        &state.s3_bucket_name,
        &storage_key,
        &payload.content_type,
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

    Ok((
        StatusCode::CREATED,
        Json(AvatarUploadUrlResponse {
            image_id: id.to_string(),
            upload_url: presigned_upload.upload_url,
            upload_headers: presigned_upload.upload_headers,
        }),
    ))
}

/// PATCH /group/:chat_id — Update chat metadata (admin only).
#[utoipa::path(
    patch,
    path = "/{chat_id}",
    tag = "groups",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    request_body = UpdateChatBody,
    responses(
        (status = OK, body = GroupInfoResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn patch_group(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Json(body): Json<UpdateChatBody>,
) -> Result<Json<GroupInfoResponse>, AppError> {
    let conn = &mut *conn;

    require_admin_role(conn, chat_id, uid)?;

    let current_group: crate::models::Group = groups::table
        .filter(groups::id.eq(chat_id))
        .select(crate::models::Group::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Chat not found"))?;

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

    Ok(Json(load_group_info(conn, &state, chat_id, uid)?))
}

/// PUT /group/:chat_id/mute — Mute notifications for a chat.
#[utoipa::path(
    put,
    path = "/{chat_id}/mute",
    tag = "groups",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    request_body = MuteBody,
    responses(
        (status = OK, body = MuteResponse),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn put_mute(
    CurrentUid(uid): CurrentUid,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
    Json(body): Json<MuteBody>,
) -> Result<Json<MuteResponse>, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    let muted_until = match body.duration_seconds {
        Some(secs) if secs > 0 && secs <= MAX_MUTE_DURATION_SECS => {
            Utc::now() + chrono::Duration::seconds(secs)
        }
        Some(secs) if secs > MAX_MUTE_DURATION_SECS => {
            return Err(AppError::BadRequest("Duration exceeds 7 day maximum"));
        }
        _ => indefinite_mute_until(),
    };

    use crate::schema::group_membership::dsl as gm_dsl;
    diesel::update(
        group_membership::table.filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(uid))),
    )
    .set(gm_dsl::muted_until.eq(muted_until))
    .execute(conn)?;

    Ok(Json(MuteResponse { muted_until }))
}

/// DELETE /group/:chat_id/mute — Unmute notifications for a chat.
#[utoipa::path(
    delete,
    path = "/{chat_id}/mute",
    tag = "groups",
    params(
        ("chat_id" = i64, Path, description = "Chat ID"),
    ),
    responses(
        (status = NO_CONTENT),
    ),
    security(("uid_header" = []), ("bearer_jwt" = [])),
)]
async fn delete_mute(
    CurrentUid(uid): CurrentUid,
    Path(ChatIdPath { chat_id }): Path<ChatIdPath>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;

    check_membership(conn, chat_id, uid)?;

    use crate::schema::group_membership::dsl as gm_dsl;
    diesel::update(
        group_membership::table.filter(gm_dsl::chat_id.eq(chat_id).and(gm_dsl::uid.eq(uid))),
    )
    .set((
        gm_dsl::muted_until.eq(None::<DateTime<Utc>>),
        gm_dsl::archived.eq(false),
    ))
    .execute(conn)?;

    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(utoipa_axum::routes!(get_groups, post_group))
        .routes(utoipa_axum::routes!(get_group, patch_group))
        .routes(utoipa_axum::routes!(post_avatar_upload_url))
        .routes(utoipa_axum::routes!(put_mute, delete_mute))
        .nest("/{chat_id}/members", crate::handlers::members::router())
}
