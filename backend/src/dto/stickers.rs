use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::models::StickerPackVisibility;

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateStickerPackBody {
    pub name: String,
    pub description: Option<String>,
    /// Defaults to public when omitted, including requests from older clients.
    #[serde(default)]
    #[schema(default = "public")]
    pub visibility: StickerPackVisibility,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStickerPackBody {
    pub name: Option<String>,
    pub description: Option<String>,
    /// Omit to keep the current visibility. Explicit null is invalid.
    #[serde(default, deserialize_with = "deserialize_visibility_update")]
    #[schema(value_type = StickerPackVisibility, required = false)]
    pub visibility: Option<StickerPackVisibility>,
}

fn deserialize_visibility_update<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<StickerPackVisibility>, D::Error> {
    StickerPackVisibility::deserialize(deserializer).map(Some)
}

#[derive(Debug, Serialize, Clone, utoipa::ToSchema)]
#[schema(as = StickersStickerMediaResponse)]
#[serde(rename_all = "camelCase")]
pub struct StickerMediaResponse {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub url: String,
    pub content_type: String,
    pub size: i64,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

#[derive(Debug, Serialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StickerSummary {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub media: StickerMediaResponse,
    pub emoji: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
    pub is_favorited: bool,
}

#[derive(Debug, Serialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StickerPackPreviewSticker {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub media: StickerMediaResponse,
    pub emoji: String,
}

#[derive(Debug, Serialize, Clone, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StickerPackSummary {
    #[serde(with = "crate::serde_i64_string")]
    #[schema(value_type = String)]
    pub id: i64,
    pub owner_uid: i32,
    pub owner_name: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub visibility: StickerPackVisibility,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub sticker_count: i64,
    pub is_subscribed: bool,
    pub preview_sticker: Option<StickerPackPreviewSticker>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StickerPackDetailResponse {
    #[serde(flatten)]
    #[schema(inline)]
    pub pack: StickerPackSummary,
    pub stickers: Vec<StickerSummary>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StickerDetailResponse {
    #[serde(flatten)]
    #[schema(inline)]
    pub sticker: StickerSummary,
    pub packs: Vec<StickerPackSummary>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StickerPackListResponse {
    pub packs: Vec<StickerPackSummary>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteStickerListResponse {
    pub stickers: Vec<StickerSummary>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum StickerPackSort {
    Subscribers,
    #[default]
    Trending,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct StickerPackDiscoveryQuery {
    /// Literal substring of the name or description, trimmed; at most 255 characters.
    #[param(max_length = 255)]
    pub q: Option<String>,
    /// Sort by current subscribers or subscribers added within the last 30 days.
    #[serde(default)]
    #[param(default = "trending")]
    pub sort: StickerPackSort,
    /// Number of packs to return.
    #[serde(default = "default_discovery_limit")]
    #[param(default = 20, minimum = 1, maximum = 50)]
    pub limit: i64,
    /// Number of matching packs to skip.
    #[serde(default)]
    #[param(default = 0, minimum = 0)]
    pub offset: i64,
}

fn default_discovery_limit() -> i64 {
    20
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StickerPackDiscoveryItem {
    #[serde(flatten)]
    #[schema(inline)]
    pub pack: StickerPackSummary,
    pub subscriber_count: i64,
    pub recent_subscriber_count: i64,
    pub preview_stickers: Vec<StickerPackPreviewSticker>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StickerPackDiscoveryResponse {
    pub packs: Vec<StickerPackDiscoveryItem>,
    pub has_more: bool,
    pub recent_window_days: i64,
    pub stats_updated_at: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn visibility_defaults_and_patch_omission_are_distinct_from_null() {
        let created: CreateStickerPackBody = serde_json::from_value(json!({"name": "猫"})).unwrap();
        assert_eq!(created.visibility, StickerPackVisibility::Public);
        let private: CreateStickerPackBody =
            serde_json::from_value(json!({"name": "猫", "visibility": "private"})).unwrap();
        assert_eq!(private.visibility, StickerPackVisibility::Private);
        let unchanged: UpdateStickerPackBody = serde_json::from_value(json!({})).unwrap();
        assert_eq!(unchanged.visibility, None);
        let public: UpdateStickerPackBody =
            serde_json::from_value(json!({"visibility": "public"})).unwrap();
        assert_eq!(public.visibility, Some(StickerPackVisibility::Public));
        for visibility in [json!(null), json!("unlisted"), json!(true)] {
            assert!(serde_json::from_value::<CreateStickerPackBody>(
                json!({"name": "猫", "visibility": visibility})
            )
            .is_err());
            assert!(serde_json::from_value::<UpdateStickerPackBody>(
                json!({"visibility": visibility})
            )
            .is_err());
        }
    }
}
