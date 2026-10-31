pub mod attachments;
pub mod auth;
pub mod blocks;
pub mod chats;
pub mod conversations;
pub mod friends;
pub mod groups;
pub mod invites;
pub mod messages;
pub mod notifications;
pub mod pins;
pub mod presence;
pub mod privacy;
pub mod push;
pub mod reactions;
pub mod saved_messages;
pub mod service_tokens;
pub mod session;
pub mod sessions;
pub mod stickers;
pub mod threads;
pub mod users;

/// RPC path IDs use decimal strings. Existing business DTO serde remains unchanged.
pub fn deserialize_id<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = <String as serde::Deserialize>::deserialize(deserializer)?;
    value.parse().map_err(serde::de::Error::custom)
}
