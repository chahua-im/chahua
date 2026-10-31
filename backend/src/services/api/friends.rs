use std::collections::HashMap;
use std::sync::Arc;

use diesel::PgConnection;

use crate::dto::friends::{
    CreateFriendRequestBody, FriendAddInfoResponse, FriendPresenceSettingsResponse,
    FriendReadReceiptSettingsResponse, FriendRelationshipResponse, FriendRequestDirection,
    FriendRequestHistoryEntry, FriendRequestResponse, FriendResponse, FriendSettingsResponse,
    ListFriendRequestHistoryResponse, ListFriendRequestsQuery, ListFriendsResponse,
    PendingFriendRequestCountResponse, PresenceSettingsResponse, PrivacyException,
    PrivacyExceptionKind, PrivacyExceptionsResponse, ReadReceiptSettingsResponse,
    UpdateFriendPresenceSettingsBody, UpdateFriendReadReceiptSettingsBody,
    UpdateFriendSettingsBody, UpdatePresenceSettingsBody, UpdateReadReceiptSettingsBody,
};
use crate::dto::users::MemberSummary;
use crate::dto::ws::{
    FriendRequestReceivedPayload, FriendRequestResolvedPayload, FriendshipRemovedPayload,
    ServerWsMessage,
};
use crate::errors::AppError;
use crate::metrics::Metrics;
use crate::models::{FriendRequest, FriendRequestStatus};
use crate::services::{
    api::users::build_member_summary_map,
    authentication::Principal,
    authz::{Action as AuthzAction, AuthorizationService},
    avatars::AvatarService,
    media::MediaStore,
    presence::PresenceSnapshotService,
    privacy_exceptions,
    push::PushService,
    read_receipts,
    social::{self, CreateRequestOutcome, FriendRequestServiceDeps, ResolveOutcome},
    user::lookup_user_profiles,
    ws_registry::ConnectionRegistry,
};
use crate::utils::ids::IdGen;

const MAX_FRIEND_REQUEST_MESSAGE_CHARS: usize = 200;
const MAX_FRIEND_VERIFICATION_QUESTION_CHARS: usize = 100;

pub struct CreateFriendRequestDeps<'a> {
    pub authz_service: &'a Arc<AuthorizationService>,
    pub avatars: &'a Arc<AvatarService>,
    pub id_gen: &'a Arc<IdGen>,
    pub media: &'a MediaStore,
    pub metrics: &'a Arc<Metrics>,
    pub ws_registry: &'a Arc<ConnectionRegistry>,
    pub presence_service: &'a Arc<PresenceSnapshotService>,
    pub push_service: &'a Arc<PushService>,
}

impl CreateFriendRequestDeps<'_> {
    fn social(&self) -> FriendRequestServiceDeps<'_> {
        FriendRequestServiceDeps {
            id_gen: self.id_gen,
            media: self.media,
            avatars: self.avatars,
            metrics: self.metrics,
            ws_registry: self.ws_registry,
            presence_service: self.presence_service,
            push_service: self.push_service,
        }
    }
}

pub struct AcceptFriendRequestDeps<'a> {
    pub authz_service: &'a Arc<AuthorizationService>,
    pub avatars: &'a Arc<AvatarService>,
    pub id_gen: &'a Arc<IdGen>,
    pub media: &'a MediaStore,
    pub metrics: &'a Arc<Metrics>,
    pub ws_registry: &'a Arc<ConnectionRegistry>,
    pub presence_service: &'a Arc<PresenceSnapshotService>,
    pub push_service: &'a Arc<PushService>,
}

impl AcceptFriendRequestDeps<'_> {
    fn social(&self) -> FriendRequestServiceDeps<'_> {
        FriendRequestServiceDeps {
            id_gen: self.id_gen,
            media: self.media,
            avatars: self.avatars,
            metrics: self.metrics,
            ws_registry: self.ws_registry,
            presence_service: self.presence_service,
            push_service: self.push_service,
        }
    }
}

pub struct RejectFriendRequestDeps<'a> {
    pub authz_service: &'a Arc<AuthorizationService>,
    pub avatars: &'a Arc<AvatarService>,
    pub id_gen: &'a Arc<IdGen>,
    pub media: &'a MediaStore,
    pub metrics: &'a Arc<Metrics>,
    pub ws_registry: &'a Arc<ConnectionRegistry>,
    pub presence_service: &'a Arc<PresenceSnapshotService>,
    pub push_service: &'a Arc<PushService>,
}

impl RejectFriendRequestDeps<'_> {
    fn social(&self) -> FriendRequestServiceDeps<'_> {
        FriendRequestServiceDeps {
            id_gen: self.id_gen,
            media: self.media,
            avatars: self.avatars,
            metrics: self.metrics,
            ws_registry: self.ws_registry,
            presence_service: self.presence_service,
            push_service: self.push_service,
        }
    }
}

pub enum CreateFriendRequestResult {
    Created(FriendRequestResponse),
    AutoAccepted(FriendRequestResponse),
}

fn validate_friend_request_message(message: Option<&str>) -> Result<(), AppError> {
    if message.is_some_and(|value| value.chars().count() > MAX_FRIEND_REQUEST_MESSAGE_CHARS) {
        return Err(AppError::BadRequest(
            "Friend request message must not exceed 200 characters",
        ));
    }
    Ok(())
}

fn validate_friend_verification_question(question: Option<&str>) -> Result<(), AppError> {
    if question.is_some_and(|value| value.chars().count() > MAX_FRIEND_VERIFICATION_QUESTION_CHARS)
    {
        return Err(AppError::BadRequest(
            "Friend verification question must not exceed 100 characters",
        ));
    }
    Ok(())
}

fn validate_presence_friend_uid(uid: i32, peer_uid: i32) -> Result<(), AppError> {
    if peer_uid <= 0 || peer_uid == uid {
        return Err(AppError::BadRequest("Peer UID is invalid"));
    }
    Ok(())
}

fn missing_user_summary(uid: i32) -> MemberSummary {
    MemberSummary {
        uid,
        username: None,
        avatar_url: None,
        gender: 0,
        user_group: None,
    }
}

fn build_request_response(
    conn: &mut PgConnection,
    avatars: &AvatarService,
    request: &FriendRequest,
) -> Result<FriendRequestResponse, AppError> {
    let summaries = build_member_summary_map(conn, avatars, &[request.from_uid, request.to_uid])?;
    Ok(FriendRequestResponse {
        id: request.id,
        from: summaries
            .get(&request.from_uid)
            .cloned()
            .unwrap_or_else(|| missing_user_summary(request.from_uid)),
        to: summaries
            .get(&request.to_uid)
            .cloned()
            .unwrap_or_else(|| missing_user_summary(request.to_uid)),
        status: request.status,
        created_at: request.created_at,
        decided_at: request.decided_at,
        message: request.message.clone(),
        question: request.question.clone(),
    })
}

fn build_request_responses(
    conn: &mut PgConnection,
    avatars: &AvatarService,
    requests: &[FriendRequest],
) -> Result<Vec<FriendRequestResponse>, AppError> {
    let mut uids = Vec::with_capacity(requests.len() * 2);
    for request in requests {
        uids.push(request.from_uid);
        uids.push(request.to_uid);
    }
    let summaries: HashMap<i32, MemberSummary> = build_member_summary_map(conn, avatars, &uids)?;
    Ok(requests
        .iter()
        .map(|request| FriendRequestResponse {
            id: request.id,
            from: summaries
                .get(&request.from_uid)
                .cloned()
                .unwrap_or_else(|| missing_user_summary(request.from_uid)),
            to: summaries
                .get(&request.to_uid)
                .cloned()
                .unwrap_or_else(|| missing_user_summary(request.to_uid)),
            status: request.status,
            created_at: request.created_at,
            decided_at: request.decided_at,
            message: request.message.clone(),
            question: request.question.clone(),
        })
        .collect())
}

pub async fn get_friends(
    principal: Principal,
    conn: &mut PgConnection,
    authz_service: &AuthorizationService,
    avatars: &AvatarService,
) -> Result<ListFriendsResponse, AppError> {
    let uid =
        principal.require_user_action(conn, authz_service, AuthzAction::OnBehalfOfSocialRead)?;
    let friends = social::list_friends_with_since(conn, uid)?;
    let uids: Vec<i32> = friends.iter().map(|(uid, _)| *uid).collect();
    let summaries = build_member_summary_map(conn, avatars, &uids)?;
    let friends = friends
        .into_iter()
        .filter_map(|(uid, since)| {
            summaries.get(&uid).map(|user| FriendResponse {
                user: user.clone(),
                since,
            })
        })
        .collect();
    Ok(ListFriendsResponse { friends })
}

pub async fn get_friend_relationship(
    principal: Principal,
    peer_uid: i32,
    conn: &mut PgConnection,
    authz_service: &AuthorizationService,
) -> Result<FriendRelationshipResponse, AppError> {
    let uid =
        principal.require_user_action(conn, authz_service, AuthzAction::OnBehalfOfSocialRead)?;
    if peer_uid <= 0 || peer_uid == uid {
        return Err(AppError::BadRequest("Peer UID is invalid"));
    }
    let relationship = social::peer_relationships(conn, uid, &[peer_uid])?
        .remove(&peer_uid)
        .expect("peer_relationships includes every requested peer");
    let is_friend = relationship.friends_since.is_some();
    let has_pending_outgoing_request = relationship
        .pending_request
        .is_some_and(|(_, uid_is_sender, _)| uid_is_sender);
    Ok(FriendRelationshipResponse {
        peer_uid,
        is_friend,
        dm_chat_id: relationship.dm_chat_id,
        blocking: relationship.blocking,
        blocked_by: relationship.blocked_by,
        can_dm: is_friend && !relationship.blocking && !relationship.blocked_by,
        has_pending_outgoing_request,
    })
}

pub async fn delete_friend(
    principal: Principal,
    other: i32,
    conn: &mut PgConnection,
    authz_service: &AuthorizationService,
    presence_service: &PresenceSnapshotService,
    ws_registry: &Arc<ConnectionRegistry>,
) -> Result<(), AppError> {
    let uid =
        principal.require_user_action(conn, authz_service, AuthzAction::OnBehalfOfSocialWrite)?;
    if !social::remove_friendship(conn, uid, other)? {
        return Err(AppError::NotFound("Friendship not found"));
    }
    presence_service.pair_policy_changed(uid, other);
    read_receipts::broadcast_pair_privacy_changed(conn, ws_registry, uid, other)?;
    ws_registry.broadcast_to_uids(
        &[uid, other],
        Arc::new(ServerWsMessage::FriendshipRemoved(
            FriendshipRemovedPayload { actor_uid: uid },
        )),
    );
    Ok(())
}

pub async fn create_friend_request(
    principal: Principal,
    body: CreateFriendRequestBody,
    conn: &mut PgConnection,
    deps: CreateFriendRequestDeps<'_>,
) -> Result<CreateFriendRequestResult, AppError> {
    let uid = principal.require_user_action(
        conn,
        deps.authz_service,
        AuthzAction::OnBehalfOfSocialWrite,
    )?;
    validate_friend_request_message(body.message.as_deref())?;
    let target_profiles = lookup_user_profiles(conn, &[body.to_uid])?;
    if !target_profiles.contains_key(&body.to_uid) {
        return Err(AppError::NotFound("User not found"));
    }
    match social::create_friend_request(conn, deps.social(), uid, body.to_uid, body.message).await?
    {
        CreateRequestOutcome::Created { request } => {
            deps.ws_registry.broadcast_to_uids(
                &[request.to_uid],
                Arc::new(ServerWsMessage::FriendRequestReceived(
                    FriendRequestReceivedPayload { from_uid: uid },
                )),
            );
            Ok(CreateFriendRequestResult::Created(build_request_response(
                conn,
                deps.avatars,
                &request,
            )?))
        }
        CreateRequestOutcome::AutoAccepted { request } => {
            deps.ws_registry.broadcast_to_uids(
                &[request.from_uid],
                Arc::new(ServerWsMessage::FriendRequestResolved(
                    FriendRequestResolvedPayload {
                        request_id: request.id,
                        status: FriendRequestStatus::Accepted,
                        by_uid: uid,
                    },
                )),
            );
            Ok(CreateFriendRequestResult::AutoAccepted(
                build_request_response(conn, deps.avatars, &request)?,
            ))
        }
        CreateRequestOutcome::AlreadyPending => {
            Err(AppError::Conflict("Friend request already pending"))
        }
        CreateRequestOutcome::AlreadyFriends => Err(AppError::Conflict("Already friends")),
    }
}

pub async fn count_pending_incoming_requests(
    principal: Principal,
    conn: &mut PgConnection,
    authz_service: &AuthorizationService,
) -> Result<PendingFriendRequestCountResponse, AppError> {
    let uid =
        principal.require_user_action(conn, authz_service, AuthzAction::OnBehalfOfSocialRead)?;
    Ok(PendingFriendRequestCountResponse {
        pending_incoming_count: social::count_pending_incoming_requests(conn, uid)?,
    })
}

pub async fn list_friend_request_history(
    principal: Principal,
    query: ListFriendRequestsQuery,
    conn: &mut PgConnection,
    authz_service: &AuthorizationService,
    avatars: &AvatarService,
) -> Result<ListFriendRequestHistoryResponse, AppError> {
    let uid =
        principal.require_user_action(conn, authz_service, AuthzAction::OnBehalfOfSocialRead)?;
    let rows = social::list_friend_request_history(conn, uid, query.archived)?;
    let directions = rows
        .iter()
        .map(|row| {
            if row.to_uid == uid {
                FriendRequestDirection::Incoming
            } else {
                FriendRequestDirection::Outgoing
            }
        })
        .collect::<Vec<_>>();
    let requests = build_request_responses(conn, avatars, &rows)?
        .into_iter()
        .zip(directions)
        .map(|(request, direction)| FriendRequestHistoryEntry { request, direction })
        .collect();
    Ok(ListFriendRequestHistoryResponse { requests })
}

pub async fn accept_friend_request(
    principal: Principal,
    request_id: i64,
    conn: &mut PgConnection,
    deps: AcceptFriendRequestDeps<'_>,
) -> Result<FriendRequestResponse, AppError> {
    let uid = principal.require_user_action(
        conn,
        deps.authz_service,
        AuthzAction::OnBehalfOfSocialWrite,
    )?;
    let outcome =
        social::resolve_friend_request(conn, deps.social(), uid, request_id, true).await?;
    let request = outcome.request();
    deps.ws_registry.broadcast_to_uids(
        &[request.from_uid],
        Arc::new(ServerWsMessage::FriendRequestResolved(
            FriendRequestResolvedPayload {
                request_id: request.id,
                status: FriendRequestStatus::Accepted,
                by_uid: uid,
            },
        )),
    );
    build_request_response(conn, deps.avatars, request)
}

pub async fn reject_friend_request(
    principal: Principal,
    request_id: i64,
    conn: &mut PgConnection,
    deps: RejectFriendRequestDeps<'_>,
) -> Result<FriendRequestResponse, AppError> {
    let uid = principal.require_user_action(
        conn,
        deps.authz_service,
        AuthzAction::OnBehalfOfSocialWrite,
    )?;
    let outcome =
        social::resolve_friend_request(conn, deps.social(), uid, request_id, false).await?;
    let request = outcome.request();
    deps.ws_registry.broadcast_to_uids(
        &[request.from_uid],
        Arc::new(ServerWsMessage::FriendRequestResolved(
            FriendRequestResolvedPayload {
                request_id: request.id,
                status: FriendRequestStatus::Rejected,
                by_uid: uid,
            },
        )),
    );
    if matches!(&outcome, ResolveOutcome::RejectedWhileFriends(_)) {
        return Err(AppError::Conflict("You are already friends with this user"));
    }
    build_request_response(conn, deps.avatars, request)
}

pub async fn archive_friend_request(
    principal: Principal,
    request_id: i64,
    conn: &mut PgConnection,
    authz_service: &AuthorizationService,
) -> Result<(), AppError> {
    let uid =
        principal.require_user_action(conn, authz_service, AuthzAction::OnBehalfOfSocialWrite)?;
    social::archive_friend_request(conn, uid, request_id)
}

pub async fn get_my_friend_settings(
    uid: i32,
    conn: &mut PgConnection,
) -> Result<FriendSettingsResponse, AppError> {
    let (mode, question) = social::get_friend_settings(conn, uid)?;
    Ok(FriendSettingsResponse { mode, question })
}

pub async fn update_my_friend_settings(
    uid: i32,
    body: UpdateFriendSettingsBody,
    conn: &mut PgConnection,
) -> Result<FriendSettingsResponse, AppError> {
    validate_friend_verification_question(body.question.as_deref())?;
    let (mode, question) = social::upsert_friend_settings(conn, uid, body.mode, body.question)?;
    Ok(FriendSettingsResponse { mode, question })
}

pub async fn get_user_friend_add_info(
    principal: Principal,
    target_uid: i32,
    conn: &mut PgConnection,
    authz_service: &AuthorizationService,
) -> Result<FriendAddInfoResponse, AppError> {
    principal.require_user_action(conn, authz_service, AuthzAction::OnBehalfOfSocialRead)?;
    let (mode, question) = social::get_friend_settings(conn, target_uid)?;
    Ok(FriendAddInfoResponse { mode, question })
}

pub async fn get_my_presence_settings(
    uid: i32,
    conn: &mut PgConnection,
) -> Result<PresenceSettingsResponse, AppError> {
    let visibility = social::get_presence_settings(conn, uid)?;
    Ok(PresenceSettingsResponse {
        visibility,
        exception_count: privacy_exceptions::count(conn, uid, PrivacyExceptionKind::Presence)?,
    })
}

pub async fn update_my_presence_settings(
    uid: i32,
    body: UpdatePresenceSettingsBody,
    conn: &mut PgConnection,
    presence_service: &PresenceSnapshotService,
) -> Result<PresenceSettingsResponse, AppError> {
    let visibility = social::update_presence_settings(conn, uid, body.visibility)?;
    presence_service.user_policy_changed(uid);
    Ok(PresenceSettingsResponse {
        visibility,
        exception_count: privacy_exceptions::count(conn, uid, PrivacyExceptionKind::Presence)?,
    })
}

pub async fn get_my_read_receipt_settings(
    uid: i32,
    conn: &mut PgConnection,
) -> Result<ReadReceiptSettingsResponse, AppError> {
    let visibility = social::get_read_receipt_settings(conn, uid)?;
    Ok(ReadReceiptSettingsResponse {
        visibility,
        exception_count: privacy_exceptions::count(conn, uid, PrivacyExceptionKind::ReadReceipts)?,
    })
}

pub async fn update_my_read_receipt_settings(
    uid: i32,
    body: UpdateReadReceiptSettingsBody,
    conn: &mut PgConnection,
    ws_registry: &Arc<ConnectionRegistry>,
) -> Result<ReadReceiptSettingsResponse, AppError> {
    let previous = social::get_read_receipt_settings(conn, uid)?;
    let visibility = social::update_read_receipt_settings(conn, uid, body.visibility)?;
    if previous != visibility {
        read_receipts::broadcast_global_privacy_changed(conn, ws_registry, uid)?;
    }
    Ok(ReadReceiptSettingsResponse {
        visibility,
        exception_count: privacy_exceptions::count(conn, uid, PrivacyExceptionKind::ReadReceipts)?,
    })
}

pub async fn get_friend_presence_settings(
    uid: i32,
    peer_uid: i32,
    conn: &mut PgConnection,
) -> Result<FriendPresenceSettingsResponse, AppError> {
    validate_presence_friend_uid(uid, peer_uid)?;
    Ok(FriendPresenceSettingsResponse {
        override_value: social::get_friend_presence_settings(conn, uid, peer_uid)?,
    })
}

pub async fn update_friend_presence_settings(
    uid: i32,
    peer_uid: i32,
    body: UpdateFriendPresenceSettingsBody,
    conn: &mut PgConnection,
    presence_service: &PresenceSnapshotService,
) -> Result<FriendPresenceSettingsResponse, AppError> {
    validate_presence_friend_uid(uid, peer_uid)?;
    let override_value =
        social::update_friend_presence_settings(conn, uid, peer_uid, body.override_value)?;
    presence_service.pair_policy_changed(uid, peer_uid);
    Ok(FriendPresenceSettingsResponse { override_value })
}

pub async fn get_friend_read_receipt_settings(
    uid: i32,
    peer_uid: i32,
    conn: &mut PgConnection,
) -> Result<FriendReadReceiptSettingsResponse, AppError> {
    validate_presence_friend_uid(uid, peer_uid)?;
    Ok(FriendReadReceiptSettingsResponse {
        override_value: social::get_friend_read_receipt_settings(conn, uid, peer_uid)?,
    })
}

pub async fn update_friend_read_receipt_settings(
    uid: i32,
    peer_uid: i32,
    body: UpdateFriendReadReceiptSettingsBody,
    conn: &mut PgConnection,
    ws_registry: &Arc<ConnectionRegistry>,
) -> Result<FriendReadReceiptSettingsResponse, AppError> {
    validate_presence_friend_uid(uid, peer_uid)?;
    let previous = social::get_friend_read_receipt_settings(conn, uid, peer_uid)?;
    let override_value =
        social::update_friend_read_receipt_settings(conn, uid, peer_uid, body.override_value)?;
    if previous != override_value {
        read_receipts::broadcast_pair_privacy_changed(conn, ws_registry, uid, peer_uid)?;
    }
    Ok(FriendReadReceiptSettingsResponse { override_value })
}

pub async fn get_privacy_exceptions(
    uid: i32,
    kind: PrivacyExceptionKind,
    conn: &mut PgConnection,
    avatars: &AvatarService,
) -> Result<PrivacyExceptionsResponse, AppError> {
    let rows = privacy_exceptions::list(conn, uid, kind)?;
    let uids: Vec<i32> = rows.iter().map(|(peer, _)| *peer).collect();
    let mut summaries = build_member_summary_map(conn, avatars, &uids)?;
    Ok(PrivacyExceptionsResponse {
        exceptions: rows
            .into_iter()
            .map(|(peer, share)| PrivacyException {
                user: summaries
                    .remove(&peer)
                    .unwrap_or_else(|| missing_user_summary(peer)),
                share,
            })
            .collect(),
    })
}

pub async fn clear_privacy_exceptions(
    uid: i32,
    kind: PrivacyExceptionKind,
    conn: &mut PgConnection,
    presence_service: &PresenceSnapshotService,
    ws_registry: &Arc<ConnectionRegistry>,
) -> Result<(), AppError> {
    let peers = privacy_exceptions::clear(conn, uid, kind)?;
    if !peers.is_empty() {
        match kind {
            PrivacyExceptionKind::Presence => presence_service.user_policy_changed(uid),
            PrivacyExceptionKind::ReadReceipts => {
                read_receipts::broadcast_privacy_changed_for_peers(conn, ws_registry, uid, &peers)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        validate_friend_request_message, validate_friend_verification_question,
        validate_presence_friend_uid, MAX_FRIEND_REQUEST_MESSAGE_CHARS,
        MAX_FRIEND_VERIFICATION_QUESTION_CHARS,
    };
    use crate::dto::friends::ListFriendRequestsQuery;
    use crate::errors::AppError;

    fn assert_character_limit(
        validator: fn(Option<&str>) -> Result<(), AppError>,
        max: usize,
        expected_error: &'static str,
    ) {
        let at_limit = "界".repeat(max);
        let over_limit = "界".repeat(max + 1);
        assert!(validator(Some(&at_limit)).is_ok());
        assert!(
            matches!(validator(Some(&over_limit)), Err(AppError::BadRequest(message)) if message == expected_error)
        );
    }

    #[test]
    fn friend_request_message_has_a_200_character_limit() {
        assert_character_limit(
            validate_friend_request_message,
            MAX_FRIEND_REQUEST_MESSAGE_CHARS,
            "Friend request message must not exceed 200 characters",
        );
    }

    #[test]
    fn friend_verification_question_has_a_100_character_limit() {
        assert_character_limit(
            validate_friend_verification_question,
            MAX_FRIEND_VERIFICATION_QUESTION_CHARS,
            "Friend verification question must not exceed 100 characters",
        );
    }

    #[test]
    fn friend_request_archive_query_deserializes() {
        let query: ListFriendRequestsQuery =
            serde_json::from_value(serde_json::json!({ "archived": true })).unwrap();
        assert_eq!(query.archived, Some(true));
    }

    #[test]
    fn presence_settings_reject_invalid_or_self_friend_uids() {
        assert!(matches!(
            validate_presence_friend_uid(7, 0),
            Err(AppError::BadRequest("Peer UID is invalid"))
        ));
        assert!(matches!(
            validate_presence_friend_uid(7, 7),
            Err(AppError::BadRequest("Peer UID is invalid"))
        ));
    }
}
