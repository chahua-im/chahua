use std::sync::Arc;

use diesel::PgConnection;

use crate::dto::blocks::{BlockRequestBody, BlockResponse, ListBlocksResponse};
use crate::errors::AppError;
use crate::services::api::users::build_member_summary_map;
use crate::services::authentication::Principal;
use crate::services::authz::{Action as AuthzAction, AuthorizationService};
use crate::services::avatars::AvatarService;
use crate::services::presence::PresenceSnapshotService;
use crate::services::read_receipts::broadcast_pair_privacy_changed;
use crate::services::social;
use crate::services::ws_registry::ConnectionRegistry;

pub fn get_blocks(
    principal: Principal,
    conn: &mut PgConnection,
    authz_service: &AuthorizationService,
    avatars: &AvatarService,
) -> Result<ListBlocksResponse, AppError> {
    let uid =
        principal.require_user_action(conn, authz_service, AuthzAction::OnBehalfOfSocialRead)?;
    let blocks = social::list_blocks_with_since(conn, uid)?;
    let uids: Vec<i32> = blocks.iter().map(|(uid, _)| *uid).collect();
    let summaries = build_member_summary_map(conn, avatars, &uids)?;
    let blocks = blocks
        .into_iter()
        .filter_map(|(uid, since)| {
            summaries.get(&uid).map(|user| BlockResponse {
                user: user.clone(),
                since,
            })
        })
        .collect();

    Ok(ListBlocksResponse { blocks })
}

pub fn block_user(
    principal: Principal,
    body: BlockRequestBody,
    conn: &mut PgConnection,
    authz_service: &AuthorizationService,
    presence_service: &PresenceSnapshotService,
    ws_registry: &Arc<ConnectionRegistry>,
) -> Result<(), AppError> {
    let uid =
        principal.require_user_action(conn, authz_service, AuthzAction::OnBehalfOfSocialWrite)?;
    social::block_user(conn, uid, body.uid)?;
    presence_service.pair_policy_changed(uid, body.uid);
    broadcast_pair_privacy_changed(conn, ws_registry, uid, body.uid)?;
    Ok(())
}

pub fn unblock_user(
    principal: Principal,
    other: i32,
    conn: &mut PgConnection,
    authz_service: &AuthorizationService,
    presence_service: &PresenceSnapshotService,
    ws_registry: &Arc<ConnectionRegistry>,
) -> Result<(), AppError> {
    let uid =
        principal.require_user_action(conn, authz_service, AuthzAction::OnBehalfOfSocialWrite)?;
    let removed = social::unblock_user(conn, uid, other)?;
    if !removed {
        return Err(AppError::NotFound("Block not found"));
    }

    presence_service.pair_policy_changed(uid, other);
    broadcast_pair_privacy_changed(conn, ws_registry, uid, other)?;
    Ok(())
}
