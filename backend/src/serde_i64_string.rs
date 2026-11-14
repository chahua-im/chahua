//! Serialize i64 as JSON string (for JS safe integer range); deserialize from string or number.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub fn serialize<S>(value: &i64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    value.to_string().serialize(serializer)
}

pub fn deserialize<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StringOrNumber {
        Str(String),
        Num(i64),
    }
    match StringOrNumber::deserialize(deserializer)? {
        StringOrNumber::Str(s) => s.parse().map_err(serde::de::Error::custom),
        StringOrNumber::Num(n) => Ok(n),
    }
}

pub mod opt {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S>(value: &Option<i64>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match value {
            Some(v) => v.to_string().serialize(serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum StringOrNumberOrNull {
            Str(String),
            Num(i64),
            Null,
        }
        let v = Option::<StringOrNumberOrNull>::deserialize(deserializer)?;
        match v {
            None => Ok(None),
            Some(StringOrNumberOrNull::Null) => Ok(None),
            Some(StringOrNumberOrNull::Str(s)) => {
                s.parse().map(Some).map_err(serde::de::Error::custom)
            }
            Some(StringOrNumberOrNull::Num(n)) => Ok(Some(n)),
        }
    }
}

pub mod vec {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<i64>, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum StringOrNumber {
            Str(String),
            Num(i64),
        }

        Vec::<StringOrNumber>::deserialize(deserializer)?
            .into_iter()
            .map(|value| match value {
                StringOrNumber::Str(s) => s.parse().map_err(serde::de::Error::custom),
                StringOrNumber::Num(n) => Ok(n),
            })
            .collect()
    }
}

pub mod double_opt {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<Option<i64>>, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum StringOrNumberOrNull {
            Str(String),
            Num(i64),
            Null,
        }

        let v = StringOrNumberOrNull::deserialize(deserializer)?;
        match v {
            StringOrNumberOrNull::Null => Ok(Some(None)),
            StringOrNumberOrNull::Str(s) => s
                .parse()
                .map(Some)
                .map(Some)
                .map_err(serde::de::Error::custom),
            StringOrNumberOrNull::Num(n) => Ok(Some(Some(n))),
        }
    }
}

/// Wire schema shared by HTTP and RPC codecs; the marker is not a validation rule.
pub fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
    serde_json::from_value(serde_json::json!({"type": "string", "x-snowflake-id": true}))
        .expect("valid static Snowflake schema")
}

pub fn schema_opt() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
    serde_json::from_value(serde_json::json!({
        "oneOf": [{"type": "string", "x-snowflake-id": true}, {"type": "null"}],
    }))
    .expect("valid static optional Snowflake schema")
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Deserialize)]
    struct AvatarPatch {
        #[serde(default, deserialize_with = "super::double_opt::deserialize")]
        avatar_image_id: Option<Option<i64>>,
    }

    #[test]
    fn nullable_id_patch_preserves_clear_omission_and_lossless_replacement() {
        let omitted: AvatarPatch = serde_json::from_value(json!({})).unwrap();
        let cleared: AvatarPatch =
            serde_json::from_value(json!({"avatar_image_id": null})).unwrap();
        let replaced: AvatarPatch =
            serde_json::from_value(json!({"avatar_image_id": "9007199254740993"})).unwrap();
        assert_eq!(omitted.avatar_image_id, None);
        assert_eq!(cleared.avatar_image_id, Some(None));
        assert_eq!(replaced.avatar_image_id, Some(Some(9_007_199_254_740_993)));
        assert!(
            serde_json::from_value::<AvatarPatch>(json!({"avatar_image_id": "invalid"})).is_err()
        );
    }
}
