use serde::Deserialize;

use crate::models::GroupKind;

#[derive(Debug, Deserialize, utoipa::IntoParams, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExceptionsQuery {
    pub kind: GroupKind,
    #[serde(
        default,
        deserialize_with = "crate::serde_i64_string::opt::deserialize"
    )]
    #[param(value_type = Option<String>)]
    #[schema(schema_with = crate::serde_i64_string::schema_opt)]
    pub after: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize, utoipa::IntoParams, utoipa::ToSchema)]
pub struct ClearExceptionsQuery {
    pub kind: GroupKind,
}
