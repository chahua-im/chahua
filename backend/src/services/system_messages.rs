//! Persist link destinations alongside system text without changing legacy client text.
use serde::{Deserialize, Serialize};

use crate::{
    dto::messages::SystemMessageLinks,
    models::{GroupKind, MessageType},
};

/// Keep this literal identical to the partial-index predicate.
pub const NON_MEMBERSHIP_PREDICATE: &str = "(system_kind IS NULL OR system_kind NOT IN ('member_joined', 'member_left', 'member_added', 'member_removed'))";

/// Shared by the correlated chat-preview SQL and bulk membership joins.
/// Keeping one predicate avoids per-user policy queries in fanout and unread paths.
pub const MEMBERSHIP_ALLOWED_PREDICATE: &str = "(groups.kind = 'dm' OR groups.membership_message_visibility = 'members' OR (groups.membership_message_visibility = 'admins' AND group_membership.role = 'admin'))";

pub fn membership_allowed() -> diesel::expression::SqlLiteral<diesel::sql_types::Bool> {
    diesel::dsl::sql(MEMBERSHIP_ALLOWED_PREDICATE)
}

pub fn hides_membership_messages(
    show_membership_messages: bool,
    kind: GroupKind,
    thread_id: Option<i64>,
) -> bool {
    !show_membership_messages && kind == GroupKind::Group && thread_id.is_none()
}

pub fn load_membership_message_filter(
    conn: &mut diesel::PgConnection,
    uid: i32,
    chat_id: i64,
) -> diesel::QueryResult<bool> {
    let (settings, kind, policy) = super::user::load_chat_settings_for_chat(conn, uid, chat_id)?;
    Ok(hides_membership_messages(
        settings.show_membership_messages && policy.can_view,
        kind,
        None,
    ))
}

#[derive(Serialize, Deserialize)]
struct StoredSystemMessage {
    text: String,
    links: SystemMessageLinks,
}

pub fn with_user(text: String, uid: i32) -> String {
    serde_json::json!({ "text": text, "links": { "uid": uid } }).to_string()
}

pub fn with_message(text: &str, message_id: i64) -> String {
    serde_json::json!({ "text": text, "links": { "messageId": message_id.to_string() } })
        .to_string()
}

/// Legacy system strings and ordinary user text pass through unchanged.
pub fn decode(
    message_type: &MessageType,
    message: Option<String>,
) -> (Option<String>, Option<SystemMessageLinks>) {
    if *message_type == MessageType::System {
        if let Some(stored) = message
            .as_deref()
            .and_then(|text| serde_json::from_str::<StoredSystemMessage>(text).ok())
        {
            return (Some(stored.text), Some(stored.links));
        }
    }
    (message, None)
}

/// Notify members to reload the current policy; event delivery order carries no state.
pub fn broadcast_policy(
    conn: &mut diesel::PgConnection,
    registry: &super::ws_registry::ConnectionRegistry,
    chat_id: i64,
) -> diesel::QueryResult<()> {
    use crate::{
        dto::{groups::MembershipMessagePolicyChanged, ws::ServerWsMessage},
        schema::group_membership,
    };
    use diesel::prelude::*;
    let uids = group_membership::table
        .filter(group_membership::chat_id.eq(chat_id))
        .select(group_membership::uid)
        .load::<i32>(conn)?;
    registry.broadcast_to_uids(
        &uids,
        std::sync::Arc::new(ServerWsMessage::MembershipMessagePolicyChanged(
            MembershipMessagePolicyChanged { chat_id },
        )),
    );
    registry.invalidate_unread(&uids);
    Ok(())
}

#[cfg(test)]
mod tests;
