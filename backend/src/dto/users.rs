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
        };

        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["gender"], json!(2));
        assert_eq!(value["userGroup"]["groupId"], json!(3));
        assert_eq!(value["userGroup"]["name"], json!("Moderator"));
    }
}
