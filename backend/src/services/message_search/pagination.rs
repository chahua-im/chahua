//! Stateless pagination. Tokens bind a position to the normalized request, never grant access.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{MessageSearchFilters, MessageSearchSort};
use crate::errors::AppError;

pub const RELEVANCE_RESULT_WINDOW: usize = 1_000;
pub const MAX_CANDIDATE_BATCHES: usize = 5;
const MAX_CURSOR_LENGTH: usize = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct SearchPosition {
    pub created_at: DateTime<Utc>,
    pub id: i64,
}

/// Split numeric keys stay exact in Meilisearch, including IDs above 2^53.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexPosition {
    pub created_at_seconds: i64,
    pub created_at_subsec_micros: u32,
    pub message_id_high: i32,
    pub message_id_low: u32,
}

pub const POSITION_ATTRIBUTES: &[&str] = &[
    "createdAtSeconds",
    "createdAtSubsecMicros",
    "messageIdHigh",
    "messageIdLow",
];
pub const NEWEST_SORT: &[&str] = &[
    "createdAtSeconds:desc",
    "createdAtSubsecMicros:desc",
    "messageIdHigh:desc",
    "messageIdLow:desc",
];

impl SearchPosition {
    pub fn index(self) -> IndexPosition {
        IndexPosition {
            created_at_seconds: self.created_at.timestamp(),
            created_at_subsec_micros: self.created_at.timestamp_subsec_micros(),
            message_id_high: (self.id >> 32) as i32,
            message_id_low: self.id as u32,
        }
    }

    pub fn older_filter(self) -> String {
        let key = self.index();
        let values = [
            key.created_at_seconds,
            key.created_at_subsec_micros as i64,
            key.message_id_high as i64,
            key.message_id_low as i64,
        ];
        let mut alternatives = Vec::new();
        for i in 0..values.len() {
            let mut terms = (0..i)
                .map(|j| format!("{} = {}", POSITION_ATTRIBUTES[j], values[j]))
                .collect::<Vec<_>>();
            terms.push(format!("{} < {}", POSITION_ATTRIBUTES[i], values[i]));
            alternatives.push(format!("({})", terms.join(" AND ")));
        }
        format!("({})", alternatives.join(" OR "))
    }
}

impl IndexPosition {
    pub fn position(self) -> Option<SearchPosition> {
        if self.created_at_subsec_micros >= 1_000_000 {
            return None;
        }
        Some(SearchPosition {
            created_at: DateTime::from_timestamp(
                self.created_at_seconds,
                self.created_at_subsec_micros * 1000,
            )?,
            id: ((self.message_id_high as i64) << 32) | self.message_id_low as i64,
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SearchContinuation {
    Newest(SearchPosition),
    Relevance(usize),
}

#[derive(Serialize, Deserialize)]
struct Cursor {
    version: u8,
    context: String,
    continuation: SearchContinuation,
}

pub struct CursorContext(String);
impl CursorContext {
    pub fn new(
        uid: i32,
        chat_id: Option<i64>,
        query: Option<&str>,
        filters: MessageSearchFilters,
        sort: MessageSearchSort,
    ) -> Self {
        // No authorization snapshot: current membership is checked on every request.
        let value = serde_json::json!([uid, chat_id, query, filters, sort]);
        Self(URL_SAFE_NO_PAD.encode(Sha256::digest(value.to_string().as_bytes())))
    }

    pub fn decode(
        &self,
        token: Option<&str>,
        sort: MessageSearchSort,
    ) -> Result<Option<SearchContinuation>, AppError> {
        let Some(token) = token else {
            return Ok(None);
        };
        let invalid = || AppError::BadRequest("Invalid search cursor or changed search conditions");
        if token.len() > MAX_CURSOR_LENGTH {
            return Err(invalid());
        }
        let bytes = URL_SAFE_NO_PAD.decode(token).map_err(|_| invalid())?;
        let cursor: Cursor = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        let valid_position = match (sort, cursor.continuation) {
            (MessageSearchSort::Newest, SearchContinuation::Newest(p)) => {
                p.created_at.timestamp_subsec_nanos() % 1000 == 0
            }
            (MessageSearchSort::Relevance, SearchContinuation::Relevance(offset)) => {
                offset > 0 && offset < RELEVANCE_RESULT_WINDOW
            }
            _ => false,
        };
        if cursor.version != 2 || cursor.context != self.0 || !valid_position {
            return Err(invalid());
        }
        Ok(Some(cursor.continuation))
    }

    pub fn encode(&self, continuation: SearchContinuation) -> String {
        let cursor = Cursor {
            version: 2,
            context: self.0.clone(),
            continuation,
        };
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor).expect("search cursor is serializable"))
    }
}

#[derive(Clone, Copy)]
pub struct CandidatePageRequest {
    pub limit: usize,
    pub offset: usize,
    pub before: Option<SearchPosition>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::message_search::MessageSearchRange;

    fn filters() -> MessageSearchFilters {
        MessageSearchFilters {
            range: MessageSearchRange::All,
            sender_uid: None,
            created_from: None,
            created_before: None,
        }
    }

    #[test]
    fn cursor_rejects_changed_context_invalid_version_and_wrong_mode() {
        let sort = MessageSearchSort::Newest;
        let context = CursorContext::new(1, Some(2), Some("hello"), filters(), sort);
        let position = SearchPosition {
            created_at: "2026-11-01T00:00:00.123456Z".parse().unwrap(),
            id: i64::MAX,
        };
        let token = context.encode(SearchContinuation::Newest(position));
        assert_eq!(
            context.decode(Some(&token), sort).unwrap(),
            Some(SearchContinuation::Newest(position))
        );
        for changed in [
            CursorContext::new(2, Some(2), Some("hello"), filters(), sort),
            CursorContext::new(1, None, Some("hello"), filters(), sort),
            CursorContext::new(1, Some(2), Some("other"), filters(), sort),
            CursorContext::new(
                1,
                Some(2),
                Some("hello"),
                MessageSearchFilters {
                    sender_uid: Some(3),
                    ..filters()
                },
                sort,
            ),
            CursorContext::new(
                1,
                Some(2),
                Some("hello"),
                MessageSearchFilters {
                    range: MessageSearchRange::Thread(3),
                    ..filters()
                },
                sort,
            ),
            CursorContext::new(
                1,
                Some(2),
                Some("hello"),
                MessageSearchFilters {
                    created_before: Some(position.created_at),
                    ..filters()
                },
                sort,
            ),
        ] {
            assert!(changed.decode(Some(&token), sort).is_err());
        }
        assert!(context
            .decode(Some(&token), MessageSearchSort::Relevance)
            .is_err());
        assert!(context.decode(Some("broken"), sort).is_err());
        assert!(context
            .decode(Some(&"a".repeat(MAX_CURSOR_LENGTH + 1)), sort)
            .is_err());
        let invalid = Cursor {
            version: 3,
            context: context.0.clone(),
            continuation: SearchContinuation::Newest(position),
        };
        assert!(context
            .decode(
                Some(&URL_SAFE_NO_PAD.encode(serde_json::to_vec(&invalid).unwrap())),
                sort
            )
            .is_err());
        let relevance = CursorContext::new(
            1,
            Some(2),
            Some("hello"),
            filters(),
            MessageSearchSort::Relevance,
        );
        for offset in [0, RELEVANCE_RESULT_WINDOW, usize::MAX] {
            let token = relevance.encode(SearchContinuation::Relevance(offset));
            assert!(relevance
                .decode(Some(&token), MessageSearchSort::Relevance)
                .is_err());
        }
    }

    #[test]
    fn index_positions_preserve_large_ids_and_submillisecond_order() {
        for id in [i64::MIN, -1, 0, 1, (1i64 << 53) + 1, i64::MAX] {
            for timestamp in ["1960-01-01T00:00:00.999999Z", "2026-11-01T00:00:00.123456Z"] {
                let p = SearchPosition {
                    created_at: timestamp.parse().unwrap(),
                    id,
                };
                let key = p.index();
                assert_eq!(key.position(), Some(p));
                assert_eq!(key.created_at_seconds as f64 as i64, key.created_at_seconds);
                assert_eq!(key.message_id_high as f64 as i32, key.message_id_high);
                assert_eq!(key.message_id_low as f64 as u32, key.message_id_low);
            }
        }
    }
}
