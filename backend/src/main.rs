use axum::body::Body;
use axum::http::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, ORIGIN};
use axum::http::{Method, Request};
use axum::{middleware, routing::get, Router};
use diesel::r2d2::ConnectionManager;
use diesel::PgConnection;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};
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
use utils::auth::{X_APP_VERSION, X_CLIENT_ID};
use utoipa::OpenApi;

mod config;
mod constants;
mod db_tracing;
mod dto;
pub mod errors;
pub mod extractors;
mod handlers;
mod metrics;
mod models;
mod openapi;
mod schema;
mod serde_i64_string;
mod services;
mod state;
mod utils;

use config::{AppConfig, LogFormat};
use state::{AppInner, DbPool};

pub use state::AppState;

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

pub const MAX_AUTO_SORT_LIMIT: usize = 20;
pub const MAX_CHATS_LIMIT: i64 = 100;
pub const MAX_CHAT_ATTACHMENTS_LIMIT: i64 = 100;
pub const MAX_MESSAGES_LIMIT: i64 = 100;
pub const MAX_MEMBERS_LIMIT: i64 = 100;
const MAX_REQUEST_BODY_BYTES: usize = 50 * 1024 * 1024;
const MESSAGE_SEARCH_REINDEX_COMMAND: &str = "message-search-reindex";

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

    let config = Arc::new(AppConfig::from_env());

    let manager = ConnectionManager::<PgConnection>::new(&config.database_url);

    // TODO: consider deadpool for pool
    let pool = DbPool::builder()
        .build(manager)
        .expect("Failed to create pool");

    {
        let mut conn = pool.get().expect("Failed to get connection for migrations");
        conn.run_pending_migrations(MIGRATIONS)
            .expect("Failed to run database migrations");
    }

    let metrics = Arc::new(metrics::Metrics::new());
    if matches!(command, Some(BackendCommand::MessageSearchReindex)) {
        if let Err(err) =
            run_message_search_reindex(pool.clone(), metrics.message_search.clone()).await
        {
            tracing::error!(?err, "message search reindex failed");
            std::process::exit(1);
        }
        return;
    }

    let message_search = build_message_search_service(metrics.message_search.clone())
        .await
        .expect("Failed to initialize message search service");

    let ws_registry = Arc::new(services::ws_registry::ConnectionRegistry::new(
        metrics.ws.clone(),
    ));
    let unread_service = Arc::new(services::unread::UnreadService::new());

    let state = AppState::new(AppInner {
        db: pool.clone(),
        id_gen: Arc::new(utils::ids::new_generator()),
        metrics: metrics.clone(),
        media: build_media_store(&config).await,
        avatars: Arc::new(services::avatars::AvatarService::new(
            config.avatars.clone(),
            metrics.avatars.clone(),
        )),
        authz_service: services::authz::AuthorizationService::start(),
        ws_registry: ws_registry.clone(),
        push_service: services::push::PushService::start(
            pool.clone(),
            ws_registry.clone(),
            metrics.push.clone(),
            unread_service.clone(),
        ),
        unread_service: unread_service.clone(),
        client_tracking: services::client_tracking::ClientTrackingService::start(
            pool.clone(),
            metrics.client_tracking.clone(),
        ),
        background_service: services::background::BackgroundService::start(
            pool.clone(),
            ws_registry.clone(),
            metrics.background.clone(),
            message_search.clone(),
            unread_service.clone(),
        ),
        message_search,
        auth_token_service: Arc::new(services::auth_token::AuthTokenService::new(
            &config.auth.jwt_signing_key,
        )),
        token_generation: services::token_generation::TokenGenerationService::start(),
        config: config.clone(),
    });

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
    let http_metrics = state.metrics.http.clone();
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
            http_metrics,
            metrics::track_http_metrics,
        ))
        .with_state(state);

    let app = app.merge(
        utoipa_swagger_ui::SwaggerUi::new("/docs").url("/api-docs/openapi.json", openapi_doc),
    );
    let app = if let Some(allowed_origins) = config.server.cors_allowed_origins.clone() {
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
                ]),
        )
    } else {
        app
    };

    let metrics_app = Router::new()
        .route("/metrics", get(metrics::metrics_handler))
        .with_state(metrics_registry);

    info!(
        "Starting API server listening on {:?}",
        config.server.app_addr
    );
    let app_listener = tokio::net::TcpListener::bind(config.server.app_addr)
        .await
        .unwrap();

    info!(
        "Starting metrics server listening on {:?}",
        config.server.metrics_addr
    );
    let metrics_listener = tokio::net::TcpListener::bind(config.server.metrics_addr)
        .await
        .unwrap();

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

async fn build_media_store(config: &AppConfig) -> services::media::MediaStore {
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let mut s3_config_builder = aws_sdk_s3::config::Builder::from(&aws_config);

    if let Some(endpoint) = config.media.endpoint_url.as_deref() {
        s3_config_builder = s3_config_builder
            .endpoint_url(endpoint)
            .force_path_style(true);
    }

    services::media::MediaStore::new(
        aws_sdk_s3::Client::from_conf(s3_config_builder.build()),
        config.media.clone(),
    )
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
    metrics: Arc<services::message_search::MessageSearchMetrics>,
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
    service.ensure_healthy().await?;
    service.start_setup_best_effort();
    info!(
        index_uid,
        "Message search enabled; index setup running in background"
    );
    Ok(Some(service))
}

async fn run_message_search_reindex(
    pool: DbPool,
    metrics: Arc<services::message_search::MessageSearchMetrics>,
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

fn init_tracing() {
    let env_filter = EnvFilter::from_default_env();
    match config::log_format_from_env() {
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
