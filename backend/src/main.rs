use axum::body::Body;
use axum::http::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, ORIGIN};
use axum::http::{HeaderValue, Method, Request};
use axum::{middleware, routing::get, Router};
use base64::Engine;
use diesel::r2d2::{ConnectionManager, Pool};
use diesel::PgConnection;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::Arc;
use tower::ServiceBuilder;
use tower_http::cors::CorsLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::request_id::{MakeRequestId, RequestId};
use tower_http::trace::{DefaultOnRequest, DefaultOnResponse, TraceLayer};
use tower_http::LatencyUnit;
use tower_http::ServiceBuilderExt;
use tracing::{debug_span, info, Level};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use utils::auth::{X_APP_VERSION, X_CLIENT_ID, X_USER_ID};
use utoipa::OpenApi;

mod db_tracing;
mod dto;
pub(crate) mod errors;
pub(crate) mod extractors;
mod handlers;
mod metrics;
mod models;
mod openapi;
mod schema;
mod serde_i64_string;
mod services;
mod utils;

const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");

/// Produces a request ID from the `X-Request-ID` header or generates a new UUID.
#[derive(Clone, Default)]
struct RequestIdMaker;

impl MakeRequestId for RequestIdMaker {
    fn make_request_id<B>(&mut self, _request: &Request<B>) -> Option<RequestId> {
        let id = uuid::Uuid::new_v4().to_string();
        let hv = axum::http::HeaderValue::try_from(id.as_str())
            .unwrap_or_else(|_| axum::http::HeaderValue::from_static("unknown"));
        Some(RequestId::new(hv))
    }
}

pub(crate) const MAX_AUTO_SORT_LIMIT: usize = 20;
pub(crate) const MAX_CHATS_LIMIT: i64 = 100;
pub(crate) const MAX_CHAT_ATTACHMENTS_LIMIT: i64 = 100;
pub(crate) const MAX_MESSAGES_LIMIT: i64 = 100;
pub(crate) const MAX_MEMBERS_LIMIT: i64 = 100;
const MAX_REQUEST_BODY_BYTES: usize = 50 * 1024 * 1024;
const LOG_FORMAT_ENV: &str = "BACKEND_LOG_FORMAT";
const MESSAGE_SEARCH_REINDEX_COMMAND: &str = "message-search-reindex";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LogFormat {
    Pretty,
    Json,
}

#[derive(Clone, Deserialize, Default)]
pub(crate) enum AuthMethod {
    #[default]
    UIDHeader,
    Discuz,
}

#[derive(Clone)]
pub(crate) struct AppState {
    db: Pool<ConnectionManager<PgConnection>>,
    id_gen: Arc<utils::ids::IdGen>,
    metrics: Arc<metrics::Metrics>,
    authz_service: Arc<services::authz::AuthorizationService>,
    ws_registry: Arc<services::ws_registry::ConnectionRegistry>,
    push_service: Arc<services::push::PushService>,
    client_tracking: Arc<services::client_tracking::ClientTrackingService>,
    background_service: Arc<services::background::BackgroundService>,
    message_search: Option<Arc<services::message_search::MessageSearchService>>,
    s3_client: aws_sdk_s3::Client,
    s3_bucket_name: String,
    s3_attachment_prefix: String,
    s3_base_url: Option<String>,
    pub auth_method: AuthMethod,
    pub discuz_cookie_prefix: String,
    pub discuz_authkey: String,
    pub discuz_avatar_public_url: Option<String>,
    pub discuz_avatar_path: Option<String>,
    pub jwt_signing_key: Vec<u8>,
    pub service_token_hash_key: Vec<u8>,
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    // Tracing: RUST_LOG controls level (e.g. RUST_LOG=info, or
    // RUST_LOG=wetty_chat_backend=debug,tower_http=debug for request-level logs).
    // BACKEND_LOG_FORMAT controls stdout format: pretty for local development,
    // json for production collection by agents such as Grafana Alloy.
    // Responses include X-Request-ID for correlation with clients or proxies.
    init_tracing();

    db_tracing::install();
    let command = read_command();

    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let manager = ConnectionManager::<PgConnection>::new(&database_url);

    // TODO: consider deadpool for pool
    let pool = Pool::builder()
        .build(manager)
        .expect("Failed to create pool");

    {
        let mut conn = pool.get().expect("Failed to get connection for migrations");
        conn.run_pending_migrations(MIGRATIONS)
            .expect("Failed to run database migrations");
    }

    let metrics = Arc::new(metrics::Metrics::new());
    if matches!(command, Some(BackendCommand::MessageSearchReindex)) {
        if let Err(err) = run_message_search_reindex(pool.clone(), metrics.clone()).await {
            tracing::error!(?err, "message search reindex failed");
            std::process::exit(1);
        }
        return;
    }

    let message_search = build_message_search_service(metrics.clone())
        .await
        .expect("Failed to initialize message search service");

    let authz_service = services::authz::AuthorizationService::start();
    let ws_registry = Arc::new(services::ws_registry::ConnectionRegistry::new(
        metrics.clone(),
    ));

    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let mut s3_config_builder = aws_sdk_s3::config::Builder::from(&aws_config);

    if let Ok(endpoint) = std::env::var("S3_ENDPOINT_URL") {
        s3_config_builder = s3_config_builder
            .endpoint_url(endpoint)
            .force_path_style(true);
    }

    let s3_client = aws_sdk_s3::Client::from_conf(s3_config_builder.build());
    let s3_bucket_name = std::env::var("S3_BUCKET_NAME").expect("S3_BUCKET_NAME must be set");
    let s3_attachment_prefix =
        std::env::var("ATTACHMENTS_PREFIX").unwrap_or_else(|_| "attachments".to_string());
    let s3_base_url = std::env::var("S3_BASE_URL").ok();

    let auth_method_str = std::env::var("AUTH_METHOD").unwrap_or_else(|_| "UIDHeader".to_string());
    let auth_method = match auth_method_str.as_str() {
        "Discuz" => AuthMethod::Discuz,
        _ => AuthMethod::UIDHeader,
    };
    let app_addr = read_socket_addr("APP_ADDR", SocketAddr::from(([0, 0, 0, 0], 3000)));
    let metrics_addr = read_socket_addr("METRICS_ADDR", SocketAddr::from(([0, 0, 0, 0], 3001)));
    let cors_allowed_origins = read_cors_allowed_origins("CORS_ALLOWED_ORIGINS");

    let mut discuz_cookie_prefix = String::new();
    let mut discuz_authkey = String::new();
    let mut discuz_avatar_public_url = None;
    let mut discuz_avatar_path = None;

    if let AuthMethod::Discuz = auth_method {
        discuz_cookie_prefix =
            std::env::var("DISCUZ_COOKIE_PREFIX").expect("DISCUZ_COOKIE_PREFIX must be set");
        discuz_authkey = std::env::var("DISCUZ_AUTHKEY").expect("DISCUZ_AUTHKEY must be set");
        discuz_avatar_public_url = std::env::var("DISCUZ_AVATAR_PUBLIC_URL").ok();
        discuz_avatar_path = std::env::var("DISCUZ_AVATAR_PATH").ok();
    }

    let jwt_signing_key = base64::engine::general_purpose::STANDARD
        .decode(
            std::env::var("JWT_SIGNING_KEY_BASE64").expect("JWT_SIGNING_KEY_BASE64 must be set"),
        )
        .expect("JWT_SIGNING_KEY_BASE64 must be valid base64");
    assert!(
        jwt_signing_key.len() >= 32,
        "JWT_SIGNING_KEY_BASE64 must decode to at least 32 bytes"
    );

    let service_token_hash_key = match std::env::var("SERVICE_TOKEN_HASH_KEY_BASE64").ok() {
        Some(raw) => {
            let key = base64::engine::general_purpose::STANDARD
                .decode(raw)
                .expect("SERVICE_TOKEN_HASH_KEY_BASE64 must be valid base64");
            assert!(
                key.len() >= 32,
                "SERVICE_TOKEN_HASH_KEY_BASE64 must decode to at least 32 bytes"
            );
            key
        }
        None => {
            tracing::warn!(
                "SERVICE_TOKEN_HASH_KEY_BASE64 not set; falling back to JWT signing key"
            );
            jwt_signing_key.clone()
        }
    };

    let state = AppState {
        db: pool.clone(),
        id_gen: Arc::new(utils::ids::new_generator()),
        metrics: metrics.clone(),
        authz_service,
        ws_registry: ws_registry.clone(),
        push_service: services::push::PushService::start(
            pool.clone(),
            ws_registry.clone(),
            metrics.clone(),
        ),
        client_tracking: services::client_tracking::ClientTrackingService::start(
            pool.clone(),
            metrics.clone(),
        ),
        background_service: services::background::BackgroundService::start(
            pool.clone(),
            ws_registry.clone(),
            metrics.clone(),
            message_search.clone(),
        ),
        message_search,
        s3_client,
        s3_bucket_name,
        s3_attachment_prefix,
        s3_base_url,
        auth_method,
        discuz_cookie_prefix,
        discuz_authkey,
        discuz_avatar_public_url,
        discuz_avatar_path,
        jwt_signing_key,
        service_token_hash_key,
    };

    services::audio_transcode::start(state.clone());

    let registry = state.ws_registry.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            registry.prune_stale(300);
        }
    });

    // --- Sub-routers ---
    // Sub-routers are mounted via handlers::api_router()

    let trace_layer = TraceLayer::new_for_http()
        .make_span_with(|request: &Request<Body>| {
            let request_id = request
                .extensions()
                .get::<RequestId>()
                .map(|id| id.header_value().to_str().unwrap_or("").to_string())
                .unwrap_or_else(|| "".to_string());
            debug_span!(
                "request",
                method = %request.method(),
                uri = %request.uri(),
                request_id = %request_id,
            )
        })
        .on_request(DefaultOnRequest::new().level(Level::DEBUG))
        .on_response(
            DefaultOnResponse::new()
                .level(Level::DEBUG)
                .latency_unit(LatencyUnit::Micros),
        );

    let metrics_registry = state.metrics.clone();
    let client_tracking_state = state.clone();

    let (api_router, api_openapi) = handlers::api_router().split_for_parts();
    let mut openapi_doc = openapi::ApiDoc::openapi();
    openapi_doc.merge(api_openapi);

    let app = Router::new()
        .merge(api_router)
        // Keep enough headroom for sticker multipart uploads; per-feature logic still
        // enforces tighter file-size checks where needed.
        .layer(RequestBodyLimitLayer::new(MAX_REQUEST_BODY_BYTES))
        .layer(
            ServiceBuilder::new()
                .set_x_request_id(RequestIdMaker)
                .propagate_x_request_id()
                .layer(trace_layer),
        )
        .layer(middleware::from_fn_with_state(
            client_tracking_state,
            services::client_tracking::track_client_activity,
        ))
        .layer(middleware::from_fn_with_state(
            metrics_registry.clone(),
            metrics::track_http_metrics,
        ))
        .with_state(state);

    let app = app.merge(
        utoipa_swagger_ui::SwaggerUi::new("/docs").url("/api-docs/openapi.json", openapi_doc),
    );
    let app = if let Some(allowed_origins) = cors_allowed_origins {
        info!(
            allowed_origins = ?allowed_origins,
            "Enabling CORS for configured origins"
        );
        app.layer(
            CorsLayer::new()
                .allow_origin(allowed_origins)
                .allow_credentials(true)
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PUT,
                    Method::PATCH,
                    Method::DELETE,
                    Method::OPTIONS,
                ])
                .allow_headers([
                    ACCEPT,
                    AUTHORIZATION,
                    CONTENT_TYPE,
                    ORIGIN,
                    axum::http::header::HeaderName::from_static(X_APP_VERSION),
                    axum::http::header::HeaderName::from_static(X_CLIENT_ID),
                    axum::http::header::HeaderName::from_static(X_USER_ID),
                ]),
        )
    } else {
        app
    };

    let metrics_app = Router::new()
        .route("/metrics", get(metrics::metrics_handler))
        .with_state(metrics_registry);

    info!("Starting API server listening on {:?}", app_addr);
    let app_listener = tokio::net::TcpListener::bind(app_addr).await.unwrap();

    info!("Starting metrics server listening on {:?}", metrics_addr);
    let metrics_listener = tokio::net::TcpListener::bind(metrics_addr).await.unwrap();

    let api_server = axum::serve(app_listener, app);
    let metrics_server = axum::serve(metrics_listener, metrics_app);

    tokio::select! {
        result = api_server => {
            result.unwrap();
        }
        result = metrics_server => {
            result.unwrap();
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BackendCommand {
    MessageSearchReindex,
}

fn read_command() -> Option<BackendCommand> {
    let mut args = std::env::args().skip(1);
    let command = args.next()?;
    if args.next().is_some() {
        panic!("backend commands do not accept extra arguments");
    }

    match command.as_str() {
        MESSAGE_SEARCH_REINDEX_COMMAND => Some(BackendCommand::MessageSearchReindex),
        _ => panic!("unknown backend command: {command}"),
    }
}

async fn build_message_search_service(
    metrics: Arc<metrics::Metrics>,
) -> Result<
    Option<Arc<services::message_search::MessageSearchService>>,
    services::message_search::MessageSearchError,
> {
    let Some(config) = services::message_search::MessageSearchConfig::from_env()? else {
        info!("Message search disabled");
        return Ok(None);
    };

    let index_uid = config.index_uid.clone();
    let service = Arc::new(services::message_search::MessageSearchService::new(
        config, metrics,
    )?);
    service.ensure_ready().await?;
    info!(index_uid, "Message search enabled");
    Ok(Some(service))
}

async fn run_message_search_reindex(
    pool: Pool<ConnectionManager<PgConnection>>,
    metrics: Arc<metrics::Metrics>,
) -> Result<(), services::message_search::MessageSearchError> {
    let config = services::message_search::MessageSearchConfig::from_required_env()?;
    let index_uid = config.index_uid.clone();
    let service = services::message_search::MessageSearchService::new(config, metrics)?;
    service.ensure_ready().await?;
    let indexed = service
        .run_reindex(&pool, services::message_search::REINDEX_BATCH_SIZE)
        .await?;
    info!(index_uid, indexed, "message search reindex completed");
    Ok(())
}

fn read_socket_addr(var_name: &str, default: SocketAddr) -> SocketAddr {
    std::env::var(var_name)
        .ok()
        .map(|value| {
            value
                .parse()
                .unwrap_or_else(|_| panic!("{var_name} must be a valid socket address"))
        })
        .unwrap_or(default)
}

fn init_tracing() {
    let env_filter = EnvFilter::from_default_env();
    match parse_log_format(std::env::var(LOG_FORMAT_ENV).ok().as_deref()) {
        LogFormat::Pretty => tracing_subscriber::registry()
            .with(env_filter)
            .with(fmt::layer().pretty().with_target(true))
            .init(),
        LogFormat::Json => tracing_subscriber::registry()
            .with(env_filter)
            .with(fmt::layer().json().with_target(true))
            .init(),
    }
}

fn parse_log_format(value: Option<&str>) -> LogFormat {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => LogFormat::Pretty,
        Some(value) if value.eq_ignore_ascii_case("pretty") => LogFormat::Pretty,
        Some(value) if value.eq_ignore_ascii_case("json") => LogFormat::Json,
        Some(_) => panic!("{LOG_FORMAT_ENV} must be one of: pretty, json"),
    }
}

fn read_cors_allowed_origins(var_name: &str) -> Option<Vec<HeaderValue>> {
    let raw_value = std::env::var(var_name).ok()?;
    let raw_value = raw_value.trim();
    if raw_value.is_empty() {
        return None;
    }

    let origins = raw_value
        .split(',')
        .map(str::trim)
        .filter(|origin| !origin.is_empty())
        .map(|origin| {
            assert!(
                origin != "*",
                "{var_name} must list explicit origins when credentials are enabled"
            );
            HeaderValue::from_str(origin)
                .unwrap_or_else(|_| panic!("{var_name} contains an invalid origin: {origin}"))
        })
        .collect::<Vec<_>>();

    assert!(
        !origins.is_empty(),
        "{var_name} must contain at least one non-empty origin when set"
    );

    Some(origins)
}

#[cfg(test)]
mod tests {
    use super::{parse_log_format, LogFormat};

    #[test]
    fn log_format_defaults_to_pretty_when_unset() {
        assert_eq!(parse_log_format(None), LogFormat::Pretty);
    }

    #[test]
    fn log_format_accepts_json_and_pretty_case_insensitively() {
        assert_eq!(parse_log_format(Some("json")), LogFormat::Json);
        assert_eq!(parse_log_format(Some("JSON")), LogFormat::Json);
        assert_eq!(parse_log_format(Some("pretty")), LogFormat::Pretty);
        assert_eq!(parse_log_format(Some("Pretty")), LogFormat::Pretty);
    }

    #[test]
    #[should_panic(expected = "BACKEND_LOG_FORMAT must be one of: pretty, json")]
    fn log_format_rejects_unknown_values() {
        parse_log_format(Some("xml"));
    }
}
