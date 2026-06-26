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

        let v = Option::<StringOrNumberOrNull>::deserialize(deserializer)?;
        match v {
            None => Ok(None),
            Some(StringOrNumberOrNull::Null) => Ok(Some(None)),
            Some(StringOrNumberOrNull::Str(s)) => s
                .parse()
                .map(Some)
                .map(Some)
                .map_err(serde::de::Error::custom),
            Some(StringOrNumberOrNull::Num(n)) => Ok(Some(Some(n))),
        }
    }
}
