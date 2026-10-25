use serde::{Deserialize, Serialize};

use crate::models::{GroupRole, SpeakingMode};

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSpeakingModeRequest {
    pub speaking_mode: SpeakingMode,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GroupSpeakingModeResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    pub speaking_mode: SpeakingMode,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemberSpeakingModeResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub chat_id: i64,
    pub uid: i32,
    pub role: GroupRole,
    pub speaking_mode: SpeakingMode,
    pub group_speaking_mode: SpeakingMode,
    pub effective_speaking_mode: SpeakingMode,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SpeakingRestrictedResponse {
    /// Stable machine-readable error code: speakingRestricted.
    pub code: &'static str,
    pub effective_speaking_mode: SpeakingMode,
}
