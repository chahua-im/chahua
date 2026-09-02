use std::collections::HashSet;

use axum::extract::{Json, State};
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::external::social::{
    RelationshipPendingRequest, RelationshipQueryRequest, RelationshipQueryResponse,
    RelationshipRequestDirection, RelationshipStatus,
};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::services::authz::Action as AuthzAction;
use crate::services::social as social_service;
use crate::utils::auth::Principal;
use crate::AppState;

/// Report stored relationship facts for arbitrary UID pairs.
///
/// Unknown user IDs are reported with empty facts; this endpoint deliberately
/// avoids profile hydration and existence checks.
#[utoipa::path(
    post,
    path = "/relationships",
    tag = "external-social",
    request_body = RelationshipQueryRequest,
    responses((status = 200, description = "Relationship status per peer", body = RelationshipQueryResponse)),
    security(("service_token_bearer" = []))
)]
async fn post_relationships(
    principal: Principal,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<RelationshipQueryRequest>,
) -> Result<Json<RelationshipQueryResponse>, AppError> {
    let conn = &mut *conn;
    principal.require_service_action(conn, &state, AuthzAction::OnBehalfOfSocialRead)?;
    let peers = validate_relationship_request(&body)?;
    let relationships = social_service::peer_relationships(conn, body.uid, &peers)?;

    Ok(Json(RelationshipQueryResponse {
        uid: body.uid,
        relationships: peers
            .into_iter()
            .map(|peer_uid| {
                let facts = relationships
                    .get(&peer_uid)
                    .expect("peer_relationships includes every requested peer");
                let is_friend = facts.friends_since.is_some();
                let pending_request =
                    facts
                        .pending_request
                        .map(
                            |(id, uid_is_sender, created_at)| RelationshipPendingRequest {
                                id,
                                direction: if uid_is_sender {
                                    RelationshipRequestDirection::Outgoing
                                } else {
                                    RelationshipRequestDirection::Incoming
                                },
                                created_at,
                            },
                        );

                RelationshipStatus {
                    peer_uid,
                    is_friend,
                    friends_since: facts.friends_since,
                    dm_chat_id: facts.dm_chat_id,
                    blocking: facts.blocking,
                    blocked_by: facts.blocked_by,
                    can_dm: derive_can_dm(is_friend, facts.blocking, facts.blocked_by),
                    pending_request,
                }
            })
            .collect(),
    }))
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new().routes(routes!(post_relationships))
}

/// Validate and dedupe `peerUids`, preserving first-occurrence order.
fn validate_relationship_request(body: &RelationshipQueryRequest) -> Result<Vec<i32>, AppError> {
    if body.uid <= 0 {
        return Err(AppError::BadRequest("uid is invalid"));
    }
    if body.peer_uids.is_empty() {
        return Err(AppError::BadRequest("peerUids must not be empty"));
    }
    if body.peer_uids.len() > 100 {
        return Err(AppError::BadRequest("peerUids exceeds 100 entries"));
    }

    let mut seen = HashSet::with_capacity(body.peer_uids.len());
    let mut peers = Vec::with_capacity(body.peer_uids.len());
    for &peer_uid in &body.peer_uids {
        if peer_uid <= 0 {
            return Err(AppError::BadRequest("peerUids contains an invalid uid"));
        }
        if peer_uid == body.uid {
            return Err(AppError::BadRequest("peerUids must not contain uid"));
        }
        if seen.insert(peer_uid) {
            peers.push(peer_uid);
        }
    }
    Ok(peers)
}

/// Mirrors `social::check_can_dm`: friends, and no block in either direction.
fn derive_can_dm(is_friend: bool, blocking: bool, blocked_by: bool) -> bool {
    is_friend && !blocking && !blocked_by
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(peer_uids: Vec<i32>) -> RelationshipQueryRequest {
        RelationshipQueryRequest { uid: 1, peer_uids }
    }

    #[test]
    fn relationship_request_dedupes_in_first_occurrence_order() {
        assert_eq!(
            validate_relationship_request(&request(vec![5, 5, 6])).unwrap(),
            vec![5, 6]
        );
    }

    #[test]
    fn relationship_request_rejects_invalid_payloads() {
        assert!(matches!(
            validate_relationship_request(&request(Vec::new())),
            Err(AppError::BadRequest("peerUids must not be empty"))
        ));
        assert!(matches!(
            validate_relationship_request(&request(vec![2; 101])),
            Err(AppError::BadRequest("peerUids exceeds 100 entries"))
        ));
        assert!(matches!(
            validate_relationship_request(&request(vec![0])),
            Err(AppError::BadRequest("peerUids contains an invalid uid"))
        ));
        assert!(matches!(
            validate_relationship_request(&request(vec![-1])),
            Err(AppError::BadRequest("peerUids contains an invalid uid"))
        ));
        assert!(matches!(
            validate_relationship_request(&request(vec![1])),
            Err(AppError::BadRequest("peerUids must not contain uid"))
        ));
    }

    #[test]
    fn can_dm_requires_friendship_without_blocks() {
        assert!(derive_can_dm(true, false, false));
        assert!(!derive_can_dm(false, false, false));
        assert!(!derive_can_dm(true, true, false));
        assert!(!derive_can_dm(true, false, true));
    }
}
