use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserGroupTagInfo {
    pub group_id: i32,
    pub name: Option<String>,
    pub chat_group_color: Option<String>,
    pub chat_group_color_dark: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub uid: i32,
    pub avatar_url: Option<String>,
    pub name: Option<String>,
    pub gender: i16,
    pub user_group: Option<UserGroupTagInfo>,
}

#[derive(Debug, Clone, serde::Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StickerPackOrderItem {
    pub sticker_pack_id: String,
    pub last_used_on: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStickerPackOrderItem {
    pub sticker_pack_id: String,
    pub last_used_on: i64,
    pub is_auto_sort: Option<bool>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStickerPackOrderRequest {
    pub order: Vec<UpdateStickerPackOrderItem>,
}

#[derive(Debug, Deserialize, ToSchema, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct SearchUsersQuery {
    pub q: Option<String>,
    pub limit: Option<i64>,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(value_type = Option<String>)]
    pub exclude_member_of: Option<i64>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub uid: i32,
    pub username: String,
    pub avatar_url: Option<String>,
    pub gender: i16,
    pub user_group: Option<UserGroupTagInfo>,
    pub sticker_pack_order: Vec<StickerPackOrderItem>,
    pub permissions: Vec<String>,
    pub mute_group_chats_by_default: bool,
    pub mute_direct_chats_by_default: bool,
    pub show_membership_messages: bool,
    pub show_unread_message_count: bool,
}

/// Account-level display preferences; omitted patches retain their stored values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettings {
    pub show_membership_messages: bool,
    /// False (default) counts chats; true counts messages for tabs and app badges.
    pub show_unread_message_count: bool,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, ToSchema, diesel::AsChangeset)]
#[serde(rename_all = "camelCase")]
#[diesel(table_name = crate::schema::user_extra)]
pub struct UpdateChatSettings {
    pub show_membership_messages: Option<bool>,
    pub show_unread_message_count: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettingsResponse {
    pub mute_group_chats_by_default: bool,
    pub mute_direct_chats_by_default: bool,
}

#[derive(Debug, Deserialize, ToSchema, diesel::AsChangeset)]
#[serde(rename_all = "camelCase")]
#[diesel(table_name = crate::schema::user_extra)]
pub struct UpdateNotificationSettingsRequest {
    pub mute_group_chats_by_default: Option<bool>,
    pub mute_direct_chats_by_default: Option<bool>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemberSummary {
    pub uid: i32,
    pub username: Option<String>,
    pub avatar_url: Option<String>,
    pub gender: i16,
    pub user_group: Option<UserGroupTagInfo>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchUsersResponse {
    pub members: Vec<MemberSummary>,
    pub excluded: Vec<MemberSummary>,
}

#[cfg(test)]
mod tests {
    use super::{MeResponse, UserGroupTagInfo};
    use serde_json::json;

    #[test]
    fn chat_settings_patch_preserves_omitted_fields() {
        let empty: super::UpdateChatSettings = serde_json::from_value(json!({})).unwrap();
        assert_eq!(empty.show_membership_messages, None);
        assert_eq!(empty.show_unread_message_count, None);
        let count: super::UpdateChatSettings =
            serde_json::from_value(json!({"showUnreadMessageCount": false})).unwrap();
        assert_eq!(count.show_membership_messages, None);
        assert_eq!(count.show_unread_message_count, Some(false));
    }

    #[test]
    fn me_response_serializes_sender_metadata() {
        let response = MeResponse {
            uid: 1,
            username: "alice".to_owned(),
            avatar_url: None,
            gender: 2,
            user_group: Some(UserGroupTagInfo {
                group_id: 3,
                name: Some("Moderator".to_owned()),
                chat_group_color: None,
                chat_group_color_dark: None,
            }),
            sticker_pack_order: vec![],
            permissions: vec![],
            mute_group_chats_by_default: true,
            mute_direct_chats_by_default: false,
            show_membership_messages: false,
            show_unread_message_count: false,
        };

        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["showMembershipMessages"], json!(false));
        assert_eq!(value["showUnreadMessageCount"], json!(false));
        assert_eq!(value["gender"], json!(2));
        assert_eq!(value["userGroup"]["groupId"], json!(3));
        assert_eq!(value["userGroup"]["name"], json!("Moderator"));
    }
}
