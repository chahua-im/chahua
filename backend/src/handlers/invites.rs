use axum::{
    extract::{Json, Path, Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use serde::Deserialize;
use serde_json::json;
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use diesel::PgConnection;

use crate::dto::invites::{
    InvitePreviewResponse, InviteResponse, ListInvitesResponse, RedeemInviteResponse,
    SendInviteMessageResponse,
};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::handlers::chats::{send_prepared_message, PreparedMessageSend, SendMessageOutcome};
use crate::handlers::groups::load_group_info;
use crate::handlers::members::{check_membership, require_admin_role};
use crate::models::{
    GroupJoinReason, GroupRole, Invite, InviteType, MessageType, NewGroupMembership,
};
use crate::schema::{group_membership, invites};
use crate::services::invites as invite_service;
use crate::utils::auth::CurrentUid;
use crate::AppState;

const DEFAULT_INVITES_LIMIT: i64 = 100;
const MAX_INVITES_LIMIT: i64 = 100;
const INVALID_INVITE_CODE_MESSAGE: &str = "Invalid invite code";
const INVALID_INVITE_MESSAGE: &str = "Invalid invite";

#[derive(Deserialize)]
struct InviteIdPath {
    invite_id: i64,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct CreateInviteBody {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    #[schema(value_type = String)]
    chat_id: i64,
    invite_type: InviteType,
    target_uid: Option<i32>,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    required_chat_id: Option<i64>,
    expires_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize, ToSchema, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
struct ListInvitesQuery {
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    group_id: Option<i64>,
    limit: Option<i64>,
}

#[derive(Deserialize, ToSchema, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
struct GetInviteByCodeQuery {
    invite_code: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct PatchInviteBody {
    #[serde(default, deserialize_with = "double_opt_datetime::deserialize")]
    #[schema(value_type = Option<String>)]
    expires_at: Option<Option<DateTime<Utc>>>,
}

#[derive(Deserialize, ToSchema)]
struct RedeemInviteBody {
    code: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct SendInviteMessageBody {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    #[schema(value_type = String)]
    source_chat_id: i64,
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    #[schema(value_type = String)]
    destination_chat_id: i64,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    invite_id: Option<i64>,
    expires_at: Option<DateTime<Utc>>,
    client_generated_id: String,
}

enum RedeemInviteError {
    InvalidCode,
    Db(diesel::result::Error),
}

enum PreviewInviteError {
    InvalidCode,
    Forbidden,
    Db(diesel::result::Error),
}

enum PreviewEligibility {
    Eligible,
    AlreadyMember,
}

enum RedeemInviteOutcome {
    Joined(i64),
    AlreadyMember,
}

impl From<diesel::result::Error> for RedeemInviteError {
    fn from(error: diesel::result::Error) -> Self {
        Self::Db(error)
    }
}

impl From<diesel::result::Error> for PreviewInviteError {
    fn from(error: diesel::result::Error) -> Self {
        Self::Db(error)
    }
}

mod double_opt_datetime {
    use chrono::{DateTime, Utc};
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<Option<DateTime<Utc>>>, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum DateTimeOrNull {
            DateTime(DateTime<Utc>),
            Null,
        }

        let v = Option::<DateTimeOrNull>::deserialize(deserializer)?;
        match v {
            None => Ok(None),
            Some(DateTimeOrNull::Null) => Ok(Some(None)),
            Some(DateTimeOrNull::DateTime(value)) => Ok(Some(Some(value))),
        }
    }
}

fn invite_limit(limit: Option<i64>) -> i64 {
    limit
        .unwrap_or(DEFAULT_INVITES_LIMIT)
        .clamp(1, MAX_INVITES_LIMIT)
}

fn validate_create_body(body: &CreateInviteBody) -> Result<(), AppError> {
    match body.invite_type {
        InviteType::Generic => {
            if body.target_uid.is_some() || body.required_chat_id.is_some() {
                return Err(AppError::BadRequest(
                    "Generic invites cannot have target_uid or required_chat_id",
                ));
            }
        }
        InviteType::Targeted => {
            if body.target_uid.is_none() || body.required_chat_id.is_some() {
                return Err(AppError::BadRequest(
                    "Targeted invites require target_uid and cannot have required_chat_id",
                ));
            }
        }
        InviteType::Membership => {
            if body.target_uid.is_some() || body.required_chat_id.is_none() {
                return Err(AppError::BadRequest(
                    "Membership invites require required_chat_id and cannot have target_uid",
                ));
            }
        }
    }

    Ok(())
}

fn load_invite_by_id(conn: &mut PgConnection, invite_id: i64) -> Result<Invite, AppError> {
    invites::table
        .filter(invites::id.eq(invite_id))
        .select(Invite::as_select())
        .first::<Invite>(conn)
        .optional()?
        .ok_or(AppError::BadRequest(INVALID_INVITE_MESSAGE))
}

fn validate_invite_is_active(invite: &Invite, now: DateTime<Utc>) -> bool {
    invite_service::validate_invite_is_active(invite, now)
}

async fn create_invite_from_body(
    conn: &mut PgConnection,
    state: &AppState,
    uid: i32,
    body: &CreateInviteBody,
) -> Result<Invite, AppError> {
    invite_service::create_invite(
        conn,
        state,
        invite_service::NewInviteInput {
            chat_id: body.chat_id,
            invite_type: body.invite_type.clone(),
            creator_uid: Some(uid),
            target_uid: body.target_uid,
            required_chat_id: body.required_chat_id,
            expires_at: body.expires_at,
        },
    )
    .await
}

fn preview_eligibility(
    conn: &mut PgConnection,
    invite: &Invite,
    uid: i32,
) -> Result<PreviewEligibility, PreviewInviteError> {
    let already_member = group_membership::table
        .filter(
            group_membership::chat_id
                .eq(invite.chat_id)
                .and(group_membership::uid.eq(uid)),
        )
        .count()
        .get_result::<i64>(conn)?;

    if already_member > 0 {
        return Ok(PreviewEligibility::AlreadyMember);
    }

    match invite.invite_type {
        InviteType::Generic => Ok(PreviewEligibility::Eligible),
        InviteType::Targeted => {
            if invite.target_uid == Some(uid) && invite.used_at.is_none() {
                Ok(PreviewEligibility::Eligible)
            } else {
                Err(PreviewInviteError::Forbidden)
            }
        }
        InviteType::Membership => {
            let required_chat_id = invite
                .required_chat_id
                .ok_or(PreviewInviteError::InvalidCode)?;
            let has_required_membership = group_membership::table
                .filter(
                    group_membership::chat_id
                        .eq(required_chat_id)
                        .and(group_membership::uid.eq(uid)),
                )
                .count()
                .get_result::<i64>(conn)?;

            if has_required_membership > 0 {
                Ok(PreviewEligibility::Eligible)
            } else {
                Err(PreviewInviteError::Forbidden)
            }
        }
    }
}

#[utoipa::path(
    post,
    path = "/",
    tag = "invites",
    request_body = CreateInviteBody,
    responses(
        (status = 201, description = "Invite created", body = InviteResponse)
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn post_invite(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<CreateInviteBody>,
) -> Result<(StatusCode, Json<InviteResponse>), AppError> {
    let conn = &mut *conn;

    validate_create_body(&body)?;

    require_admin_role(conn, body.chat_id, uid)?;
    let invite = create_invite_from_body(conn, &state, uid, &body).await?;

    Ok((
        StatusCode::CREATED,
        Json(invite_service::invite_to_response(invite)),
    ))
}

#[utoipa::path(
    post,
    path = "/send",
    tag = "invites",
    request_body = SendInviteMessageBody,
    responses(
        (status = 201, description = "Invite message sent", body = SendInviteMessageResponse)
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn post_send_invite_message(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<SendInviteMessageBody>,
) -> Result<(StatusCode, Json<SendInviteMessageResponse>), AppError> {
    let conn = &mut *conn;

    require_admin_role(conn, body.source_chat_id, uid)?;
    check_membership(conn, body.destination_chat_id, uid)?;

    let now = Utc::now();
    let invite = if let Some(invite_id) = body.invite_id {
        let invite = load_invite_by_id(conn, invite_id)?;
        require_admin_role(conn, invite.chat_id, uid)?;
        if invite.chat_id != body.source_chat_id {
            return Err(AppError::BadRequest(
                "Invite does not belong to source chat",
            ));
        }
        if !validate_invite_is_active(&invite, now) {
            return Err(AppError::BadRequest("Invite is no longer active"));
        }
        invite
    } else {
        invite_service::create_generic_invite(
            conn,
            &state,
            body.source_chat_id,
            uid,
            body.expires_at,
        )
        .await?
    };

    let send_result = send_prepared_message(
        conn,
        &state,
        PreparedMessageSend {
            chat_id: body.destination_chat_id,
            sender_uid: uid,
            message: Some(invite.code.clone()),
            message_type: MessageType::Invite,
            sticker_id: None,
            reply_to_id: None,
            reply_root_id: None,
            client_generated_id: body.client_generated_id,
            attachment_ids: vec![],
            publish_immediately: true,
        },
    )
    .await?;
    let message = match send_result {
        SendMessageOutcome::Created(send_result) => {
            let send_result = *send_result;
            send_result.side_effects.fire(&state);
            send_result.response
        }
        SendMessageOutcome::Duplicate(response) => *response,
    };

    Ok((
        StatusCode::CREATED,
        Json(SendInviteMessageResponse {
            invite: invite_service::invite_to_response(invite),
            message,
        }),
    ))
}

#[utoipa::path(
    get,
    path = "/",
    tag = "invites",
    params(ListInvitesQuery),
    responses(
        (status = 200, description = "List of invites", body = ListInvitesResponse)
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn get_invites(
    CurrentUid(uid): CurrentUid,
    mut conn: DbConn,
    Query(query): Query<ListInvitesQuery>,
) -> Result<Json<ListInvitesResponse>, AppError> {
    let conn = &mut *conn;

    let mut base_query = invites::table
        .into_boxed()
        .order((invites::created_at.desc(), invites::id.desc()))
        .limit(invite_limit(query.limit));

    if let Some(group_id) = query.group_id {
        require_admin_role(conn, group_id, uid)?;
        base_query = base_query.filter(invites::chat_id.eq(group_id));
    } else {
        base_query = base_query.filter(invites::creator_uid.eq(Some(uid)));
    }

    let rows = base_query
        .select(Invite::as_select())
        .load::<Invite>(conn)?;

    Ok(Json(ListInvitesResponse {
        invites: rows
            .into_iter()
            .map(invite_service::invite_to_response)
            .collect(),
    }))
}

#[utoipa::path(
    get,
    path = "/invite/{invite_id}",
    tag = "invites",
    params(
        ("invite_id" = i64, Path, description = "Invite ID")
    ),
    responses(
        (status = 200, description = "Invite details", body = InviteResponse)
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn get_invite(
    CurrentUid(uid): CurrentUid,
    Path(InviteIdPath { invite_id }): Path<InviteIdPath>,
    mut conn: DbConn,
) -> Result<Json<InviteResponse>, AppError> {
    let conn = &mut *conn;

    let invite = load_invite_by_id(conn, invite_id)?;
    require_admin_role(conn, invite.chat_id, uid)?;

    Ok(Json(invite_service::invite_to_response(invite)))
}

#[utoipa::path(
    get,
    path = "/invite",
    tag = "invites",
    params(GetInviteByCodeQuery),
    responses(
        (status = 200, description = "Invite preview", body = InvitePreviewResponse)
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn get_invite_by_code(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Query(query): Query<GetInviteByCodeQuery>,
) -> Result<Json<InvitePreviewResponse>, AppError> {
    let conn = &mut *conn;

    let invite_code = query.invite_code.trim();
    if invite_code.is_empty() {
        return Err(AppError::BadRequest(INVALID_INVITE_CODE_MESSAGE));
    }

    let invite = invites::table
        .filter(invites::code.eq(invite_code))
        .select(Invite::as_select())
        .first::<Invite>(conn)
        .optional()?
        .ok_or(AppError::BadRequest(INVALID_INVITE_CODE_MESSAGE))?;

    if !validate_invite_is_active(&invite, Utc::now()) {
        return Err(AppError::BadRequest(INVALID_INVITE_CODE_MESSAGE));
    }

    let eligibility = preview_eligibility(conn, &invite, uid).map_err(|error| match error {
        PreviewInviteError::InvalidCode => AppError::BadRequest(INVALID_INVITE_CODE_MESSAGE),
        PreviewInviteError::Forbidden => AppError::Forbidden("Not eligible for this invite"),
        PreviewInviteError::Db(other) => {
            tracing::error!("preview invite eligibility: {:?}", other);
            AppError::Internal("Failed to load invite")
        }
    })?;

    let chat = load_group_info(conn, &state, invite.chat_id, uid)?;

    Ok(Json(InvitePreviewResponse {
        invite: invite_service::invite_to_response(invite),
        chat,
        already_member: matches!(eligibility, PreviewEligibility::AlreadyMember),
    }))
}

#[utoipa::path(
    patch,
    path = "/invite/{invite_id}",
    tag = "invites",
    params(
        ("invite_id" = i64, Path, description = "Invite ID")
    ),
    request_body = PatchInviteBody,
    responses(
        (status = 200, description = "Invite updated", body = InviteResponse)
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn patch_invite(
    CurrentUid(uid): CurrentUid,
    Path(InviteIdPath { invite_id }): Path<InviteIdPath>,
    mut conn: DbConn,
    Json(body): Json<PatchInviteBody>,
) -> Result<Json<InviteResponse>, AppError> {
    let conn = &mut *conn;

    let invite = load_invite_by_id(conn, invite_id)?;
    require_admin_role(conn, invite.chat_id, uid)?;

    let next_expires_at = body
        .expires_at
        .ok_or(AppError::BadRequest("expires_at is required"))?;

    let updated = diesel::update(invites::table.filter(invites::id.eq(invite_id)))
        .set(invites::expires_at.eq(next_expires_at))
        .returning(Invite::as_returning())
        .get_result::<Invite>(conn)?;

    Ok(Json(invite_service::invite_to_response(updated)))
}

#[utoipa::path(
    delete,
    path = "/invite/{invite_id}",
    tag = "invites",
    params(
        ("invite_id" = i64, Path, description = "Invite ID")
    ),
    responses(
        (status = 204, description = "Invite deleted")
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn delete_invite(
    CurrentUid(uid): CurrentUid,
    Path(InviteIdPath { invite_id }): Path<InviteIdPath>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;

    let invite = load_invite_by_id(conn, invite_id)?;
    require_admin_role(conn, invite.chat_id, uid)?;

    diesel::update(invites::table.filter(invites::id.eq(invite_id)))
        .set(invites::revoked_at.eq(Utc::now()))
        .execute(conn)?;

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/redeem",
    tag = "invites",
    request_body = RedeemInviteBody,
    responses(
        (status = 200, description = "Invite redeemed", body = RedeemInviteResponse)
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn post_redeem_invite(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<RedeemInviteBody>,
) -> Result<Json<RedeemInviteResponse>, AppError> {
    let conn = &mut *conn;

    let code = body.code.trim();
    if code.is_empty() {
        return Err(AppError::BadRequest(INVALID_INVITE_CODE_MESSAGE));
    }

    let outcome = conn
        .transaction::<RedeemInviteOutcome, RedeemInviteError, _>(|conn| {
            let invite = invites::table
                .filter(invites::code.eq(code))
                .select(Invite::as_select())
                .first::<Invite>(conn)
                .optional()?
                .ok_or(RedeemInviteError::InvalidCode)?;

            let now = Utc::now();
            if !validate_invite_is_active(&invite, now) {
                return Err(RedeemInviteError::InvalidCode);
            }

            let already_member = group_membership::table
                .filter(
                    group_membership::chat_id
                        .eq(invite.chat_id)
                        .and(group_membership::uid.eq(uid)),
                )
                .count()
                .get_result::<i64>(conn)?;

            if already_member > 0 {
                return Ok(RedeemInviteOutcome::AlreadyMember);
            }

            match invite.invite_type {
                InviteType::Generic => {}
                InviteType::Targeted => {
                    if invite.target_uid != Some(uid) || invite.used_at.is_some() {
                        return Err(RedeemInviteError::InvalidCode);
                    }
                }
                InviteType::Membership => {
                    let required_chat_id = invite
                        .required_chat_id
                        .ok_or(RedeemInviteError::InvalidCode)?;
                    let has_required_membership = group_membership::table
                        .filter(
                            group_membership::chat_id
                                .eq(required_chat_id)
                                .and(group_membership::uid.eq(uid)),
                        )
                        .count()
                        .get_result::<i64>(conn)?;

                    if has_required_membership == 0 {
                        return Err(RedeemInviteError::InvalidCode);
                    }
                }
            }

            let last_message_id: Option<i64> = crate::schema::groups::table
                .filter(crate::schema::groups::id.eq(invite.chat_id))
                .select(crate::schema::groups::last_message_id)
                .first(conn)
                .optional()?
                .flatten();
            match diesel::insert_into(group_membership::table)
                .values(&NewGroupMembership {
                    chat_id: invite.chat_id,
                    uid,
                    role: GroupRole::Member,
                    joined_at: now,
                    join_reason: GroupJoinReason::InviteCode,
                    join_reason_extra: Some(json!({
                        "invite_id": invite.id.to_string(),
                        "code": invite.code,
                        "creator_uid": invite.creator_uid,
                    })),
                    last_read_message_id: last_message_id,
                })
                .execute(conn)
            {
                Ok(_) => {}
                Err(diesel::result::Error::DatabaseError(
                    diesel::result::DatabaseErrorKind::UniqueViolation,
                    _,
                )) => {
                    return Ok(RedeemInviteOutcome::AlreadyMember);
                }
                Err(other) => return Err(RedeemInviteError::Db(other)),
            }

            if invite.invite_type == InviteType::Targeted {
                let updated = diesel::update(
                    invites::table
                        .filter(invites::id.eq(invite.id).and(invites::used_at.is_null())),
                )
                .set(invites::used_at.eq(now))
                .execute(conn)?;

                if updated != 1 {
                    return Err(RedeemInviteError::InvalidCode);
                }
            }

            Ok(RedeemInviteOutcome::Joined(invite.chat_id))
        })
        .map_err(|error| match error {
            RedeemInviteError::InvalidCode => AppError::BadRequest(INVALID_INVITE_CODE_MESSAGE),
            RedeemInviteError::Db(other) => {
                tracing::error!("redeem invite: {:?}", other);
                AppError::Internal("Failed to redeem invite")
            }
        })?;

    let chat_id = match outcome {
        RedeemInviteOutcome::Joined(chat_id) => chat_id,
        RedeemInviteOutcome::AlreadyMember => {
            return Err(AppError::Conflict("Already a member of this chat"));
        }
    };

    if let Ok(SendMessageOutcome::Created(send_result)) =
        crate::handlers::chats::send_prepared_message(
            conn,
            &state,
            crate::handlers::chats::PreparedMessageSend {
                chat_id,
                sender_uid: uid,
                message: Some("joined the chat".to_string()),
                message_type: crate::models::MessageType::System,
                sticker_id: None,
                reply_to_id: None,
                reply_root_id: None,
                client_generated_id: uuid::Uuid::new_v4().to_string(),
                attachment_ids: vec![],
                publish_immediately: true,
            },
        )
        .await
    {
        let send_result = *send_result;
        send_result.side_effects.fire(&state);
    }

    let chat = load_group_info(conn, &state, chat_id, uid)?;
    Ok(Json(RedeemInviteResponse { chat }))
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(routes!(post_invite, get_invites))
        .routes(routes!(post_send_invite_message))
        .routes(routes!(post_redeem_invite))
        .routes(routes!(get_invite_by_code))
        .routes(routes!(get_invite, patch_invite, delete_invite))
}
