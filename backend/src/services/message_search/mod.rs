use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant};

use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::PgConnection;
use meilisearch_sdk::client::Client;
use meilisearch_sdk::errors::Error as MeiliError;
use meilisearch_sdk::search::Selectors;
use meilisearch_sdk::task_info::TaskInfo;
use meilisearch_sdk::tasks::Task;
use serde::{Deserialize, Serialize};

use crate::dto::messages::MessageResponse;
use crate::metrics::Metrics;
use crate::models::{Message, MessageType};
use crate::schema::messages;

pub const DEFAULT_INDEX_UID: &str = "messages_v1";
pub const REINDEX_BATCH_SIZE: i64 = 500;

const SEARCHABLE_ATTRIBUTES: &[&str] = &["text"];
const FILTERABLE_ATTRIBUTES: &[&str] = &["chatId"];
const SORTABLE_ATTRIBUTES: &[&str] = &["createdAtMillis"];
const RANKING_RULES: &[&str] = &[
    // `sort` is ignored for relevance searches that do not pass a sort parameter,
    // but should dominate when the user explicitly asks for newest results.
    "sort",
    "words",
    "typo",
    "proximity",
    "attributeRank",
    "wordPosition",
    "exactness",
    // Default relevance search should use recency only after text relevance ties.
    "createdAtMillis:desc",
];
const DISPLAYED_ATTRIBUTES: &[&str] = &[
    "id",
    "messageId",
    "chatId",
    "replyRootId",
    "createdAtMillis",
    "version",
];
const TASK_WAIT_INTERVAL: Duration = Duration::from_millis(50);
const TASK_WAIT_TIMEOUT: Duration = Duration::from_secs(30);
const SETUP_TASK_WAIT_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Debug)]
pub struct MessageSearchConfig {
    pub meili_url: String,
    pub meili_master_key: String,
    pub index_uid: String,
}

impl MessageSearchConfig {
    pub fn from_env() -> Result<Option<Self>, MessageSearchConfigError> {
        if !read_enabled_flag("MESSAGE_SEARCH_ENABLED")? {
            return Ok(None);
        }

        Self::from_required_env().map(Some)
    }

    pub fn from_required_env() -> Result<Self, MessageSearchConfigError> {
        let meili_url = read_required_env("MEILI_URL")?;
        let meili_master_key = read_required_env("MEILI_MASTER_KEY")?;
        let index_uid = std::env::var("MESSAGE_SEARCH_INDEX")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_INDEX_UID.to_string());

        Ok(Self {
            meili_url,
            meili_master_key,
            index_uid,
        })
    }
}

#[derive(Debug)]
pub enum MessageSearchConfigError {
    InvalidEnabledFlag(String),
    MissingEnv(&'static str),
}

impl fmt::Display for MessageSearchConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidEnabledFlag(value) => write!(
                f,
                "MESSAGE_SEARCH_ENABLED must be one of true/false/1/0/yes/no/on/off, got {value}"
            ),
            Self::MissingEnv(name) => {
                write!(f, "{name} must be set when message search is enabled")
            }
        }
    }
}

impl std::error::Error for MessageSearchConfigError {}

#[derive(Clone)]
pub struct MessageSearchService {
    client: Client,
    index_uid: String,
    metrics: Arc<Metrics>,
}

#[derive(Debug)]
pub enum MessageSearchError {
    Config(MessageSearchConfigError),
    Meili(MeiliError),
    Db(diesel::result::Error),
    Pool(diesel::r2d2::PoolError),
    TaskFailed(String),
    InvalidPrimaryKey(Option<String>),
}

impl fmt::Display for MessageSearchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Config(err) => err.fmt(f),
            Self::Meili(err) => write!(f, "meilisearch error: {err}"),
            Self::Db(err) => write!(f, "database error: {err}"),
            Self::Pool(err) => write!(f, "database pool error: {err}"),
            Self::TaskFailed(task) => write!(f, "meilisearch task failed: {task}"),
            Self::InvalidPrimaryKey(key) => {
                write!(
                    f,
                    "message search index primary key must be id, got {key:?}"
                )
            }
        }
    }
}

impl std::error::Error for MessageSearchError {}

impl From<MessageSearchConfigError> for MessageSearchError {
    fn from(err: MessageSearchConfigError) -> Self {
        Self::Config(err)
    }
}

impl From<MeiliError> for MessageSearchError {
    fn from(err: MeiliError) -> Self {
        Self::Meili(err)
    }
}

impl From<diesel::result::Error> for MessageSearchError {
    fn from(err: diesel::result::Error) -> Self {
        Self::Db(err)
    }
}

impl From<diesel::r2d2::PoolError> for MessageSearchError {
    fn from(err: diesel::r2d2::PoolError) -> Self {
        Self::Pool(err)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageSearchDocument {
    pub id: String,
    pub message_id: String,
    pub chat_id: String,
    pub reply_root_id: Option<String>,
    pub created_at_millis: i64,
    pub version: i64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageSearchHitDocument {
    message_id: String,
    version: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchHitCandidate {
    pub message_id: i64,
    pub version: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageSearchCandidatePage {
    pub candidates: Vec<SearchHitCandidate>,
    pub next_offset: Option<usize>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SearchCandidateDropCounts {
    pub missing_db_row: usize,
    pub wrong_chat: usize,
    pub not_searchable: usize,
    pub stale_version: usize,
}

#[derive(Debug, Clone)]
pub struct AuthoritativeSearchHits {
    pub messages: Vec<Message>,
    pub drops: SearchCandidateDropCounts,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum MessageSearchSort {
    Relevance,
    Newest,
}

impl MessageSearchSort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Relevance => "relevance",
            Self::Newest => "newest",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchQueryError {
    TooShort,
}

impl MessageSearchService {
    pub fn new(
        config: MessageSearchConfig,
        metrics: Arc<Metrics>,
    ) -> Result<Self, MessageSearchError> {
        let client = Client::new(config.meili_url, Some(config.meili_master_key))?;
        Ok(Self {
            client,
            index_uid: config.index_uid,
            metrics,
        })
    }

    fn index(&self) -> meilisearch_sdk::indexes::Index {
        self.client.index(&self.index_uid)
    }

    pub async fn ensure_healthy(&self) -> Result<(), MessageSearchError> {
        self.client.health().await?;
        Ok(())
    }

    pub async fn ensure_ready(&self) -> Result<(), MessageSearchError> {
        self.ensure_healthy().await?;
        self.ensure_index_and_settings().await
    }

    pub fn start_setup_best_effort(self: &Arc<Self>) {
        let service = self.clone();
        tokio::spawn(async move {
            if let Err(err) = service.ensure_index_and_settings().await {
                tracing::warn!(
                    index_uid = service.index_uid.as_str(),
                    ?err,
                    "message search index setup failed"
                );
            } else {
                tracing::info!(
                    index_uid = service.index_uid.as_str(),
                    "message search index setup completed"
                );
            }
        });
    }

    async fn ensure_index_and_settings(&self) -> Result<(), MessageSearchError> {
        self.ensure_index_exists().await?;
        self.apply_settings().await?;
        Ok(())
    }

    pub async fn search_candidates(
        &self,
        query: &str,
        chat_id: i64,
        sort: MessageSearchSort,
        limit: usize,
        offset: usize,
    ) -> Result<MessageSearchCandidatePage, MessageSearchError> {
        let filter = format!(r#"chatId = "{}""#, chat_id);
        let sort_fields = ["createdAtMillis:desc"];
        let attributes_to_retrieve = DISPLAYED_ATTRIBUTES;
        let index = self.index();
        let mut search = index.search();

        search
            .with_query(query)
            .with_filter(&filter)
            .with_limit(limit)
            .with_offset(offset)
            .with_attributes_to_retrieve(Selectors::Some(attributes_to_retrieve));
        if sort == MessageSearchSort::Newest {
            search.with_sort(&sort_fields);
        }

        let result = search.execute::<MessageSearchHitDocument>().await?;
        let candidates = result
            .hits
            .into_iter()
            .filter_map(|hit| {
                let message_id = hit.result.message_id.parse::<i64>().ok()?;
                Some(SearchHitCandidate {
                    message_id,
                    version: hit.result.version,
                })
            })
            .collect::<Vec<_>>();

        let next_offset = result
            .estimated_total_hits
            .and_then(|total| (offset + limit < total).then_some(offset + limit))
            .or_else(|| (candidates.len() == limit).then_some(offset + limit));

        Ok(MessageSearchCandidatePage {
            candidates,
            next_offset,
        })
    }

    pub fn upsert_message_best_effort(self: &Arc<Self>, message: Message) {
        match project_message_document(&message) {
            Some(document) => self.upsert_document_best_effort(document),
            None => self.delete_message_best_effort(message.id),
        }
    }

    pub fn upsert_response_best_effort(self: &Arc<Self>, response: MessageResponse) {
        if let Some(document) = project_message_response_document(&response) {
            self.upsert_document_best_effort(document);
        }
    }

    pub fn delete_message_best_effort(self: &Arc<Self>, message_id: i64) {
        let service = self.clone();
        let started_at = Instant::now();
        tokio::spawn(async move {
            service.record_index_result(
                "delete",
                1,
                started_at,
                service.delete_message(message_id).await,
            );
        });
    }

    pub fn delete_message_ids_best_effort(self: &Arc<Self>, message_ids: Vec<i64>) {
        if message_ids.is_empty() {
            return;
        }

        let service = self.clone();
        let document_count = message_ids.len();
        let started_at = Instant::now();
        tokio::spawn(async move {
            service.record_index_result(
                "delete_batch",
                document_count,
                started_at,
                service.delete_message_ids(message_ids).await,
            );
        });
    }

    pub async fn run_reindex(
        &self,
        db: &Pool<ConnectionManager<PgConnection>>,
        batch_size: i64,
    ) -> Result<usize, MessageSearchError> {
        let started_at = Instant::now();
        let result = self.run_reindex_inner(db, batch_size).await;
        let (result_label, document_count) = match &result {
            Ok(indexed) => ("success", *indexed),
            Err(_) => ("failure", 0),
        };
        self.metrics.record_message_search_reindex(
            result_label,
            started_at.elapsed().as_secs_f64(),
            document_count,
        );
        result
    }

    async fn run_reindex_inner(
        &self,
        db: &Pool<ConnectionManager<PgConnection>>,
        batch_size: i64,
    ) -> Result<usize, MessageSearchError> {
        self.ensure_index_exists().await?;
        self.apply_settings().await?;
        self.wait_for_task(self.index().delete_all_documents().await?)
            .await?;

        let mut last_id = 0_i64;
        let mut indexed = 0_usize;
        loop {
            let rows = {
                let conn = &mut db.get()?;
                load_reindex_batch(conn, last_id, batch_size)?
            };

            if rows.is_empty() {
                break;
            }

            last_id = rows.last().map(|message| message.id).unwrap_or(last_id);
            let documents = rows
                .iter()
                .filter_map(project_message_document)
                .collect::<Vec<_>>();

            if !documents.is_empty() {
                let task = self.index().add_documents(&documents, Some("id")).await?;
                self.wait_for_task(task).await?;
                indexed += documents.len();
            }

            tracing::info!(last_id, indexed, "message search reindex batch completed");

            if (rows.len() as i64) < batch_size {
                break;
            }
        }

        Ok(indexed)
    }

    async fn ensure_index_exists(&self) -> Result<(), MessageSearchError> {
        match self.client.get_index(&self.index_uid).await {
            Ok(mut index) => {
                let primary_key = index.get_primary_key().await?.map(str::to_string);
                match primary_key.as_deref() {
                    Some("id") => Ok(()),
                    None => {
                        self.wait_for_setup_task(index.set_primary_key("id").await?)
                            .await
                    }
                    Some(_) => Err(MessageSearchError::InvalidPrimaryKey(primary_key)),
                }
            }
            Err(_) => {
                let task = self
                    .client
                    .create_index(&self.index_uid, Some("id"))
                    .await?;
                self.wait_for_setup_task(task).await
            }
        }
    }

    async fn apply_settings(&self) -> Result<(), MessageSearchError> {
        let index = self.index();
        self.wait_for_setup_task(
            index
                .set_searchable_attributes(SEARCHABLE_ATTRIBUTES)
                .await?,
        )
        .await?;
        self.wait_for_setup_task(
            index
                .set_filterable_attributes(FILTERABLE_ATTRIBUTES)
                .await?,
        )
        .await?;
        self.wait_for_setup_task(index.set_sortable_attributes(SORTABLE_ATTRIBUTES).await?)
            .await?;
        self.wait_for_setup_task(index.set_ranking_rules(RANKING_RULES).await?)
            .await?;
        self.wait_for_setup_task(index.set_displayed_attributes(DISPLAYED_ATTRIBUTES).await?)
            .await?;
        Ok(())
    }

    async fn upsert_document(
        &self,
        document: MessageSearchDocument,
    ) -> Result<(), MessageSearchError> {
        self.wait_for_task(self.index().add_documents(&[document], Some("id")).await?)
            .await
    }

    async fn delete_message(&self, message_id: i64) -> Result<(), MessageSearchError> {
        self.wait_for_task(self.index().delete_document(message_id.to_string()).await?)
            .await
    }

    async fn delete_message_ids(&self, message_ids: Vec<i64>) -> Result<(), MessageSearchError> {
        let ids = message_ids
            .into_iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>();
        self.wait_for_task(self.index().delete_documents(&ids).await?)
            .await
    }

    fn upsert_document_best_effort(self: &Arc<Self>, document: MessageSearchDocument) {
        let service = self.clone();
        let started_at = Instant::now();
        tokio::spawn(async move {
            service.record_index_result(
                "upsert",
                1,
                started_at,
                service.upsert_document(document).await,
            );
        });
    }

    fn record_index_result(
        &self,
        operation: &'static str,
        document_count: usize,
        started_at: Instant,
        result: Result<(), MessageSearchError>,
    ) {
        let duration_seconds = started_at.elapsed().as_secs_f64();
        match result {
            Ok(()) => {
                self.metrics
                    .record_message_search_index_operation(operation, "success");
                self.metrics.record_message_search_index_operation_duration(
                    operation,
                    "success",
                    duration_seconds,
                );
                self.metrics.record_message_search_index_documents(
                    operation,
                    "success",
                    document_count,
                );
            }
            Err(err) => {
                self.metrics
                    .record_message_search_index_operation(operation, "failure");
                self.metrics.record_message_search_index_operation_duration(
                    operation,
                    "failure",
                    duration_seconds,
                );
                self.metrics.record_message_search_index_documents(
                    operation,
                    "failure",
                    document_count,
                );
                tracing::warn!(operation, ?err, "message search indexing operation failed");
            }
        }
    }

    async fn wait_for_task(&self, task: TaskInfo) -> Result<(), MessageSearchError> {
        self.wait_for_task_with_timeout(task, TASK_WAIT_TIMEOUT)
            .await
    }

    async fn wait_for_setup_task(&self, task: TaskInfo) -> Result<(), MessageSearchError> {
        self.wait_for_task_with_timeout(task, SETUP_TASK_WAIT_TIMEOUT)
            .await
    }

    async fn wait_for_task_with_timeout(
        &self,
        task: TaskInfo,
        timeout: Duration,
    ) -> Result<(), MessageSearchError> {
        let task = task
            .wait_for_completion(&self.client, Some(TASK_WAIT_INTERVAL), Some(timeout))
            .await?;
        ensure_task_success(task)
    }
}

pub fn normalize_search_text(input: &str) -> Option<String> {
    let mut result = String::with_capacity(input.len());
    let mut last_was_space = true;
    let mut copied_since_token = 0;
    let bytes = input.as_bytes();
    let mut i = 0;

    while i < input.len() {
        if let Some(next) = parse_mention_token_end(input, i) {
            append_normalized_segment(
                &input[copied_since_token..i],
                &mut result,
                &mut last_was_space,
            );
            copied_since_token = next;
            i = next;
            continue;
        }

        i += utf8_char_width(bytes[i]);
    }

    append_normalized_segment(
        &input[copied_since_token..],
        &mut result,
        &mut last_was_space,
    );
    if result.ends_with(' ') {
        result.pop();
    }

    (!result.is_empty()).then_some(result)
}

pub fn validate_search_query(input: &str) -> Result<String, SearchQueryError> {
    let normalized = normalize_search_text(input).ok_or(SearchQueryError::TooShort)?;
    if normalized.chars().count() < 2 {
        return Err(SearchQueryError::TooShort);
    }
    Ok(normalized)
}

pub fn project_message_document(message: &Message) -> Option<MessageSearchDocument> {
    if message.deleted_at.is_some()
        || !message.is_published
        || message.message_type != MessageType::Text
    {
        return None;
    }

    let text = normalize_search_text(message.message.as_deref()?)?;

    Some(MessageSearchDocument {
        id: message.id.to_string(),
        message_id: message.id.to_string(),
        chat_id: message.chat_id.to_string(),
        reply_root_id: message.reply_root_id.map(|id| id.to_string()),
        created_at_millis: message.created_at.timestamp_millis(),
        version: message_version(message),
        text,
    })
}

pub fn filter_authoritative_hits_with_counts(
    chat_id: i64,
    candidates: &[SearchHitCandidate],
    rows: Vec<Message>,
) -> AuthoritativeSearchHits {
    let mut rows_by_id = rows
        .into_iter()
        .map(|message| (message.id, message))
        .collect::<HashMap<_, _>>();
    let mut drops = SearchCandidateDropCounts::default();

    let messages = candidates
        .iter()
        .filter_map(|candidate| {
            let Some(message) = rows_by_id.remove(&candidate.message_id) else {
                drops.missing_db_row += 1;
                return None;
            };

            if message.chat_id != chat_id {
                drops.wrong_chat += 1;
                return None;
            }

            let Some(document) = project_message_document(&message) else {
                drops.not_searchable += 1;
                return None;
            };

            if document.version != candidate.version {
                drops.stale_version += 1;
                return None;
            }

            Some(message)
        })
        .collect();

    AuthoritativeSearchHits { messages, drops }
}

fn project_message_response_document(response: &MessageResponse) -> Option<MessageSearchDocument> {
    if response.is_deleted || response.message_type != MessageType::Text {
        return None;
    }

    let text = normalize_search_text(response.message.as_deref()?)?;

    Some(MessageSearchDocument {
        id: response.id.to_string(),
        message_id: response.id.to_string(),
        chat_id: response.chat_id.to_string(),
        reply_root_id: response.reply_root_id.map(|id| id.to_string()),
        created_at_millis: response.created_at.timestamp_millis(),
        version: response.created_at.timestamp_micros(),
        text,
    })
}

fn message_version(message: &Message) -> i64 {
    message
        .updated_at
        .unwrap_or(message.created_at)
        .timestamp_micros()
}

fn load_reindex_batch(
    conn: &mut PgConnection,
    after_id: i64,
    batch_size: i64,
) -> QueryResult<Vec<Message>> {
    use crate::schema::messages::dsl;

    messages::table
        .filter(dsl::id.gt(after_id))
        .filter(dsl::deleted_at.is_null())
        .filter(dsl::is_published.eq(true))
        .filter(dsl::message_type.eq(MessageType::Text))
        .order(dsl::id.asc())
        .limit(batch_size)
        .select(Message::as_select())
        .load(conn)
}

fn ensure_task_success(task: Task) -> Result<(), MessageSearchError> {
    if task.is_success() {
        Ok(())
    } else {
        Err(MessageSearchError::TaskFailed(format!("{task:?}")))
    }
}

fn append_normalized_segment(segment: &str, output: &mut String, last_was_space: &mut bool) {
    for ch in segment.chars() {
        if ch.is_whitespace() {
            if !*last_was_space {
                output.push(' ');
                *last_was_space = true;
            }
        } else {
            output.push(ch);
            *last_was_space = false;
        }
    }
}

fn parse_mention_token_end(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    if bytes.get(start) != Some(&b'@') || bytes.get(start + 1) != Some(&b'[') {
        return None;
    }

    let rest = text.get(start + 2..)?;
    let close = rest.find(']')?;
    let inner = &rest[..close];
    inner.strip_prefix("uid:")?.parse::<i32>().ok()?;

    Some(start + 2 + close + 1)
}

fn utf8_char_width(byte: u8) -> usize {
    if byte < 0x80 {
        1
    } else if byte < 0xE0 {
        2
    } else if byte < 0xF0 {
        3
    } else {
        4
    }
}

fn read_enabled_flag(name: &'static str) -> Result<bool, MessageSearchConfigError> {
    let Some(value) = std::env::var(name).ok() else {
        return Ok(false);
    };
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "" | "false" | "0" | "no" | "off" => Ok(false),
        "true" | "1" | "yes" | "on" => Ok(true),
        _ => Err(MessageSearchConfigError::InvalidEnabledFlag(value)),
    }
}

fn read_required_env(name: &'static str) -> Result<String, MessageSearchConfigError> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or(MessageSearchConfigError::MissingEnv(name))
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Utc};

    use crate::models::{Message, MessageType, TranscodeStatus};

    use super::{
        filter_authoritative_hits_with_counts, normalize_search_text, project_message_document,
        validate_search_query, SearchHitCandidate, RANKING_RULES, SETUP_TASK_WAIT_TIMEOUT,
        TASK_WAIT_TIMEOUT,
    };

    fn message(id: i64, text: Option<&str>) -> Message {
        Message {
            id,
            message: text.map(str::to_owned),
            message_type: MessageType::Text,
            reply_to_id: None,
            reply_root_id: None,
            client_generated_id: format!("client-{id}"),
            sender_uid: 7,
            chat_id: 10,
            created_at: Utc
                .timestamp_millis_opt(1_700_000_000_000 + id)
                .single()
                .unwrap(),
            updated_at: None,
            deleted_at: None,
            has_attachments: false,
            has_thread: false,
            has_reactions: false,
            sticker_id: None,
            is_published: true,
            transcode_status: TranscodeStatus::None,
            forwarded_from_message_id: None,
            forwarded_from_chat_id: None,
            forwarded_from_sender_uid: None,
        }
    }

    #[test]
    fn normalization_strips_mentions_and_preserves_cjk_text() {
        assert_eq!(
            normalize_search_text(" @[uid:7] 你好，世界 \n  hello\t@[uid:8] "),
            Some("你好，世界 hello".to_string())
        );
    }

    #[test]
    fn query_validation_rejects_one_character_and_accepts_two_cjk_characters() {
        assert!(validate_search_query("你").is_err());
        assert_eq!(validate_search_query("你好").unwrap(), "你好");
    }

    #[test]
    fn ranking_rules_support_newest_sort_and_relevance_recency_tiebreaker() {
        assert_eq!(RANKING_RULES.first().copied(), Some("sort"));
        assert_eq!(RANKING_RULES.last().copied(), Some("createdAtMillis:desc"));
        assert!(RANKING_RULES.contains(&"words"));
        assert!(RANKING_RULES.contains(&"attributeRank"));
        assert!(RANKING_RULES.contains(&"wordPosition"));
    }

    #[test]
    fn setup_task_timeout_is_longer_than_live_index_timeout() {
        assert!(SETUP_TASK_WAIT_TIMEOUT > TASK_WAIT_TIMEOUT);
    }

    #[test]
    fn projection_indexes_only_visible_text_messages() {
        let visible = message(1, Some("hello 你好"));
        assert_eq!(
            project_message_document(&visible).unwrap().text,
            "hello 你好"
        );

        let mut deleted = message(2, Some("deleted"));
        deleted.deleted_at = Some(Utc::now());
        assert!(project_message_document(&deleted).is_none());

        let mut unpublished = message(3, Some("draft"));
        unpublished.is_published = false;
        assert!(project_message_document(&unpublished).is_none());

        let mut non_text = message(4, Some("audio"));
        non_text.message_type = MessageType::Audio;
        assert!(project_message_document(&non_text).is_none());

        assert!(project_message_document(&message(5, Some("@[uid:7]"))).is_none());
    }

    #[test]
    fn authoritative_filter_preserves_candidate_order_and_drops_stale_rows() {
        let fresh = message(1, Some("fresh"));
        let wrong_chat = message(2, Some("wrong chat"));
        let mut deleted = message(3, Some("deleted"));
        let edited = {
            let mut msg = message(4, Some("edited"));
            msg.updated_at = Some(
                Utc.timestamp_millis_opt(1_700_000_100_000)
                    .single()
                    .unwrap(),
            );
            msg
        };
        deleted.deleted_at = Some(Utc::now());

        let rows = vec![fresh.clone(), wrong_chat, deleted, edited.clone()];
        let candidates = vec![
            SearchHitCandidate {
                message_id: edited.id,
                version: 1,
            },
            SearchHitCandidate {
                message_id: fresh.id,
                version: project_message_document(&fresh).unwrap().version,
            },
            SearchHitCandidate {
                message_id: 2,
                version: 1,
            },
            SearchHitCandidate {
                message_id: 3,
                version: 1,
            },
        ];

        let filtered = filter_authoritative_hits_with_counts(10, &candidates, rows).messages;

        assert_eq!(
            filtered
                .iter()
                .map(|message| message.id)
                .collect::<Vec<_>>(),
            vec![1]
        );
    }

    #[test]
    fn authoritative_filter_counts_drop_reasons() {
        let fresh = message(1, Some("fresh"));
        let mut wrong_chat = message(2, Some("wrong chat"));
        wrong_chat.chat_id = 11;
        let mut deleted = message(3, Some("deleted"));
        deleted.deleted_at = Some(Utc::now());
        let edited = {
            let mut msg = message(4, Some("edited"));
            msg.updated_at = Some(
                Utc.timestamp_millis_opt(1_700_000_100_000)
                    .single()
                    .unwrap(),
            );
            msg
        };

        let rows = vec![fresh.clone(), wrong_chat.clone(), deleted, edited.clone()];
        let candidates = vec![
            SearchHitCandidate {
                message_id: 99,
                version: 1,
            },
            SearchHitCandidate {
                message_id: wrong_chat.id,
                version: project_message_document(&wrong_chat).unwrap().version,
            },
            SearchHitCandidate {
                message_id: 3,
                version: 1,
            },
            SearchHitCandidate {
                message_id: edited.id,
                version: 1,
            },
            SearchHitCandidate {
                message_id: fresh.id,
                version: project_message_document(&fresh).unwrap().version,
            },
        ];

        let result = filter_authoritative_hits_with_counts(10, &candidates, rows);

        assert_eq!(
            result
                .messages
                .iter()
                .map(|message| message.id)
                .collect::<Vec<_>>(),
            vec![fresh.id]
        );
        assert_eq!(result.drops.missing_db_row, 1);
        assert_eq!(result.drops.wrong_chat, 1);
        assert_eq!(result.drops.not_searchable, 1);
        assert_eq!(result.drops.stale_version, 1);
    }
}
