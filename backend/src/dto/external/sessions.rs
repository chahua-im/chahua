use serde::Serialize;
use utoipa::ToSchema;

/// Current session generation for a user. Session JWTs are accepted only when
/// their `gen` claim equals `tokenGen`.
#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionGenerationResponse {
    pub uid: i32,
    pub token_gen: i32,
}
