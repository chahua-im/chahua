use std::sync::Arc;

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::PgConnection;
use serde_json::json;

use crate::dto::invites::{
    CreateInviteBody, GetInviteByCodeQuery, InvitePreviewResponse, InviteResponse,
    ListInvitesQuery, ListInvitesResponse, PatchInviteBody, RedeemInviteBody, RedeemInviteResponse,
    SendInviteMessageBody, SendInviteMessageResponse,
};
use crate::errors::AppError;
use crate::metrics::Metrics;
use crate::models::{
    GroupJoinReason, GroupRole, Invite, InviteType, MessageType, NewGroupMembership,
};
use crate::schema::{group_membership, invites};
use crate::services::api::{groups::load_group_info, members::require_admin_role};
use crate::services::avatars::AvatarService;
use crate::services::invites as invite_service;
use crate::services::media::MediaStore;
use crate::services::messages::{
    authorize_message_send, send_prepared_message, PreparedMessageSend, SendMessageOutcome,
    SendPreparedMessageDeps,
};
use crate::services::push::PushService;
use crate::services::ws_registry::ConnectionRegistry;
use crate::utils::ids::IdGen;
use crate::utils::transaction::AsyncTransaction;

pub struct PostSendInviteMessageDeps<'a> {
    pub id_gen: &'a Arc<IdGen>,
    pub media: &'a MediaStore,
    pub avatars: &'a Arc<AvatarService>,
    pub metrics: &'a Arc<Metrics>,
    pub ws_registry: &'a Arc<ConnectionRegistry>,
    pub push_service: &'a Arc<PushService>,
}

pub struct PostRedeemInviteDeps<'a> {
    pub id_gen: &'a Arc<IdGen>,
    pub media: &'a MediaStore,
    pub avatars: &'a Arc<AvatarService>,
    pub metrics: &'a Arc<Metrics>,
    pub ws_registry: &'a Arc<ConnectionRegistry>,
    pub push_service: &'a Arc<PushService>,
}
const DEFAULT_INVITES_LIMIT: i64 = 100;
const MAX_INVITES_LIMIT: i64 = 100;
const INVALID_INVITE_CODE_MESSAGE: &str = "Invalid invite code";
const INVALID_INVITE_MESSAGE: &str = "Invalid invite";
enum RedeemInviteError {
    App(AppError),
    Db(diesel::result::Error),
}

#[derive(Debug, PartialEq, Eq)]
enum PreviewEligibility {
    Eligible,
    AlreadyMember,
    NotInvited,
    Used,
}

enum RedeemInviteOutcome {
    Joined(i64, crate::models::GroupKind),
    AlreadyMember,
}

impl From<diesel::result::Error> for RedeemInviteError {
    fn from(error: diesel::result::Error) -> Self {
        Self::Db(error)
    }
}

impl From<AppError> for RedeemInviteError {
    fn from(error: AppError) -> Self {
        Self::App(error)
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
    id_gen: &crate::utils::ids::IdGen,
    uid: i32,
    body: &CreateInviteBody,
) -> Result<Invite, AppError> {
    invite_service::create_invite(
        conn,
        id_gen,
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
) -> Result<PreviewEligibility, AppError> {
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
            if invite.target_uid != Some(uid) {
                Ok(PreviewEligibility::NotInvited)
            } else if invite.used_at.is_some() {
                Ok(PreviewEligibility::Used)
            } else {
                Ok(PreviewEligibility::Eligible)
            }
        }
        InviteType::Membership => {
            let required_chat_id = invite
                .required_chat_id
                .ok_or(AppError::Internal("Invalid membership invite"))?;
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
                Ok(PreviewEligibility::NotInvited)
            }
        }
    }
}
pub async fn post_invite(
    uid: i32,
    body: CreateInviteBody,
    conn: &mut PgConnection,
    id_gen: &IdGen,
) -> Result<InviteResponse, AppError> {
    validate_create_body(&body)?;

    require_admin_role(conn, body.chat_id, uid)?;
    let invite = create_invite_from_body(conn, id_gen, uid, &body).await?;

    Ok(invite_service::invite_to_response(invite))
}
pub async fn post_send_invite_message(
    uid: i32,
    body: SendInviteMessageBody,
    conn: &mut PgConnection,
    deps: PostSendInviteMessageDeps<'_>,
) -> Result<SendInviteMessageResponse, AppError> {
    let PostSendInviteMessageDeps {
        id_gen,
        media,
        avatars,
        metrics,
        ws_registry,
        push_service,
    } = deps;

    require_admin_role(conn, body.source_chat_id, uid)?;
    let (invite, send_result) = {
        let mut transaction = AsyncTransaction::begin(conn)?;
        let conn = transaction.connection();
        let result = async {
            let target = authorize_message_send(conn, body.destination_chat_id, None, uid)?;

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
                    id_gen,
                    body.source_chat_id,
                    uid,
                    body.expires_at,
                )
                .await?
            };

            let send_result = send_prepared_message(
                conn,
                SendPreparedMessageDeps {
                    id_gen,
                    media,
                    avatars,
                    metrics,
                },
                PreparedMessageSend {
                    system_kind: None,
                    forwarded_from_message_id: None,
                    chat_id: body.destination_chat_id,
                    chat_kind: target.kind,
                    sender_uid: uid,
                    message: Some(invite.code.clone()),
                    message_type: MessageType::Invite,
                    sticker_id: None,
                    reply_to_id: None,
                    reply_root_id: None,
                    client_generated_id: body.client_generated_id,
                    attachment_ids: vec![],
                    publish_immediately: true,
                    forwarded_bundle_id: None,
                    forwarded_preview_total: None,
                    forwarded_preview_contains_forwarded_messages: None,
                    forwarded_preview_items: None,
                },
            )
            .await?;
            Ok((invite, send_result))
        }
        .await;
        transaction.finish(result)?
    };
    let message = match send_result {
        SendMessageOutcome::Created(send_result) => {
            let send_result = *send_result;
            send_result.side_effects.fire(ws_registry, push_service);
            send_result.response
        }
        SendMessageOutcome::Duplicate(response) => *response,
    };

    Ok(SendInviteMessageResponse {
        invite: invite_service::invite_to_response(invite),
        message,
    })
}
pub fn get_invites(
    uid: i32,
    query: ListInvitesQuery,
    conn: &mut PgConnection,
) -> Result<ListInvitesResponse, AppError> {
    let limit = invite_limit(query.limit);
    let now = Utc::now();
    let mut base_query = invites::table
        .into_boxed()
        .order((invites::created_at.desc(), invites::id.desc()))
        .limit(limit + 1);

    if let Some(group_id) = query.group_id {
        require_admin_role(conn, group_id, uid)?;
        base_query = base_query.filter(invites::chat_id.eq(group_id));
    } else {
        base_query = base_query.filter(invites::creator_uid.eq(Some(uid)));
    }

    if query.active_only.unwrap_or(false) {
        base_query = base_query.filter(
            invites::revoked_at
                .is_null()
                .and(invites::used_at.is_null())
                .and(
                    invites::expires_at
                        .is_null()
                        .or(invites::expires_at.gt(now)),
                ),
        );
    }
    if let Some(after) = query.after {
        let (created_at, id) = parse_invite_cursor(&after)?;
        base_query = base_query.filter(
            invites::created_at
                .lt(created_at)
                .or(invites::created_at.eq(created_at).and(invites::id.lt(id))),
        );
    }
    // Existing chat/creator + created_at indexes bound this scan to the selected scope.
    let mut rows = base_query
        .select(Invite::as_select())
        .load::<Invite>(conn)?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_cursor = if has_more {
        rows.last()
            .map(|row| format!("{}|{}", row.created_at.to_rfc3339(), row.id))
    } else {
        None
    };
    let target_uids: Vec<_> = rows.iter().filter_map(|row| row.target_uid).collect();
    let profiles = crate::services::user::lookup_user_profiles(conn, &target_uids)?;
    let required_ids: Vec<_> = rows.iter().filter_map(|row| row.required_chat_id).collect();
    use crate::schema::groups;
    let names: std::collections::HashMap<i64, String> = groups::table
        .filter(groups::id.eq_any(required_ids))
        .select((groups::id, groups::name))
        .load::<(i64, String)>(conn)?
        .into_iter()
        .collect();
    Ok(ListInvitesResponse {
        invites: rows
            .into_iter()
            .map(|row| {
                let mut response = invite_service::invite_to_response(row);
                response.target_name = response
                    .target_uid
                    .and_then(|uid| profiles.get(&uid))
                    .and_then(|profile| profile.username.clone());
                response.required_chat_name = response
                    .required_chat_id
                    .and_then(|id| names.get(&id).cloned());
                response
            })
            .collect(),
        next_cursor,
    })
}

fn parse_invite_cursor(value: &str) -> Result<(DateTime<Utc>, i64), AppError> {
    let invalid = || AppError::BadRequest("Invalid invite cursor");
    let (time, id) = value.split_once('|').ok_or_else(invalid)?;
    Ok((
        time.parse().map_err(|_| invalid())?,
        id.parse().map_err(|_| invalid())?,
    ))
}

pub fn get_invite(
    uid: i32,
    invite_id: i64,
    conn: &mut PgConnection,
) -> Result<InviteResponse, AppError> {
    let invite = load_invite_by_id(conn, invite_id)?;
    require_admin_role(conn, invite.chat_id, uid)?;

    Ok(invite_service::invite_to_response(invite))
}
pub fn get_invite_by_code(
    uid: i32,
    query: GetInviteByCodeQuery,
    conn: &mut PgConnection,
    media: &MediaStore,
    avatars: &AvatarService,
) -> Result<InvitePreviewResponse, AppError> {
    let (invite, eligibility) = load_preview_invite(conn, uid, &query.invite_code)?;
    let chat = load_group_info(conn, media, avatars, invite.chat_id, uid)?;

    Ok(InvitePreviewResponse {
        invite: invite_service::invite_to_response(invite),
        chat,
        already_member: matches!(eligibility, PreviewEligibility::AlreadyMember),
        can_join: matches!(eligibility, PreviewEligibility::Eligible),
    })
}

fn load_preview_invite(
    conn: &mut PgConnection,
    uid: i32,
    code: &str,
) -> Result<(Invite, PreviewEligibility), AppError> {
    let invite_code = code.trim();
    if invite_code.is_empty() {
        return Err(AppError::BadRequest(INVALID_INVITE_CODE_MESSAGE));
    }

    let invite = invites::table
        .filter(invites::code.eq(invite_code))
        .select(Invite::as_select())
        .first::<Invite>(conn)
        .optional()?
        .ok_or(AppError::NotFound("Invite not found"))?;

    if !validate_invite_is_active(&invite, Utc::now()) {
        return Err(AppError::Gone("Invite is no longer active"));
    }

    let eligibility = preview_eligibility(conn, &invite, uid)?;

    Ok((invite, eligibility))
}
pub fn patch_invite(
    uid: i32,
    invite_id: i64,
    body: PatchInviteBody,
    conn: &mut PgConnection,
) -> Result<InviteResponse, AppError> {
    let invite = load_invite_by_id(conn, invite_id)?;
    require_admin_role(conn, invite.chat_id, uid)?;

    let next_expires_at = body
        .expires_at
        .ok_or(AppError::BadRequest("expires_at is required"))?;

    let updated = diesel::update(invites::table.filter(invites::id.eq(invite_id)))
        .set(invites::expires_at.eq(next_expires_at))
        .returning(Invite::as_returning())
        .get_result::<Invite>(conn)?;

    Ok(invite_service::invite_to_response(updated))
}
pub fn delete_invite(uid: i32, invite_id: i64, conn: &mut PgConnection) -> Result<(), AppError> {
    let invite = load_invite_by_id(conn, invite_id)?;
    require_admin_role(conn, invite.chat_id, uid)?;

    diesel::update(invites::table.filter(invites::id.eq(invite_id)))
        .set(invites::revoked_at.eq(Utc::now()))
        .execute(conn)?;

    Ok(())
}
pub async fn post_redeem_invite(
    uid: i32,
    body: RedeemInviteBody,
    conn: &mut PgConnection,
    deps: PostRedeemInviteDeps<'_>,
) -> Result<RedeemInviteResponse, AppError> {
    let PostRedeemInviteDeps {
        id_gen,
        media,
        avatars,
        metrics,
        ws_registry,
        push_service,
    } = deps;

    let code = body.code.trim();
    if code.is_empty() {
        return Err(AppError::BadRequest(INVALID_INVITE_CODE_MESSAGE));
    }

    let outcome = conn
        .transaction::<RedeemInviteOutcome, RedeemInviteError, _>(|conn| {
            let (invite, eligibility) = load_preview_invite(conn, uid, code)?;
            match eligibility {
                PreviewEligibility::AlreadyMember => return Ok(RedeemInviteOutcome::AlreadyMember),
                PreviewEligibility::NotInvited => {
                    return Err(AppError::Forbidden("Not eligible for this invite").into());
                }
                PreviewEligibility::Used => {
                    return Err(AppError::Conflict("Invite already used").into());
                }
                PreviewEligibility::Eligible => {}
            }
            let now = Utc::now();

            let (last_message_id, chat_kind): (Option<i64>, crate::models::GroupKind) =
                crate::schema::groups::table
                    .filter(crate::schema::groups::id.eq(invite.chat_id))
                    .select((
                        crate::schema::groups::last_message_id,
                        crate::schema::groups::kind,
                    ))
                    .first(conn)?;
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
                    return Err(AppError::Conflict("Invite already used").into());
                }
            }

            Ok(RedeemInviteOutcome::Joined(invite.chat_id, chat_kind))
        })
        .map_err(|error| match error {
            RedeemInviteError::App(error) => error,
            RedeemInviteError::Db(other) => {
                tracing::error!("redeem invite: {:?}", other);
                AppError::Internal("Failed to redeem invite")
            }
        })?;

    let (chat_id, chat_kind) = match outcome {
        RedeemInviteOutcome::Joined(chat_id, chat_kind) => (chat_id, chat_kind),
        RedeemInviteOutcome::AlreadyMember => {
            return Err(AppError::Conflict("Already a member of this chat"));
        }
    };

    if let Ok(SendMessageOutcome::Created(send_result)) =
        crate::services::messages::send_prepared_message(
            conn,
            crate::services::messages::SendPreparedMessageDeps {
                id_gen,
                media,
                avatars,
                metrics,
            },
            crate::services::messages::PreparedMessageSend {
                system_kind: Some(crate::models::SystemMessageKind::MemberJoined),
                forwarded_from_message_id: None,
                chat_id,
                chat_kind,
                sender_uid: uid,
                message: Some("joined the chat".to_string()),
                message_type: crate::models::MessageType::System,
                sticker_id: None,
                reply_to_id: None,
                reply_root_id: None,
                client_generated_id: uuid::Uuid::new_v4().to_string(),
                attachment_ids: vec![],
                publish_immediately: true,
                forwarded_bundle_id: None,
                forwarded_preview_total: None,
                forwarded_preview_contains_forwarded_messages: None,
                forwarded_preview_items: None,
            },
        )
        .await
    {
        let send_result = *send_result;
        send_result.side_effects.fire(ws_registry, push_service);
    }

    crate::services::chat::publish_membership_changed(ws_registry, uid, chat_id);
    let chat = load_group_info(conn, media, avatars, chat_id, uid)?;
    Ok(RedeemInviteResponse { chat })
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::connection::SimpleConnection;

    #[test]
    fn preview_availability_is_independent_of_join_permission() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.batch_execute(
            "CREATE TEMP TABLE invites (LIKE public.invites INCLUDING ALL);
             CREATE TEMP TABLE group_membership (LIKE public.group_membership INCLUDING ALL);
             INSERT INTO invites (id, code, chat_id, invite_type, created_at, target_uid, required_chat_id)
             VALUES (1, 'expired1', 10, 'generic', NOW(), NULL, NULL),
                    (2, 'revoked1', 10, 'generic', NOW(), NULL, NULL),
                    (3, 'used0001', 10, 'targeted', NOW(), 9, NULL),
                    (4, 'targeted', 10, 'targeted', NOW(), 9, NULL),
                    (5, 'members1', 10, 'membership', NOW(), NULL, 20),
                    (6, 'active01', 10, 'generic', NOW(), NULL, NULL);
             UPDATE invites SET expires_at = NOW() - INTERVAL '1 day' WHERE id = 1;
             UPDATE invites SET revoked_at = NOW() WHERE id = 2;
             UPDATE invites SET used_at = NOW() WHERE id = 3;
             INSERT INTO group_membership (chat_id, uid, role, joined_at)
             VALUES (10, 7, 'member', NOW()), (20, 8, 'member', NOW());",
        )
        .unwrap();

        use crate::rpc::error::{RpcError, RpcErrorCode};
        for uid in [7, 8, 9] {
            for (code, expected) in [
                ("missing1", RpcErrorCode::NotFound),
                ("expired1", RpcErrorCode::Gone),
                ("revoked1", RpcErrorCode::Gone),
                ("", RpcErrorCode::BadRequest),
            ] {
                let error = match load_preview_invite(&mut conn, uid, code) {
                    Err(error) => error,
                    Ok(_) => panic!("unexpected preview for {code}, uid {uid}"),
                };
                assert_eq!(RpcError::from(error).code, expected, "{code}, uid {uid}");
            }
        }
        for (code, uid, expected) in [
            ("active01", 7, PreviewEligibility::AlreadyMember),
            ("active01", 8, PreviewEligibility::Eligible),
            ("active01", 9, PreviewEligibility::Eligible),
            ("targeted", 7, PreviewEligibility::AlreadyMember),
            ("targeted", 8, PreviewEligibility::NotInvited),
            ("targeted", 9, PreviewEligibility::Eligible),
            ("members1", 7, PreviewEligibility::AlreadyMember),
            ("members1", 8, PreviewEligibility::Eligible),
            ("members1", 9, PreviewEligibility::NotInvited),
            ("used0001", 7, PreviewEligibility::AlreadyMember),
            ("used0001", 8, PreviewEligibility::NotInvited),
            ("used0001", 9, PreviewEligibility::Used),
        ] {
            let (invite, eligibility) = load_preview_invite(&mut conn, uid, code).unwrap();
            assert_eq!(invite.code, code);
            assert_eq!(eligibility, expected, "{code}, uid {uid}");
        }
    }

    #[test]
    fn invite_cursor_preserves_time_and_id_and_rejects_bad_input() {
        let time: DateTime<Utc> = "2026-11-05T12:00:00.123456Z".parse().unwrap();
        let cursor = format!("{}|{}", time.to_rfc3339(), i64::MAX);
        assert_eq!(parse_invite_cursor(&cursor).unwrap(), (time, i64::MAX));
        for value in [
            "",
            "abc|2",
            "2026-11-05T00:00:00Z|x",
            "2026-11-05T00:00:00Z|1|2",
        ] {
            assert!(parse_invite_cursor(value).is_err());
        }
    }

    #[test]
    fn active_filter_keeps_old_invites_and_unfiltered_pagination_stays_compatible() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.batch_execute(
            "CREATE TEMP TABLE invites (LIKE public.invites INCLUDING ALL);
             INSERT INTO invites (id, code, chat_id, invite_type, creator_uid, created_at, expires_at)
             SELECT n, 'code' || lpad(n::text, 8, '0'), 10, 'generic', 1,
                    '2020-01-01'::timestamptz, '2021-01-01'::timestamptz
             FROM generate_series(2, 122) n;
             INSERT INTO invites (id, code, chat_id, invite_type, creator_uid, created_at)
             VALUES (1, 'old-valid', 10, 'generic', 1, '2019-01-01'),
                    (123, 'otheruser', 10, 'generic', 2, '2020-01-01');
             UPDATE invites SET expires_at = NULL, revoked_at = NOW() WHERE id = 122;
             UPDATE invites SET expires_at = NULL, used_at = NOW(), invite_type = 'targeted', target_uid = 1 WHERE id = 121;"
        ).unwrap();
        let active = get_invites(
            1,
            ListInvitesQuery {
                group_id: None,
                limit: Some(30),
                active_only: Some(true),
                after: None,
            },
            &mut conn,
        )
        .unwrap();
        assert_eq!(
            active.invites.iter().map(|row| row.id).collect::<Vec<_>>(),
            vec![1]
        );
        assert!(active.next_cursor.is_none());
        // Avoid depending on identity-provider fixtures for the used targeted record.
        conn.batch_execute(
            "UPDATE invites SET invite_type = 'generic', target_uid = NULL WHERE id = 121",
        )
        .unwrap();
        let mut ids = Vec::new();
        let mut after = None;
        loop {
            let page = get_invites(
                1,
                ListInvitesQuery {
                    group_id: None,
                    limit: Some(30),
                    active_only: None,
                    after,
                },
                &mut conn,
            )
            .unwrap();
            ids.extend(page.invites.iter().map(|row| row.id));
            after = page.next_cursor;
            if after.is_none() {
                break;
            }
        }
        assert_eq!(ids, (1..=122).rev().collect::<Vec<_>>());
    }
}
