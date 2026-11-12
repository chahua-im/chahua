use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use diesel::prelude::*;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::PgConnection;
use meilisearch_sdk::client::Client;
use meilisearch_sdk::errors::Error as MeiliError;
use meilisearch_sdk::search::{MatchingStrategies, SearchQuery, Selectors};
use meilisearch_sdk::task_info::TaskInfo;
use meilisearch_sdk::tasks::Task;
use serde::{Deserialize, Serialize};

use crate::dto::messages::MessageResponse;
use crate::models::{Message, MessageType};
use crate::schema::messages;
mod filtering;
pub mod pagination;
use pagination::{
    CandidatePageRequest, IndexPosition, SearchPosition, NEWEST_SORT, POSITION_ATTRIBUTES,
};
mod metrics;
pub use filtering::{
    load_filtered_messages, load_participant_threads, load_sender_history, HistorySearchScope,
};
pub use metrics::MessageSearchMetrics;

pub const DEFAULT_INDEX_UID: &str = "messages_v1";
pub const REINDEX_BATCH_SIZE: i64 = 500;

const SEARCHABLE_ATTRIBUTES: &[&str] = &["text"];
const FILTERABLE_ATTRIBUTES: &[&str] = &[
    "chatId",
    "messageId",
    "replyRootId",
    "senderUid",
    "createdAtMillis",
];
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
    metrics: Arc<MessageSearchMetrics>,
    setup_ready: Arc<AtomicBool>,
    cursor_ready: Arc<AtomicBool>,
}

#[derive(Debug)]
pub enum MessageSearchError {
    Config(MessageSearchConfigError),
    Meili(MeiliError),
    Db(diesel::result::Error),
    Pool(diesel::r2d2::PoolError),
    TaskFailed(String),
    InvalidPrimaryKey(Option<String>),
    InvalidHit,
    NotReady,
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
            Self::InvalidHit => write!(
                f,
                "Search index has invalid pagination keys; reindex required"
            ),
            Self::NotReady => write!(f, "message search index setup is not complete"),
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
    pub sender_uid: i32,
    pub id: String,
    pub message_id: String,
    pub chat_id: String,
    pub reply_root_id: Option<String>,
    pub created_at_millis: i64,
    #[serde(flatten)]
    pub position: IndexPosition,
    pub version: i64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageSearchHitDocument {
    message_id: String,
    version: i64,
    #[serde(flatten)]
    position: Option<IndexPosition>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchHitCandidate {
    pub message_id: i64,
    pub version: i64,
    pub position: Option<SearchPosition>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageSearchCandidatePage {
    pub candidates: Vec<SearchHitCandidate>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SearchCandidateDropCounts {
    pub missing_db_row: usize,
    pub wrong_chat: usize,
    pub wrong_scope: usize,
    pub wrong_sender: usize,
    pub wrong_date: usize,
    pub not_searchable: usize,
    pub stale_version: usize,
}

#[derive(Debug, Clone)]
pub struct AuthoritativeSearchHits {
    pub messages: Vec<Message>,
    pub drops: SearchCandidateDropCounts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum MessageSearchRange {
    All,
    Main,
    Thread(i64),
    Threads(i32),
}
impl MessageSearchRange {
    fn filter(self, chats: &str) -> String {
        match self {
            Self::Threads(_) => {
                unreachable!("thread participation search does not use the text index")
            }
            Self::All => chats.to_owned(),
            Self::Main => format!("{chats} AND replyRootId IS NULL"),
            Self::Thread(id) => {
                format!(r#"{chats} AND (messageId = "{id}" OR replyRootId = "{id}")"#)
            }
        }
    }
    fn contains(self, message: &Message) -> bool {
        match self {
            Self::Threads(_) => message.reply_root_id.is_none() && message.has_thread,
            Self::All => true,
            Self::Main => message.reply_root_id.is_none(),
            Self::Thread(id) => message.id == id || message.reply_root_id == Some(id),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct MessageSearchFilters {
    pub created_from: Option<chrono::DateTime<chrono::Utc>>,
    pub created_before: Option<chrono::DateTime<chrono::Utc>>,
    pub range: MessageSearchRange,
    pub sender_uid: Option<i32>,
}
impl MessageSearchFilters {
    fn filter(self, chats: &str) -> String {
        let mut filter = self.range.filter(chats);
        if let Some(from) = self.created_from {
            filter.push_str(&format!(
                " AND createdAtMillis >= {}",
                from.timestamp_millis()
            ));
        }
        if let Some(before) = self.created_before {
            filter.push_str(&format!(
                " AND createdAtMillis < {}",
                before.timestamp_millis()
            ));
        }
        match self.sender_uid {
            Some(uid) => format!("{filter} AND senderUid = {uid}"),
            None => filter,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum MessageSearchSort {
    Relevance,
    Newest,
}

impl MessageSearchSort {
    fn configure(self, search: &mut SearchQuery<'_, meilisearch_sdk::DefaultHttpClient>) {
        match self {
            Self::Relevance => {
                search.with_matching_strategy(MatchingStrategies::LAST);
            }
            Self::Newest => {
                search
                    .with_matching_strategy(MatchingStrategies::ALL)
                    .with_sort(NEWEST_SORT);
            }
        }
    }

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
        metrics: Arc<MessageSearchMetrics>,
    ) -> Result<Self, MessageSearchError> {
        let client = Client::new(config.meili_url, Some(config.meili_master_key))?;
        Ok(Self {
            client,
            index_uid: config.index_uid,
            metrics,
            setup_ready: Arc::new(AtomicBool::new(false)),
            cursor_ready: Arc::new(AtomicBool::new(false)),
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
        self.ensure_index_and_settings().await?;
        self.mark_setup_ready();
        Ok(())
    }

    pub fn start_setup_best_effort(self: &Arc<Self>) {
        let service = self.clone();
        tokio::spawn(async move {
            if let Err(err) = service.ensure_ready().await {
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

    pub fn is_setup_ready(&self) -> bool {
        self.setup_ready.load(Ordering::Acquire)
    }

    fn mark_setup_ready(&self) {
        self.setup_ready.store(true, Ordering::Release);
    }

    async fn ensure_index_and_settings(&self) -> Result<(), MessageSearchError> {
        self.ensure_index_exists().await?;
        self.apply_settings().await?;
        Ok(())
    }

    pub async fn search_candidates(
        &self,
        query: &str,
        chat_ids: &[i64],
        filters: MessageSearchFilters,
        sort: MessageSearchSort,
        page: CandidatePageRequest,
    ) -> Result<MessageSearchCandidatePage, MessageSearchError> {
        if !self.is_setup_ready() {
            return Err(MessageSearchError::NotReady);
        }
        if sort == MessageSearchSort::Newest {
            self.ensure_cursor_ready().await?;
        }

        let filter = format!(
            "chatId IN [{}]",
            chat_ids
                .iter()
                .map(|id| format!(r#""{id}""#))
                .collect::<Vec<_>>()
                .join(",")
        );
        let mut filter = filters.filter(&filter);
        if let Some(before) = page.before {
            filter.push_str(&format!(" AND {}", before.older_filter()));
        }
        let attributes_to_retrieve = [DISPLAYED_ATTRIBUTES, POSITION_ATTRIBUTES].concat();
        let index = self.index();
        let mut search = index.search();

        search
            .with_query(query)
            .with_filter(&filter)
            .with_limit(page.limit)
            .with_offset(page.offset)
            .with_attributes_to_retrieve(Selectors::Some(&attributes_to_retrieve));
        sort.configure(&mut search);

        let result = search.execute::<MessageSearchHitDocument>().await?;
        let has_more = result.hits.len() == page.limit;
        let candidates = result
            .hits
            .into_iter()
            .map(|hit| {
                let message_id = hit
                    .result
                    .message_id
                    .parse::<i64>()
                    .map_err(|_| MessageSearchError::InvalidHit)?;
                let position = hit.result.position.and_then(IndexPosition::position);
                if sort == MessageSearchSort::Newest && position.is_none_or(|p| p.id != message_id)
                {
                    return Err(MessageSearchError::InvalidHit);
                }
                Ok(SearchHitCandidate {
                    message_id,
                    version: hit.result.version,
                    position,
                })
            })
            .collect::<Result<Vec<_>, MessageSearchError>>()?;
        if sort == MessageSearchSort::Newest {
            let mut previous = page.before;
            for candidate in &candidates {
                let position = candidate.position.ok_or(MessageSearchError::InvalidHit)?;
                if previous.is_some_and(|p| position >= p) {
                    return Err(MessageSearchError::InvalidHit);
                }
                previous = Some(position);
            }
        }
        Ok(MessageSearchCandidatePage {
            candidates,
            has_more,
        })
    }

    async fn ensure_cursor_ready(&self) -> Result<(), MessageSearchError> {
        if self.cursor_ready.load(Ordering::Acquire) {
            return Ok(());
        }
        // Missing keys sort last, but a cursor filter would exclude them entirely.
        // Check the whole index once before enabling newest pagination. Failed
        // checks are retried so an externally completed reindex can unblock it.
        let filter = POSITION_ATTRIBUTES
            .iter()
            .map(|field| format!("{field} NOT EXISTS OR {field} IS NULL"))
            .collect::<Vec<_>>()
            .join(" OR ");
        let index = self.index();
        let hits = index
            .search()
            .with_filter(&filter)
            .with_limit(1)
            .with_attributes_to_retrieve(Selectors::Some(&["id"]))
            .execute::<serde_json::Value>()
            .await?;
        if !hits.hits.is_empty() {
            return Err(MessageSearchError::InvalidHit);
        }
        self.cursor_ready.store(true, Ordering::Release);
        Ok(())
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
        self.metrics.record_reindex(
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
        self.cursor_ready.store(false, Ordering::Release);
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
                .set_filterable_attributes(&[FILTERABLE_ATTRIBUTES, POSITION_ATTRIBUTES].concat())
                .await?,
        )
        .await?;
        self.wait_for_setup_task(
            index
                .set_sortable_attributes(&[SORTABLE_ATTRIBUTES, POSITION_ATTRIBUTES].concat())
                .await?,
        )
        .await?;
        self.wait_for_setup_task(index.set_ranking_rules(RANKING_RULES).await?)
            .await?;
        self.wait_for_setup_task(
            index
                .set_displayed_attributes(&[DISPLAYED_ATTRIBUTES, POSITION_ATTRIBUTES].concat())
                .await?,
        )
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
                self.metrics.record_index_operation(operation, "success");
                self.metrics.record_index_operation_duration(
                    operation,
                    "success",
                    duration_seconds,
                );
                self.metrics
                    .record_index_documents(operation, "success", document_count);
            }
            Err(err) => {
                self.metrics.record_index_operation(operation, "failure");
                self.metrics.record_index_operation_duration(
                    operation,
                    "failure",
                    duration_seconds,
                );
                self.metrics
                    .record_index_documents(operation, "failure", document_count);
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
        sender_uid: message.sender_uid,
        id: message.id.to_string(),
        message_id: message.id.to_string(),
        chat_id: message.chat_id.to_string(),
        reply_root_id: message.reply_root_id.map(|id| id.to_string()),
        created_at_millis: message.created_at.timestamp_millis(),
        position: SearchPosition {
            created_at: message.created_at,
            id: message.id,
        }
        .index(),
        version: message_version(message),
        text,
    })
}

#[cfg(test)]
fn filter_authoritative_hits_with_counts(
    chat_id: i64,
    candidates: &[SearchHitCandidate],
    rows: Vec<Message>,
) -> AuthoritativeSearchHits {
    filter_authoritative_hits_in_chats(&[chat_id], candidates, rows)
}

#[cfg(test)]
fn filter_authoritative_hits_in_chats(
    chat_ids: &[i64],
    candidates: &[SearchHitCandidate],
    rows: Vec<Message>,
) -> AuthoritativeSearchHits {
    filter_authoritative_hits_in_range(chat_ids, MessageSearchRange::All, candidates, rows)
}

#[cfg(test)]
fn filter_authoritative_hits_in_range(
    chat_ids: &[i64],
    range: MessageSearchRange,
    candidates: &[SearchHitCandidate],
    rows: Vec<Message>,
) -> AuthoritativeSearchHits {
    filter_authoritative_hits(
        chat_ids,
        MessageSearchFilters {
            created_from: None,
            created_before: None,
            range,
            sender_uid: None,
        },
        candidates,
        rows,
    )
}

pub fn filter_authoritative_hits(
    chat_ids: &[i64],
    filters: MessageSearchFilters,
    candidates: &[SearchHitCandidate],
    rows: Vec<Message>,
) -> AuthoritativeSearchHits {
    let chat_ids: std::collections::HashSet<_> = chat_ids.iter().copied().collect();
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

            if !chat_ids.contains(&message.chat_id) {
                drops.wrong_chat += 1;
                return None;
            }

            if !filters.range.contains(&message) {
                drops.wrong_scope += 1;
                return None;
            }

            if filters
                .sender_uid
                .is_some_and(|uid| message.sender_uid != uid)
            {
                drops.wrong_sender += 1;
                return None;
            }
            if filters
                .created_from
                .is_some_and(|from| message.created_at < from)
                || filters
                    .created_before
                    .is_some_and(|before| message.created_at >= before)
            {
                drops.wrong_date += 1;
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
        sender_uid: response.sender.uid,
        id: response.id.to_string(),
        message_id: response.id.to_string(),
        chat_id: response.chat_id.to_string(),
        reply_root_id: response.reply_root_id.map(|id| id.to_string()),
        created_at_millis: response.created_at.timestamp_millis(),
        position: SearchPosition {
            created_at: response.created_at,
            id: response.id,
        }
        .index(),
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

    use std::sync::Arc;

    use crate::models::{Message, MessageType, TranscodeStatus};

    use super::{
        filter_authoritative_hits_with_counts, normalize_search_text, project_message_document,
        validate_search_query, MessageSearchConfig, MessageSearchMetrics, MessageSearchService,
        SearchHitCandidate, RANKING_RULES, SETUP_TASK_WAIT_TIMEOUT, TASK_WAIT_TIMEOUT,
    };

    fn message(id: i64, text: Option<&str>) -> Message {
        Message {
            system_kind: None,
            forwarded_from_message_id: None,
            id,
            message: text.map(str::to_owned),
            metadata: None,
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
            forwarded_bundle_id: None,
        }
    }

    #[test]
    fn keyword_requests_serialize_matching_strategy_and_sort_together() {
        let client =
            meilisearch_sdk::client::Client::new("http://localhost:7700", None::<String>).unwrap();
        let index = client.index("messages_test");
        for (sort, strategy) in [
            (super::MessageSearchSort::Relevance, "last"),
            (super::MessageSearchSort::Newest, "all"),
        ] {
            let mut query = index.search();
            query.with_query("release plan");
            sort.configure(&mut query);
            let body = serde_json::to_value(&query).unwrap();
            assert_eq!(body["q"], "release plan");
            assert_eq!(body["matchingStrategy"], strategy);
            if strategy == "all" {
                assert_eq!(body["sort"], serde_json::json!(super::NEWEST_SORT));
            } else {
                assert!(body.get("sort").is_none());
            }
        }
    }

    #[test]
    fn keyword_date_filters_match_half_open_database_boundaries() {
        let first = message(1, Some("hello"));
        let last = message(2, Some("hello"));
        let filters = super::MessageSearchFilters {
            range: super::MessageSearchRange::All,
            sender_uid: None,
            created_from: Some(first.created_at),
            created_before: Some(last.created_at),
        };
        let filter = filters.filter("chatId = 10");
        assert!(filter.contains(&format!(
            "createdAtMillis >= {}",
            first.created_at.timestamp_millis()
        )));
        assert!(filter.contains(&format!(
            "createdAtMillis < {}",
            last.created_at.timestamp_millis()
        )));
        let rows = vec![first, last];
        let candidates = rows
            .iter()
            .map(|m| SearchHitCandidate {
                position: None,
                message_id: m.id,
                version: project_message_document(m).unwrap().version,
            })
            .collect::<Vec<_>>();
        let result = super::filter_authoritative_hits(&[10], filters, &candidates, rows);
        assert_eq!(
            result.messages.iter().map(|m| m.id).collect::<Vec<_>>(),
            vec![1]
        );
        assert_eq!(result.drops.wrong_date, 1);
    }

    #[test]
    fn sender_filter_applies_to_all_ranges_and_authoritative_hits() {
        use super::{MessageSearchFilters, MessageSearchRange as Range};
        let mut first = message(1, Some("hello"));
        first.sender_uid = 42;
        let mut second = message(2, Some("hello"));
        second.reply_root_id = Some(1);
        assert_eq!(project_message_document(&first).unwrap().sender_uid, 42);
        let rows = vec![first, second];
        let candidates = rows
            .iter()
            .map(|m| SearchHitCandidate {
                position: None,
                message_id: m.id,
                version: project_message_document(m).unwrap().version,
            })
            .collect::<Vec<_>>();
        for range in [Range::All, Range::Main, Range::Thread(1)] {
            let filters = MessageSearchFilters {
                created_from: None,
                created_before: None,
                range,
                sender_uid: Some(42),
            };
            assert!(filters
                .filter("chatId = 10")
                .ends_with(" AND senderUid = 42"));
            let result =
                super::filter_authoritative_hits(&[10], filters, &candidates, rows.clone());
            assert_eq!(
                result.messages.iter().map(|m| m.id).collect::<Vec<_>>(),
                vec![1]
            );
        }
        let result = super::filter_authoritative_hits(
            &[10],
            MessageSearchFilters {
                created_from: None,
                created_before: None,
                range: Range::All,
                sender_uid: Some(999),
            },
            &candidates,
            rows,
        );
        assert!(result.messages.is_empty());
        assert_eq!(result.drops.wrong_sender, 2);
    }

    #[test]
    fn search_ranges_include_roots_and_isolate_replies() {
        use super::{filter_authoritative_hits_in_range, MessageSearchRange as Range};
        let root = message(1, Some("root"));
        let mut reply = message(2, Some("reply"));
        reply.reply_root_id = Some(1);
        let mut other = message(3, Some("other"));
        other.reply_root_id = Some(99);
        let rows = vec![root, reply, other];
        let candidates = rows
            .iter()
            .map(|m| SearchHitCandidate {
                position: None,
                message_id: m.id,
                version: project_message_document(m).unwrap().version,
            })
            .collect::<Vec<_>>();
        for (range, ids) in [
            (Range::All, vec![1, 2, 3]),
            (Range::Main, vec![1]),
            (Range::Thread(1), vec![1, 2]),
        ] {
            let result =
                filter_authoritative_hits_in_range(&[10], range, &candidates, rows.clone());
            assert_eq!(
                result.messages.iter().map(|m| m.id).collect::<Vec<_>>(),
                ids
            );
        }
        let mut deleted = rows.clone();
        deleted[0].deleted_at = Some(Utc::now());
        let result =
            filter_authoritative_hits_in_range(&[10], Range::Thread(1), &candidates, deleted);
        assert_eq!(
            result.messages.iter().map(|m| m.id).collect::<Vec<_>>(),
            vec![2]
        );
        assert_eq!(
            Range::Main.filter("chatId = 10"),
            "chatId = 10 AND replyRootId IS NULL"
        );
        assert_eq!(
            Range::Thread(i64::MAX).filter("chatId = 10"),
            format!(
                r#"chatId = 10 AND (messageId = "{}" OR replyRootId = "{}")"#,
                i64::MAX,
                i64::MAX
            )
        );
    }

    #[test]
    fn cross_chat_hits_preserve_rank_and_recheck_access() {
        let first = message(1, Some("hello"));
        let mut second = message(2, Some("hello"));
        second.chat_id = 20;
        let mut forbidden = message(3, Some("hello"));
        forbidden.chat_id = 30;
        let rows = vec![first, second, forbidden];
        let candidates = rows
            .iter()
            .rev()
            .map(|row| SearchHitCandidate {
                position: None,
                message_id: row.id,
                version: project_message_document(row).unwrap().version,
            })
            .collect::<Vec<_>>();
        let result =
            super::filter_authoritative_hits_in_chats(&[10, 20], &candidates, rows.clone());
        assert_eq!(
            result.messages.iter().map(|m| m.id).collect::<Vec<_>>(),
            vec![2, 1]
        );
        assert_eq!(result.drops.wrong_chat, 1);
        let revoked = super::filter_authoritative_hits_in_chats(&[10], &candidates, rows.clone());
        assert_eq!(revoked.messages.len(), 1);
        assert!(
            super::filter_authoritative_hits_in_chats(&[], &candidates, rows)
                .messages
                .is_empty()
        );
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
    fn service_starts_not_ready_until_index_setup_completes() {
        let service = MessageSearchService::new(
            MessageSearchConfig {
                meili_url: "http://localhost:7700".to_string(),
                meili_master_key: "master-key".to_string(),
                index_uid: "messages_test".to_string(),
            },
            Arc::new(MessageSearchMetrics::new(&prometheus::Registry::new())),
        )
        .unwrap();

        assert!(!service.is_setup_ready());
        service.mark_setup_ready();
        assert!(service.is_setup_ready());
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
                position: None,
                message_id: edited.id,
                version: 1,
            },
            SearchHitCandidate {
                position: None,
                message_id: fresh.id,
                version: project_message_document(&fresh).unwrap().version,
            },
            SearchHitCandidate {
                position: None,
                message_id: 2,
                version: 1,
            },
            SearchHitCandidate {
                position: None,
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
                position: None,
                message_id: 99,
                version: 1,
            },
            SearchHitCandidate {
                position: None,
                message_id: wrong_chat.id,
                version: project_message_document(&wrong_chat).unwrap().version,
            },
            SearchHitCandidate {
                position: None,
                message_id: 3,
                version: 1,
            },
            SearchHitCandidate {
                position: None,
                message_id: edited.id,
                version: 1,
            },
            SearchHitCandidate {
                position: None,
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
