use serde::Deserialize;
use utoipa::ToSchema;

use crate::dto::conversations::{ConversationRef, ConversationView};

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationsWatchUnreadParams {
    pub request_id: u32,
    pub views: Vec<ConversationView>,
    #[serde(default)]
    pub app_badge: bool,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConversationsWatchStatesParams {
    pub request_id: u32,
    pub conversations: Vec<ConversationRef>,
}
