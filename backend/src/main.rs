use axum::body::{Body, Bytes};
use axum::http::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, ORIGIN};
use axum::http::{Method, Request};
use axum::{middleware, routing::get, Router};
use diesel::r2d2::ConnectionManager;
use diesel::PgConnection;
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};
use std::path::{Path, PathBuf};
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
mod rpc;
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

    let command = read_command();
    if let Some(BackendCommand::ExportApiSchemas(directory)) = command.as_ref() {
        if let Err(error) = export_api_schemas(directory) {
            eprintln!("failed to export API schemas: {error}");
            std::process::exit(1);
        }
        return;
    }

    // Load TOML once, initialize logging, then resolve and validate runtime settings.
    let config = Arc::new(
        tokio::task::spawn_blocking(|| {
            let file = config::ConfigFile::from_env();
            let (format, filter) = file.logging_from_env();
            init_tracing(format, filter);
            AppConfig::from_env(file)
        })
        .await
        .expect("Failed to load application configuration"),
    );
    db_tracing::install();
    let metrics = Arc::new(metrics::Metrics::new());

    let manager = ConnectionManager::<PgConnection>::new(&config.database_url);

    // TODO: consider deadpool for pool
    let pool = DbPool::builder()
        .event_handler(Box::new(metrics.pool_events()))
        .connection_customizer(Box::new(metrics::queries::QueryConnectionCustomizer::new(
            metrics.queries.clone(),
        )))
        .build(manager)
        .expect("Failed to create pool");
    metrics.register_pool_state(pool.clone());

    {
        let mut conn = pool.get().expect("Failed to get connection for migrations");
        conn.run_pending_migrations(MIGRATIONS)
            .expect("Failed to run database migrations");
    }

    if matches!(command, Some(BackendCommand::MessageSearchReindex)) {
        let Some(search_config) = config.message_search.clone() else {
            tracing::error!(
                "MEILI_URL/message_search.meili_url and MEILI_MASTER_KEY are required for reindex"
            );
            std::process::exit(1);
        };
        if let Err(err) =
            run_message_search_reindex(pool.clone(), metrics.message_search.clone(), search_config)
                .await
        {
            tracing::error!(?err, "message search reindex failed");
            std::process::exit(1);
        }
        return;
    }

    let message_search = build_message_search_service(
        config
            .message_search
            .as_ref()
            .filter(|_| config.message_search_enabled)
            .cloned(),
        metrics.message_search.clone(),
    )
    .expect("Failed to initialize message search service");

    let ws_registry = Arc::new(services::ws_registry::ConnectionRegistry::new(
        metrics.ws.clone(),
    ));
    let unread_service = Arc::new(services::unread::UnreadService::new());
    let client_tracking = services::client_tracking::ClientTrackingService::start(
        pool.clone(),
        metrics.client_tracking.clone(),
    );
    let (activity_shutdown, shutdown_requested) = tokio::sync::oneshot::channel();
    let activity_worker = tokio::spawn(services::client_tracking::run_activity_worker(
        client_tracking.clone(),
        shutdown_requested,
    ));
    let media = build_media_store(&config).await;
    let avatars = Arc::new(services::avatars::AvatarService::new(
        config.avatars.clone(),
        metrics.avatars.clone(),
    ));
    let link_previews = services::link_previews::LinkPreviewService::start(
        pool.clone(),
        media.clone(),
        avatars.clone(),
        ws_registry.clone(),
        config.link_previews.clone(),
    );

    let state = AppState::new(AppInner {
        db: pool.clone(),
        id_gen: Arc::new(utils::ids::new_generator(config.node_id)),
        metrics: metrics.clone(),
        media,
        avatars,
        link_previews,
        authz_service: services::authz::AuthorizationService::start(),
        ws_registry: ws_registry.clone(),
        presence_service: Arc::new(services::presence::PresenceSnapshotService::new(
            pool.clone(),
            ws_registry.clone(),
            metrics.presence.clone(),
            client_tracking.last_seen.clone(),
        )),
        push_service: services::push::PushService::start(
            pool.clone(),
            ws_registry.clone(),
            metrics.push.clone(),
            unread_service.clone(),
            config.push.clone(),
        ),
        unread_service: unread_service.clone(),
        client_tracking,
        background_service: services::background::BackgroundService::start(
            pool.clone(),
            ws_registry.clone(),
            metrics.background.clone(),
            message_search.clone(),
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
            registry.prune_stale(services::ws_registry::STALE_CONNECTION_TIMEOUT_SECS);
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
    let http_metrics = state.metrics.api.clone();
    let client_tracking_state = state.clone();

    let (api_router, _) = handlers::api_router().split_for_parts();
    let openapi_doc = openapi::document();
    let openrpc_document = Bytes::from(
        serde_json::to_vec(&rpc::schema::openrpc_document())
            .expect("OpenRPC document is serializable"),
    );

    let app = Router::new()
        .route(
            "/api-docs/openrpc.json",
            get({
                let openrpc_document = openrpc_document.clone();
                move || {
                    let openrpc_document = openrpc_document.clone();
                    async move { ([(CONTENT_TYPE, "application/json")], openrpc_document) }
                }
            }),
        )
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
        .with_state(state);

    let app = app
        .merge(
            utoipa_swagger_ui::SwaggerUi::new("/docs").url("/api-docs/openapi.json", openapi_doc),
        )
        .layer(middleware::from_fn_with_state(
            http_metrics,
            metrics::track_http_metrics,
        ));
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

    let result = tokio::select! {
        result = api_server => result,
        result = metrics_server => result,
        _ = shutdown_signal() => Ok(()),
    };
    let _ = activity_shutdown.send(());
    activity_worker.await.expect("activity worker failed");
    result.unwrap();
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install termination signal handler");
        tokio::select! {
            result = tokio::signal::ctrl_c() => result.expect("install interrupt signal handler"),
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c()
        .await
        .expect("install interrupt signal handler");
}

async fn build_media_store(config: &AppConfig) -> services::media::MediaStore {
    let mut loader = aws_config::defaults(aws_config::BehaviorVersion::latest());
    if let Some(region) = config.aws_region.as_ref() {
        loader = loader.region(aws_config::Region::new(region.clone()));
    }
    let aws_config = loader.load().await;
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

#[derive(Clone, Debug, Eq, PartialEq)]
enum BackendCommand {
    MessageSearchReindex,
    ExportApiSchemas(PathBuf),
}

fn read_command() -> Option<BackendCommand> {
    let mut args = std::env::args().skip(1);
    let command = args.next()?;

    match command.as_str() {
        MESSAGE_SEARCH_REINDEX_COMMAND => {
            if args.next().is_some() {
                panic!("backend commands do not accept extra arguments");
            }
            Some(BackendCommand::MessageSearchReindex)
        }
        "--export-api-schemas" => {
            let directory = args
                .next()
                .map(PathBuf::from)
                .expect("--export-api-schemas requires exactly one directory argument");
            if args.next().is_some() {
                panic!("--export-api-schemas requires exactly one directory argument");
            }
            Some(BackendCommand::ExportApiSchemas(directory))
        }
        _ => panic!("unknown backend command: {command}"),
    }
}

fn export_api_schemas(directory: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)?;
    write_schema_file(&directory.join("openapi.json"), &openapi::document())?;
    write_schema_file(
        &directory.join("openrpc.json"),
        &rpc::schema::openrpc_document(),
    )?;
    Ok(())
}

fn write_schema_file<T: serde::Serialize>(path: &Path, document: &T) -> std::io::Result<()> {
    let content = serde_json::to_vec_pretty(document).map_err(std::io::Error::other)?;
    std::fs::write(path, content)
}

fn build_message_search_service(
    config: Option<services::message_search::MessageSearchConfig>,
    metrics: Arc<services::message_search::MessageSearchMetrics>,
) -> Result<
    Option<Arc<services::message_search::MessageSearchService>>,
    services::message_search::MessageSearchError,
> {
    let Some(config) = config else {
        info!("Message search disabled");
        return Ok(None);
    };

    let index_uid = config.index_uid.clone();
    let service = Arc::new(services::message_search::MessageSearchService::new(
        config, metrics,
    )?);
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
    config: services::message_search::MessageSearchConfig,
) -> Result<(), services::message_search::MessageSearchError> {
    let index_uid = config.index_uid.clone();
    let service = services::message_search::MessageSearchService::new(config, metrics)?;
    service.ensure_ready().await?;
    let indexed = service
        .run_reindex(&pool, services::message_search::REINDEX_BATCH_SIZE)
        .await?;
    info!(index_uid, indexed, "message search reindex completed");
    Ok(())
}

fn init_tracing(format: LogFormat, filter: String) {
    let env_filter = EnvFilter::try_new(filter).expect("RUST_LOG/logging.filter must be valid");
    match format {
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
