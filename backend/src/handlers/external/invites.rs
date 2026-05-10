use axum::{
    extract::{Json, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::PgConnection;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::external::invites::{
    ExternalCreateInviteRequest, ExternalCreateInviteResponse, ExternalInviteChatResponse,
    ExternalInviteMembershipResponse, ExternalInviteStatus,
};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::models::{Group, GroupMembership};
use crate::schema::{group_membership, groups};
use crate::services::authz::{Action as AuthzAction, Resource as AuthzResource};
use crate::services::invites as invite_service;
use crate::utils::auth::{Principal, ServiceTokenPrincipal};
use crate::AppState;

#[utoipa::path(
    post,
    path = "/",
    tag = "external-invites",
    request_body = ExternalCreateInviteRequest,
    responses(
        (status = 200, description = "Existing invite or existing membership", body = ExternalCreateInviteResponse),
        (status = 201, description = "Invite created", body = ExternalCreateInviteResponse)
    ),
    security(("service_token_bearer" = []))
)]
async fn post_external_invite(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<ExternalCreateInviteRequest>,
) -> Result<(StatusCode, Json<ExternalCreateInviteResponse>), AppError> {
    let service_token = require_service_token_principal(principal)?;
    let conn = &mut *conn;
    require_invite_create_permission(conn, &state, service_token.id)?;

    let now = Utc::now();
    validate_request(&body, now)?;

    let chat = load_chat(conn, body.chat_id)?;
    if let Some(membership) = load_membership(conn, body.chat_id, body.target_uid)? {
        return Ok((
            StatusCode::OK,
            Json(ExternalCreateInviteResponse {
                status: ExternalInviteStatus::AlreadyMember,
                invite: None,
                chat: chat_to_response(chat),
                membership: Some(membership_to_response(membership)),
            }),
        ));
    }

    if let Some(invite) =
        invite_service::find_active_targeted_invite(conn, body.chat_id, body.target_uid, now)?
    {
        return Ok((
            StatusCode::OK,
            Json(ExternalCreateInviteResponse {
                status: ExternalInviteStatus::Existing,
                invite: Some(invite_service::invite_to_response(invite)),
                chat: chat_to_response(chat),
                membership: None,
            }),
        ));
    }

    let invite = invite_service::create_targeted_invite(
        conn,
        &state,
        body.chat_id,
        body.target_uid,
        None,
        body.expires_at,
    )
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(ExternalCreateInviteResponse {
            status: ExternalInviteStatus::Created,
            invite: Some(invite_service::invite_to_response(invite)),
            chat: chat_to_response(chat),
            membership: None,
        }),
    ))
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new().routes(routes!(post_external_invite))
}

fn require_service_token_principal(
    principal: Principal,
) -> Result<ServiceTokenPrincipal, AppError> {
    match principal {
        Principal::ServiceToken(service_token) => Ok(service_token),
        Principal::User(_) => Err(AppError::Forbidden("Service token required")),
    }
}

fn require_invite_create_permission(
    conn: &mut PgConnection,
    state: &AppState,
    service_token_id: i64,
) -> Result<(), AppError> {
    let can_create = state.authz_service.has_service_token_permission(
        conn,
        service_token_id,
        AuthzAction::InviteCreate,
        AuthzResource::Global,
    )? || state.authz_service.has_service_token_permission(
        conn,
        service_token_id,
        AuthzAction::PermissionAll,
        AuthzResource::Global,
    )?;

    if can_create {
        Ok(())
    } else {
        Err(AppError::Forbidden("Permission required"))
    }
}

fn validate_request(
    body: &ExternalCreateInviteRequest,
    now: DateTime<Utc>,
) -> Result<(), AppError> {
    if body.target_uid <= 0 {
        return Err(AppError::BadRequest("targetUid is invalid"));
    }

    if let Some(expires_at) = body.expires_at {
        if expires_at <= now {
            return Err(AppError::BadRequest("expiresAt must be in the future"));
        }
    }

    Ok(())
}

fn load_chat(conn: &mut PgConnection, chat_id: i64) -> Result<Group, AppError> {
    groups::table
        .filter(groups::id.eq(chat_id))
        .select(Group::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Chat not found"))
}

fn load_membership(
    conn: &mut PgConnection,
    chat_id: i64,
    target_uid: i32,
) -> Result<Option<GroupMembership>, AppError> {
    Ok(group_membership::table
        .filter(
            group_membership::chat_id
                .eq(chat_id)
                .and(group_membership::uid.eq(target_uid)),
        )
        .select(GroupMembership::as_select())
        .first(conn)
        .optional()?)
}

fn chat_to_response(chat: Group) -> ExternalInviteChatResponse {
    ExternalInviteChatResponse {
        id: chat.id,
        name: chat.name,
        description: chat.description,
        avatar_image_id: chat.avatar_image_id,
        visibility: chat.visibility,
        created_at: chat.created_at,
    }
}

fn membership_to_response(membership: GroupMembership) -> ExternalInviteMembershipResponse {
    ExternalInviteMembershipResponse {
        role: membership.role,
        joined_at: membership.joined_at,
    }
}

#[cfg(test)]
mod tests {
    use super::{require_service_token_principal, validate_request};
    use crate::dto::external::invites::ExternalCreateInviteRequest;
    use crate::errors::AppError;
    use crate::utils::auth::{AuthContext, AuthSource, Principal, ServiceTokenPrincipal};
    use chrono::{Duration, TimeZone, Utc};

    #[test]
    fn validate_request_rejects_past_expiration() {
        let now = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
        let body = ExternalCreateInviteRequest {
            chat_id: 10,
            target_uid: 42,
            expires_at: Some(now - Duration::seconds(1)),
        };

        assert!(matches!(
            validate_request(&body, now),
            Err(AppError::BadRequest("expiresAt must be in the future"))
        ));
    }

    #[test]
    fn validate_request_accepts_future_expiration() {
        let now = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
        let body = ExternalCreateInviteRequest {
            chat_id: 10,
            target_uid: 42,
            expires_at: Some(now + Duration::seconds(1)),
        };

        assert!(validate_request(&body, now).is_ok());
    }

    #[test]
    fn principal_must_be_service_token() {
        let service =
            require_service_token_principal(Principal::ServiceToken(ServiceTokenPrincipal {
                id: 5,
            }))
            .unwrap();
        assert_eq!(service.id, 5);

        let user = Principal::User(AuthContext {
            uid: 42,
            client_id: None,
            source: AuthSource::Legacy,
        });
        assert!(matches!(
            require_service_token_principal(user),
            Err(AppError::Forbidden("Service token required"))
        ));
    }
}
