//! Central configuration for the backend.
//!
//! Every environment variable the server reads at startup is parsed here, in one
//! place, by [`AppConfig::from_env`]. Runtime capabilities (the S3 client, the
//! avatar lookup service, ...) are built *from* this configuration in `main`, so
//! nothing else in the crate needs to reach for `std::env`.

use axum::http::HeaderValue;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;

const LOG_FORMAT_ENV: &str = "BACKEND_LOG_FORMAT";
pub const DEFAULT_MAX_ATTACHMENT_FILE_SIZE_BYTES: i64 = 50 * 1024 * 1024;

/// Stdout log format: `pretty` for local development, `json` for production
/// collection by agents such as Grafana Alloy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LogFormat {
    Pretty,
    Json,
}

/// Where the API and metrics servers bind, and which origins may call them.
pub struct ServerConfig {
    pub app_addr: SocketAddr,
    pub metrics_addr: SocketAddr,
    pub cors_allowed_origins: Option<Vec<HeaderValue>>,
}

/// S3 object storage settings. The client itself lives in
/// [`crate::services::media::MediaStore`].
pub struct MediaConfig {
    pub bucket: String,
    pub attachment_prefix: String,
    /// Public base URL objects are served from. Defaults to the virtual-hosted
    /// bucket URL when unset.
    pub base_url: Option<String>,
    /// Custom S3 endpoint, for MinIO and friends. Forces path-style addressing.
    pub endpoint_url: Option<String>,
    pub max_attachment_file_size_bytes: i64,
}

/// Discuz avatars are served from a filesystem path mirrored behind a public URL.
/// Both halves are required, so they are modelled as one optional unit.
pub struct DiscuzAvatarConfig {
    pub public_url: String,
    pub path: String,
}

/// Authentication and token-signing material.
pub struct AuthConfig {
    /// Allows arbitrary UID impersonation. Always on in debug builds.
    pub debug_auth_enabled: bool,
    pub jwt_signing_key: Vec<u8>,
    pub service_token_hash_key: Vec<u8>,
}

/// Timing and capacity limits for the single-instance presence coordinator.
pub struct PresenceConfig {
    pub checkpoint_interval: Duration,
    pub disconnect_debounce: Duration,
    pub max_heartbeat_interval: Duration,
    pub stale_timeout: Duration,
    pub prune_interval: Duration,
    pub transition_window: Duration,
    pub per_connection_transition_limit: u32,
    pub per_uid_transition_limit: u32,
    pub command_queue_capacity: usize,
    pub persistence_queue_capacity: usize,
    pub operation_queue_capacity: usize,
    pub max_retry_backoff: Duration,
    pub unknown_connection_threshold: Duration,
}

pub struct AppConfig {
    pub server: ServerConfig,
    pub database_url: String,
    pub media: Arc<MediaConfig>,
    pub avatars: Option<Arc<DiscuzAvatarConfig>>,
    pub auth: AuthConfig,
    pub presence: PresenceConfig,
}

impl AppConfig {
    /// Reads and validates the full environment. Panics with an actionable
    /// message on anything missing or malformed — the server cannot serve
    /// traffic without it, so failing at startup is the correct behaviour.
    pub fn from_env() -> Self {
        let jwt_signing_key = decode_key_at_least_32_bytes(
            "JWT_SIGNING_KEY_BASE64",
            std::env::var("JWT_SIGNING_KEY_BASE64")
                .expect("JWT_SIGNING_KEY_BASE64 must be set")
                .as_str(),
        );

        let service_token_hash_key = match std::env::var("SERVICE_TOKEN_HASH_KEY_BASE64").ok() {
            Some(raw) => decode_key_at_least_32_bytes("SERVICE_TOKEN_HASH_KEY_BASE64", &raw),
            None => {
                tracing::warn!(
                    "SERVICE_TOKEN_HASH_KEY_BASE64 not set; falling back to JWT signing key"
                );
                jwt_signing_key.clone()
            }
        };

        let debug_auth_enabled = debug_auth_enabled(
            cfg!(debug_assertions),
            std::env::var("ENABLE_DEBUG_AUTH").ok().as_deref(),
        );
        if debug_auth_enabled {
            tracing::warn!(
                "Development authentication is enabled; arbitrary UID impersonation is available"
            );
        }

        Self {
            server: ServerConfig {
                app_addr: read_socket_addr("APP_ADDR", SocketAddr::from(([0, 0, 0, 0], 3000))),
                metrics_addr: read_socket_addr(
                    "METRICS_ADDR",
                    SocketAddr::from(([0, 0, 0, 0], 3001)),
                ),
                cors_allowed_origins: read_cors_allowed_origins("CORS_ALLOWED_ORIGINS"),
            },
            database_url: std::env::var("DATABASE_URL").expect("DATABASE_URL must be set"),
            media: Arc::new(MediaConfig {
                bucket: std::env::var("S3_BUCKET_NAME").expect("S3_BUCKET_NAME must be set"),
                attachment_prefix: std::env::var("ATTACHMENTS_PREFIX")
                    .unwrap_or_else(|_| "attachments".to_string()),
                base_url: std::env::var("S3_BASE_URL").ok(),
                endpoint_url: std::env::var("S3_ENDPOINT_URL").ok(),
                max_attachment_file_size_bytes: read_positive_i64_env(
                    "ATTACHMENT_MAX_FILE_SIZE_BYTES",
                    DEFAULT_MAX_ATTACHMENT_FILE_SIZE_BYTES,
                ),
            }),
            avatars: read_discuz_avatar_config().map(Arc::new),
            auth: AuthConfig {
                debug_auth_enabled,
                jwt_signing_key,
                service_token_hash_key,
            },
            presence: read_presence_config(),
        }
    }
}

/// Read separately from [`AppConfig::from_env`]: tracing must be initialised
/// before anything else so that configuration errors are themselves logged.
pub fn log_format_from_env() -> LogFormat {
    parse_log_format(std::env::var(LOG_FORMAT_ENV).ok().as_deref())
}

fn parse_log_format(value: Option<&str>) -> LogFormat {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => LogFormat::Pretty,
        Some(value) if value.eq_ignore_ascii_case("pretty") => LogFormat::Pretty,
        Some(value) if value.eq_ignore_ascii_case("json") => LogFormat::Json,
        Some(_) => panic!("{LOG_FORMAT_ENV} must be one of: pretty, json"),
    }
}

fn debug_auth_enabled(debug_build: bool, raw_env: Option<&str>) -> bool {
    debug_build || raw_env == Some("true")
}

fn read_positive_i64_env(var_name: &str, default: i64) -> i64 {
    match std::env::var(var_name) {
        Ok(raw) => raw
            .parse::<i64>()
            .ok()
            .filter(|value| *value > 0)
            .unwrap_or_else(|| panic!("{var_name} must be a positive integer")),
        Err(std::env::VarError::NotPresent) => default,
        Err(std::env::VarError::NotUnicode(_)) => {
            panic!("{var_name} must be a positive integer")
        }
    }
}

fn read_positive_u64_env(var_name: &str, default: u64) -> u64 {
    match std::env::var(var_name) {
        Ok(raw) => raw
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0)
            .unwrap_or_else(|| panic!("{var_name} must be a positive integer")),
        Err(std::env::VarError::NotPresent) => default,
        Err(std::env::VarError::NotUnicode(_)) => {
            panic!("{var_name} must be a positive integer")
        }
    }
}

fn read_presence_config() -> PresenceConfig {
    let checkpoint_interval = read_positive_u64_env("PRESENCE_CHECKPOINT_INTERVAL_SECS", 5 * 60);
    let disconnect_debounce = read_positive_u64_env("PRESENCE_DISCONNECT_DEBOUNCE_SECS", 45);
    let max_heartbeat_interval = read_positive_u64_env("PRESENCE_MAX_HEARTBEAT_INTERVAL_SECS", 30);
    let stale_timeout = read_positive_u64_env("PRESENCE_STALE_TIMEOUT_SECS", 90);
    assert!(
        stale_timeout >= max_heartbeat_interval * 3,
        "PRESENCE_STALE_TIMEOUT_SECS must be at least three times PRESENCE_MAX_HEARTBEAT_INTERVAL_SECS"
    );

    PresenceConfig {
        checkpoint_interval: Duration::from_secs(checkpoint_interval),
        disconnect_debounce: Duration::from_secs(disconnect_debounce),
        max_heartbeat_interval: Duration::from_secs(max_heartbeat_interval),
        stale_timeout: Duration::from_secs(stale_timeout),
        prune_interval: Duration::from_secs(read_positive_u64_env(
            "PRESENCE_PRUNE_INTERVAL_SECS",
            60,
        )),
        transition_window: Duration::from_secs(read_positive_u64_env(
            "PRESENCE_TRANSITION_WINDOW_SECS",
            10,
        )),
        per_connection_transition_limit: read_positive_u64_env(
            "PRESENCE_PER_CONNECTION_TRANSITION_LIMIT",
            12,
        ) as u32,
        per_uid_transition_limit: read_positive_u64_env("PRESENCE_PER_UID_TRANSITION_LIMIT", 20)
            as u32,
        command_queue_capacity: read_positive_u64_env("PRESENCE_COMMAND_QUEUE_CAPACITY", 4096)
            as usize,
        persistence_queue_capacity: read_positive_u64_env(
            "PRESENCE_PERSISTENCE_QUEUE_CAPACITY",
            256,
        ) as usize,
        operation_queue_capacity: read_positive_u64_env("PRESENCE_OPERATION_QUEUE_CAPACITY", 64)
            as usize,
        max_retry_backoff: Duration::from_secs(read_positive_u64_env(
            "PRESENCE_MAX_RETRY_BACKOFF_SECS",
            60,
        )),
        unknown_connection_threshold: Duration::from_secs(read_positive_u64_env(
            "PRESENCE_UNKNOWN_CONNECTION_THRESHOLD_SECS",
            60,
        )),
    }
}

fn decode_key_at_least_32_bytes(var_name: &str, raw: &str) -> Vec<u8> {
    let key = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .unwrap_or_else(|_| panic!("{var_name} must be valid base64"));
    assert!(
        key.len() >= 32,
        "{var_name} must decode to at least 32 bytes"
    );
    key
}

/// Both halves are required to resolve an avatar. Configuring only one disables
/// avatars, matching the previous behaviour, but is loud about it — it is almost
/// certainly a deployment mistake.
fn read_discuz_avatar_config() -> Option<DiscuzAvatarConfig> {
    match (
        std::env::var("DISCUZ_AVATAR_PUBLIC_URL").ok(),
        std::env::var("DISCUZ_AVATAR_PATH").ok(),
    ) {
        (Some(public_url), Some(path)) => Some(DiscuzAvatarConfig { public_url, path }),
        (None, None) => None,
        _ => {
            tracing::warn!(
                "Only one of DISCUZ_AVATAR_PUBLIC_URL / DISCUZ_AVATAR_PATH is set; \
                 avatar resolution is disabled"
            );
            None
        }
    }
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
    use super::{
        debug_auth_enabled, parse_log_format, read_positive_i64_env, LogFormat,
        DEFAULT_MAX_ATTACHMENT_FILE_SIZE_BYTES,
    };

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

    #[test]
    fn debug_auth_gate_requires_exact_release_override() {
        assert!(debug_auth_enabled(true, None));
        assert!(debug_auth_enabled(true, Some("TRUE")));
        assert!(debug_auth_enabled(false, Some("true")));
        assert!(!debug_auth_enabled(false, None));
        assert!(!debug_auth_enabled(false, Some("TRUE")));
        assert!(!debug_auth_enabled(false, Some("1")));
        assert!(!debug_auth_enabled(false, Some(" true ")));
    }

    #[test]
    fn attachment_size_default_is_fifty_mebibytes() {
        assert_eq!(DEFAULT_MAX_ATTACHMENT_FILE_SIZE_BYTES, 52_428_800);
    }

    #[test]
    fn attachment_size_parser_accepts_positive_values() {
        std::env::set_var("ATTACHMENT_MAX_FILE_SIZE_BYTES", "1024");
        assert_eq!(
            read_positive_i64_env("ATTACHMENT_MAX_FILE_SIZE_BYTES", 1),
            1024
        );
        std::env::remove_var("ATTACHMENT_MAX_FILE_SIZE_BYTES");
    }
}
