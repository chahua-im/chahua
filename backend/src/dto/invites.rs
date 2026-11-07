use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{
    dto::{groups::GroupInfoResponse, messages::MessageResponse},
    models::InviteType,
};

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InviteResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub id: i64,
    pub code: String,
    #[serde(with = "crate::serde_i64_string")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    pub invite_type: InviteType,
    pub creator_uid: Option<i32>,
    pub target_uid: Option<i32>,
    pub target_name: Option<String>,
    #[serde(with = "crate::serde_i64_string::opt")]
    #[schema(schema_with = crate::serde_i64_string::schema_opt)]
    pub required_chat_id: Option<i64>,
    pub required_chat_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub used_at: Option<DateTime<Utc>>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListInvitesResponse {
    pub invites: Vec<InviteResponse>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InvitePreviewResponse {
    pub invite: InviteResponse,
    pub chat: GroupInfoResponse,
    pub already_member: bool,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RedeemInviteResponse {
    pub chat: GroupInfoResponse,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SendInviteMessageResponse {
    pub invite: InviteResponse,
    pub message: MessageResponse,
}
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateInviteBody {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub chat_id: i64,
    pub invite_type: InviteType,
    pub target_uid: Option<i32>,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(schema_with = crate::serde_i64_string::schema_opt)]
    pub required_chat_id: Option<i64>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize, ToSchema, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct ListInvitesQuery {
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(schema_with = crate::serde_i64_string::schema_opt)]
    pub group_id: Option<i64>,
    pub limit: Option<i64>,
    pub active_only: Option<bool>,
    pub after: Option<String>,
}

#[derive(Deserialize, ToSchema, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct GetInviteByCodeQuery {
    pub invite_code: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PatchInviteBody {
    #[serde(default, deserialize_with = "double_opt_datetime::deserialize")]
    #[schema(value_type = Option<String>)]
    pub expires_at: Option<Option<DateTime<Utc>>>,
}

#[derive(Deserialize, ToSchema)]
pub struct RedeemInviteBody {
    pub code: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SendInviteMessageBody {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub source_chat_id: i64,
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    #[schema(schema_with = crate::serde_i64_string::schema)]
    pub destination_chat_id: i64,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[schema(schema_with = crate::serde_i64_string::schema_opt)]
    pub invite_id: Option<i64>,
    pub expires_at: Option<DateTime<Utc>>,
    pub client_generated_id: String,
}
mod double_opt_datetime {
    use chrono::{DateTime, Utc};
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<Option<DateTime<Utc>>>, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<DateTime<Utc>>::deserialize(deserializer).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::PatchInviteBody;
    use serde_json::json;

    #[test]
    fn expiry_patch_distinguishes_omission_clear_and_replacement() {
        let omitted: PatchInviteBody = serde_json::from_value(json!({})).unwrap();
        let clear: PatchInviteBody = serde_json::from_value(json!({"expiresAt": null})).unwrap();
        let replace: PatchInviteBody =
            serde_json::from_value(json!({"expiresAt": "2099-01-01T00:00:00Z"})).unwrap();
        assert_eq!(omitted.expires_at, None);
        assert_eq!(clear.expires_at, Some(None));
        assert_eq!(
            replace.expires_at,
            Some(Some("2099-01-01T00:00:00Z".parse().unwrap()))
        );
        assert!(
            serde_json::from_value::<PatchInviteBody>(json!({"expiresAt": "invalid"})).is_err()
        );
    }
}
