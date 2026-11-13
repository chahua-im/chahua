//! Central startup configuration. Secrets are read only from the environment.

mod link_previews;
pub use link_previews::{LinkPreviewConfig, LinkPreviewSettings};

use axum::http::HeaderValue;
use base64::Engine;
use serde::Deserialize;
use std::{net::SocketAddr, sync::Arc};

pub const DEFAULT_MAX_ATTACHMENT_FILE_SIZE_BYTES: i64 = 50 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LogFormat {
    Pretty,
    Json,
}

pub struct ServerConfig {
    pub app_addr: SocketAddr,
    pub metrics_addr: SocketAddr,
    pub cors_allowed_origins: Option<Vec<HeaderValue>>,
}

pub struct MediaConfig {
    pub bucket: String,
    pub attachment_prefix: String,
    pub base_url: Option<String>,
    pub endpoint_url: Option<String>,
    pub upload_proxy_path: Option<String>,
    pub max_attachment_file_size_bytes: i64,
}

pub struct DiscuzAvatarConfig {
    pub public_url: String,
    pub path: String,
}

pub struct AuthConfig {
    pub debug_auth_enabled: bool,
    pub jwt_signing_key: Vec<u8>,
    pub service_token_hash_key: Vec<u8>,
}

pub struct PushConfig {
    pub vapid_public_key: String,
    pub vapid_private_key: String,
    pub vapid_subject: String,
    pub apns: Option<ApnsConfig>,
}

pub struct ApnsConfig {
    pub key_id: String,
    pub team_id: String,
    pub private_key_path: String,
    pub topic: String,
}

pub struct AppConfig {
    pub server: ServerConfig,
    pub database_url: String,
    pub media: Arc<MediaConfig>,
    pub link_previews: Arc<LinkPreviewConfig>,
    pub avatars: Option<Arc<DiscuzAvatarConfig>>,
    pub auth: AuthConfig,
    pub aws_region: Option<String>,
    pub node_id: u64,
    pub message_search_enabled: bool,
    pub message_search: Option<crate::services::message_search::MessageSearchConfig>,
    pub push: Option<Arc<PushConfig>>,
}

// These types deliberately contain no secret fields. Strict deserialization also
// rejects misspelled keys and attempts to put secrets in the configuration file.
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ConfigFile {
    server: ServerSettings,
    media: MediaSettings,
    auth: AuthSettings,
    avatars: AvatarSettings,
    message_search: SearchSettings,
    push: PushSettings,
    ids: IdSettings,
    logging: LoggingSettings,
    link_previews: LinkPreviewSettings,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ServerSettings {
    app_addr: Option<String>,
    metrics_addr: Option<String>,
    cors_allowed_origins: Option<Vec<String>>,
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct MediaSettings {
    bucket: Option<String>,
    attachment_prefix: Option<String>,
    base_url: Option<String>,
    endpoint_url: Option<String>,
    upload_proxy_path: Option<String>,
    max_attachment_file_size_bytes: Option<i64>,
    region: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct AuthSettings {
    debug_auth_enabled: Option<bool>,
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct AvatarSettings {
    public_url: Option<String>,
    path: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct SearchSettings {
    enabled: Option<bool>,
    meili_url: Option<String>,
    index_uid: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct PushSettings {
    vapid_public_key: Option<String>,
    vapid_subject: Option<String>,
    apns: ApnsSettings,
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ApnsSettings {
    key_id: Option<String>,
    team_id: Option<String>,
    topic: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct IdSettings {
    node_id: Option<u64>,
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct LoggingSettings {
    format: Option<String>,
    filter: Option<String>,
}

impl ConfigFile {
    /// Load the optional file once, before logging and application setup.
    pub fn from_env() -> Self {
        Self::load_with(|name| match std::env::var(name) {
            Ok(value) => Some(value),
            Err(std::env::VarError::NotPresent) => None,
            Err(std::env::VarError::NotUnicode(_)) => {
                panic!("CHAHUA_CONFIG_PATH must be valid Unicode")
            }
        })
        .unwrap_or_else(|error| panic!("{error}"))
    }

    fn load_with(env: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let Some(path) = env("CHAHUA_CONFIG_PATH") else {
            return Ok(Self::default());
        };
        let contents = match std::fs::read_to_string(path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Tracing is initialized only after loading the file's logging settings.
                eprintln!("warning: CHAHUA_CONFIG_PATH file not found; using environment variables and defaults");
                return Ok(Self::default());
            }
            Err(_) => return Err("CHAHUA_CONFIG_PATH could not be read".to_string()),
        };
        toml::from_str(&contents)
            .map_err(|_| "CHAHUA_CONFIG_PATH contains invalid or unknown configuration".to_string())
    }

    pub fn logging_from_env(&self) -> (LogFormat, String) {
        self.logging_with(|name| std::env::var(name).ok())
    }

    fn logging_with(&self, env: impl Fn(&str) -> Option<String>) -> (LogFormat, String) {
        let format = env("BACKEND_LOG_FORMAT").or_else(|| self.logging.format.clone());
        let format = match format.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            None => LogFormat::Pretty,
            Some(v) if v.eq_ignore_ascii_case("pretty") => LogFormat::Pretty,
            Some(v) if v.eq_ignore_ascii_case("json") => LogFormat::Json,
            _ => panic!("logging format must be one of: pretty, json"),
        };
        (
            format,
            env("RUST_LOG")
                .or_else(|| self.logging.filter.clone())
                .unwrap_or_else(|| "error".into()),
        )
    }
}

impl AppConfig {
    pub fn from_env(file: ConfigFile) -> Self {
        Self::resolve(
            file,
            |name| std::env::var(name).ok(),
            cfg!(debug_assertions),
        )
    }

    fn resolve(file: ConfigFile, env: impl Fn(&str) -> Option<String>, debug_build: bool) -> Self {
        let ConfigFile {
            server,
            media,
            auth,
            avatars,
            message_search,
            push,
            ids,
            logging: _,
            link_previews,
        } = file;
        let jwt_signing_key = decode_key(
            "JWT_SIGNING_KEY_BASE64",
            &required(env("JWT_SIGNING_KEY_BASE64"), "JWT_SIGNING_KEY_BASE64"),
        );
        let service_token_hash_key = match env("SERVICE_TOKEN_HASH_KEY_BASE64") {
            Some(raw) => decode_key("SERVICE_TOKEN_HASH_KEY_BASE64", &raw),
            None => {
                tracing::warn!(
                    "SERVICE_TOKEN_HASH_KEY_BASE64 not set; falling back to JWT signing key"
                );
                jwt_signing_key.clone()
            }
        };
        let debug_override = match env("ENABLE_DEBUG_AUTH") {
            Some(value) => match value.as_str() {
                "true" => true,
                "false" => false,
                _ => panic!("ENABLE_DEBUG_AUTH must be true or false"),
            },
            None => auth.debug_auth_enabled.unwrap_or(false),
        };
        let debug_auth_enabled = debug_build || debug_override;
        if debug_auth_enabled {
            tracing::warn!(
                "Development authentication is enabled; arbitrary UID impersonation is available"
            );
        }
        let origins = match env("CORS_ALLOWED_ORIGINS") {
            Some(raw) if raw.trim().is_empty() => None,
            Some(raw) => {
                let values: Vec<_> = raw
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect();
                assert!(
                    !values.is_empty(),
                    "CORS_ALLOWED_ORIGINS must contain at least one origin"
                );
                Some(values)
            }
            None => server.cors_allowed_origins,
        };
        let cors_allowed_origins = origins.and_then(|origins: Vec<String>| {
            if origins.is_empty() {
                return None;
            }
            Some(
                origins
                    .into_iter()
                    .map(|origin| {
                        let origin = origin.trim();
                        assert!(
                            !origin.is_empty() && origin != "*",
                            "CORS_ALLOWED_ORIGINS must list explicit origins"
                        );
                        HeaderValue::from_str(origin).unwrap_or_else(|_| {
                            panic!("CORS_ALLOWED_ORIGINS contains an invalid origin")
                        })
                    })
                    .collect(),
            )
        });
        let max_size = match env("ATTACHMENT_MAX_FILE_SIZE_BYTES") {
            Some(value) => value.parse::<i64>().ok(),
            None => Some(
                media
                    .max_attachment_file_size_bytes
                    .unwrap_or(DEFAULT_MAX_ATTACHMENT_FILE_SIZE_BYTES),
            ),
        }
        .filter(|n| *n > 0)
        .expect("ATTACHMENT_MAX_FILE_SIZE_BYTES must be a positive integer");
        let avatars = match (
            env("DISCUZ_AVATAR_PUBLIC_URL").or(avatars.public_url),
            env("DISCUZ_AVATAR_PATH").or(avatars.path),
        ) {
            (Some(public_url), Some(path)) => {
                Some(Arc::new(DiscuzAvatarConfig { public_url, path }))
            }
            (None, None) => None,
            _ => {
                tracing::warn!("Only one avatar setting is set; avatar resolution is disabled");
                None
            }
        };
        let enabled = match env("MESSAGE_SEARCH_ENABLED") {
            Some(value) => match value.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "on" => true,
                "false" | "0" | "no" | "off" | "" => false,
                _ => panic!("MESSAGE_SEARCH_ENABLED must be a boolean"),
            },
            None => message_search.enabled.unwrap_or(false),
        };
        let url = nonempty(env("MEILI_URL").or(message_search.meili_url));
        let key = nonempty(env("MEILI_MASTER_KEY"));
        let search = match (url, key) {
            (Some(meili_url), Some(meili_master_key)) => {
                Some(crate::services::message_search::MessageSearchConfig {
                    meili_url,
                    meili_master_key,
                    index_uid: nonempty(env("MESSAGE_SEARCH_INDEX").or(message_search.index_uid))
                        .unwrap_or_else(|| {
                            crate::services::message_search::DEFAULT_INDEX_UID.into()
                        }),
                })
            }
            _ if enabled => {
                panic!("MESSAGE_SEARCH_ENABLED requires MEILI_URL and MEILI_MASTER_KEY")
            }
            _ => None,
        };
        let apns_key_id = nonempty(env("APNS_KEY_ID").or(push.apns.key_id));
        let apns_team_id = nonempty(env("APNS_TEAM_ID").or(push.apns.team_id));
        let apns_topic = nonempty(env("APNS_TOPIC").or(push.apns.topic));
        let apns_path = nonempty(env("APNS_PRIVATE_KEY_PATH"));
        let apns = match (apns_key_id, apns_team_id, apns_path, apns_topic) {
            (None, None, None, None) => None,
            (Some(key_id), Some(team_id), Some(private_key_path), Some(topic)) => Some(ApnsConfig { key_id, team_id, private_key_path, topic }),
            _ => panic!("APNS configuration requires APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY_PATH and APNS_TOPIC"),
        };
        let node_id = match env("NODE_ID") {
            Some(value) => value.parse::<u64>().ok(),
            None => Some(ids.node_id.unwrap_or(0)),
        }
        .filter(|id| *id <= 15)
        .expect("NODE_ID must be an integer from 0 to 15");
        Self {
            server: ServerConfig {
                app_addr: socket(
                    env("APP_ADDR").or(server.app_addr),
                    "APP_ADDR",
                    ([0, 0, 0, 0], 3000).into(),
                ),
                metrics_addr: socket(
                    env("METRICS_ADDR").or(server.metrics_addr),
                    "METRICS_ADDR",
                    ([0, 0, 0, 0], 3001).into(),
                ),
                cors_allowed_origins,
            },
            database_url: required(env("DATABASE_URL"), "DATABASE_URL"),
            media: Arc::new(MediaConfig {
                bucket: required(env("S3_BUCKET_NAME").or(media.bucket), "S3_BUCKET_NAME"),
                attachment_prefix: env("ATTACHMENTS_PREFIX")
                    .or(media.attachment_prefix)
                    .unwrap_or_else(|| "attachments".into()),
                base_url: env("S3_BASE_URL").or(media.base_url),
                endpoint_url: env("S3_ENDPOINT_URL").or(media.endpoint_url),
                upload_proxy_path: env("S3_UPLOAD_PROXY_PATH").or(media.upload_proxy_path),
                max_attachment_file_size_bytes: max_size,
            }),
            link_previews: Arc::new(
                LinkPreviewConfig::from_settings(link_previews, &env)
                    .unwrap_or_else(|error| panic!("link_previews: {error}")),
            ),
            avatars,
            auth: AuthConfig {
                debug_auth_enabled,
                jwt_signing_key,
                service_token_hash_key,
            },
            aws_region: env("AWS_REGION")
                .or_else(|| env("AWS_DEFAULT_REGION"))
                .or(media.region),
            node_id,
            message_search_enabled: enabled,
            message_search: search,
            push: {
                let public_key = env("VAPID_PUBLIC_KEY").or(push.vapid_public_key);
                let private_key = env("VAPID_PRIVATE_KEY");
                let subject = env("VAPID_SUBJECT").or(push.vapid_subject);
                // Offline search reindexing does not require push credentials.
                if public_key.is_none()
                    && private_key.is_none()
                    && subject.is_none()
                    && apns.is_none()
                {
                    None
                } else {
                    Some(Arc::new(PushConfig {
                        vapid_public_key: required(public_key, "VAPID_PUBLIC_KEY"),
                        vapid_private_key: required(private_key, "VAPID_PRIVATE_KEY"),
                        vapid_subject: required(subject, "VAPID_SUBJECT"),
                        apns,
                    }))
                }
            },
        }
    }
}

fn required(value: Option<String>, name: &str) -> String {
    value.unwrap_or_else(|| panic!("{name} must be set"))
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
}

fn socket(value: Option<String>, name: &str, default: SocketAddr) -> SocketAddr {
    value
        .map(|v| {
            v.parse()
                .unwrap_or_else(|_| panic!("{name} must be a valid socket address"))
        })
        .unwrap_or(default)
}

fn decode_key(name: &str, raw: &str) -> Vec<u8> {
    let key = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .unwrap_or_else(|_| panic!("{name} must be valid base64"));
    assert!(key.len() >= 32, "{name} must decode to at least 32 bytes");
    key
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env<'a>(values: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        let values: HashMap<_, _> = values.iter().copied().collect();
        move |name| values.get(name).map(|value| (*value).to_string())
    }
    fn base() -> Vec<(&'static str, &'static str)> {
        vec![
            ("DATABASE_URL", "postgres://db"),
            (
                "JWT_SIGNING_KEY_BASE64",
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            ),
            ("VAPID_PRIVATE_KEY", "private"),
            ("VAPID_PUBLIC_KEY", "public"),
            ("VAPID_SUBJECT", "mailto:test@example.com"),
            ("S3_BUCKET_NAME", "env-bucket"),
        ]
    }
    fn parse(raw: &str) -> ConfigFile {
        toml::from_str(raw).unwrap()
    }

    #[test]
    fn file_and_environment_precedence_and_clear() {
        let file = parse("[server]\napp_addr='127.0.0.1:8080'\ncors_allowed_origins=['https://example.com']\n[media]\nbucket='file-bucket'\nregion='file-region'\n[ids]\nnode_id=7\n[logging]\nformat='json'\nfilter='info'\n");
        assert_eq!(
            file.logging_with(env(&[])),
            (LogFormat::Json, "info".into())
        );
        assert_eq!(
            file.logging_with(env(&[
                ("BACKEND_LOG_FORMAT", "pretty"),
                ("RUST_LOG", "warn")
            ])),
            (LogFormat::Pretty, "warn".into())
        );
        let mut values = base();
        values.extend([
            ("CORS_ALLOWED_ORIGINS", ""),
            ("AWS_DEFAULT_REGION", "env-region"),
            ("NODE_ID", "9"),
        ]);
        let config = AppConfig::resolve(file, env(&values), false);
        assert_eq!(config.server.app_addr.port(), 8080);
        assert!(config.server.cors_allowed_origins.is_none());
        assert_eq!(config.media.bucket, "env-bucket");
        assert_eq!(config.aws_region.as_deref(), Some("env-region"));
        assert_eq!(config.node_id, 9);
    }

    #[test]
    fn search_available_for_reindex_even_when_disabled() {
        let file =
            parse("[message_search]\nmeili_url=' http://search:7700 ' \nindex_uid='custom'\n");
        let mut values = base();
        values.push(("MEILI_MASTER_KEY", " key "));
        let config = AppConfig::resolve(file, env(&values), false);
        assert!(!config.message_search_enabled);
        let search = config.message_search.unwrap();
        assert_eq!(search.meili_url, "http://search:7700");
        assert_eq!(search.meili_master_key, "key");
        assert_eq!(search.index_uid, "custom");
    }

    #[test]
    fn strict_file_rejects_secret_fields_and_unknown_keys() {
        for raw in [
            "database_url='secret'",
            "[push]\nvapid_private_key='secret'",
            "[message_search]\nmeili_master_key='secret'",
            "[push.apns]\nprivate_key_path='secret'",
            "[auth]\njwt_signing_key_base64='secret'",
            "[media]\nunknown='secret'",
        ] {
            assert!(toml::from_str::<ConfigFile>(raw).is_err());
        }
    }

    #[test]
    fn missing_file_falls_back_to_environment() {
        let file = ConfigFile::load_with(env(&[(
            "CHAHUA_CONFIG_PATH",
            "/nonexistent/chahua-config-secret",
        )]))
        .unwrap();
        let mut values = base();
        values.push(("APP_ADDR", "127.0.0.1:8089"));
        let config = AppConfig::resolve(file, env(&values), false);
        assert_eq!(config.server.app_addr, "127.0.0.1:8089".parse().unwrap());
        assert_eq!(config.media.bucket, "env-bucket");
    }

    #[test]
    fn file_errors_are_sanitized() {
        let directory = std::env::temp_dir();
        assert!(ConfigFile::load_with(env(&[
            ("CHAHUA_CONFIG_PATH", directory.to_str().unwrap(),)
        ]))
        .is_err());
        let path = std::env::temp_dir().join(format!("chahua-config-test-{}", std::process::id()));
        std::fs::write(&path, "database_url='very-secret-value'").unwrap();
        let path_string = path.to_str().unwrap();
        let error = ConfigFile::load_with(env(&[("CHAHUA_CONFIG_PATH", path_string)]))
            .err()
            .unwrap();
        std::fs::remove_file(path).unwrap();
        assert!(!error.contains("very-secret-value"));
    }

    #[test]
    fn file_only_settings_and_apns_are_resolved() {
        let file = parse("[server]\ncors_allowed_origins=['https://example.com']\n[media]\nbucket='file-bucket'\nregion='file-region'\n[push]\nvapid_public_key='file-public'\nvapid_subject='file-subject'\n[push.apns]\nkey_id='key'\nteam_id='team'\ntopic='topic'\n");
        let mut values = base();
        values.retain(|(key, _)| {
            !matches!(
                *key,
                "S3_BUCKET_NAME" | "VAPID_PUBLIC_KEY" | "VAPID_SUBJECT"
            )
        });
        values.push(("APNS_PRIVATE_KEY_PATH", "/private/key"));
        let config = AppConfig::resolve(file, env(&values), false);
        assert_eq!(config.media.bucket, "file-bucket");
        assert_eq!(config.aws_region.as_deref(), Some("file-region"));
        assert_eq!(
            config.server.cors_allowed_origins.unwrap()[0],
            "https://example.com"
        );
        assert_eq!(
            config.push.as_ref().unwrap().vapid_public_key,
            "file-public"
        );
        assert_eq!(
            config
                .push
                .as_ref()
                .unwrap()
                .apns
                .as_ref()
                .unwrap()
                .private_key_path,
            "/private/key"
        );
    }

    #[test]
    fn invalid_configuration_is_rejected() {
        for overrides in [
            vec![("NODE_ID", "16")],
            vec![("ENABLE_DEBUG_AUTH", "TRUE")],
            vec![("MESSAGE_SEARCH_ENABLED", "yes")],
            vec![("APNS_KEY_ID", "partial")],
            vec![("ATTACHMENT_MAX_FILE_SIZE_BYTES", "0")],
            vec![("CORS_ALLOWED_ORIGINS", ",,")],
        ] {
            let mut values = base();
            values.extend(overrides);
            assert!(std::panic::catch_unwind(|| AppConfig::resolve(
                ConfigFile::default(),
                env(&values),
                false
            ))
            .is_err());
        }
    }

    #[test]
    fn search_boolean_and_debug_build_overrides() {
        let mut values = base();
        values.extend([
            ("MESSAGE_SEARCH_ENABLED", "ON"),
            ("MEILI_URL", "http://search"),
            ("MEILI_MASTER_KEY", "key"),
        ]);
        let config = AppConfig::resolve(ConfigFile::default(), env(&values), true);
        assert!(config.message_search_enabled);
        assert!(config.auth.debug_auth_enabled);
        assert_eq!(config.message_search.unwrap().index_uid, "messages_v1");
    }
    #[test]
    fn invalid_secret_does_not_appear_in_panic() {
        let mut values = base();
        values.retain(|(k, _)| *k != "JWT_SIGNING_KEY_BASE64");
        values.push(("JWT_SIGNING_KEY_BASE64", "very-secret-invalid"));
        let error = std::panic::catch_unwind(|| {
            AppConfig::resolve(ConfigFile::default(), env(&values), false)
        })
        .err()
        .unwrap();
        let message = error
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| error.downcast_ref::<&str>().copied())
            .unwrap();
        assert!(!message.contains("very-secret-invalid"));
    }
    #[test]
    fn no_file_preserves_environment_only_defaults() {
        let file = ConfigFile::load_with(|_| None).unwrap();
        assert_eq!(
            file.logging_with(|_| None),
            (LogFormat::Pretty, "error".into())
        );
        let config = AppConfig::resolve(file, env(&base()), false);
        assert_eq!(config.server.app_addr.port(), 3000);
        assert_eq!(config.server.metrics_addr.port(), 3001);
        assert_eq!(config.media.attachment_prefix, "attachments");
        assert_eq!(config.media.max_attachment_file_size_bytes, 52_428_800);
        assert_eq!(config.node_id, 0);
        assert!(!config.auth.debug_auth_enabled);
        assert!(!config.message_search_enabled);
        assert!(config.avatars.is_none());
    }

    #[test]
    fn example_configuration_and_rust_site_boundary() {
        let file = parse(include_str!("../config.example.toml"));
        let config = AppConfig::resolve(file, env(&base()), false);
        assert_eq!(config.media.bucket, "env-bucket");
        assert!(toml::from_str::<ConfigFile>(
            "[[link_previews.sites]]\nhost='example.com'\nhandler='zhihu'"
        )
        .is_err());
    }

    #[test]
    fn reindex_configuration_does_not_require_push_credentials() {
        let mut values = base();
        values.retain(|(key, _)| !key.starts_with("VAPID_"));
        values.extend([("MEILI_URL", "http://search"), ("MEILI_MASTER_KEY", "key")]);
        let config = AppConfig::resolve(ConfigFile::default(), env(&values), false);
        assert!(config.push.is_none());
        assert!(config.message_search.is_some());
        assert!(!config.message_search_enabled);
    }

    #[test]
    fn file_settings_cover_media_avatars_and_auth_with_env_overrides() {
        let source = r#"
[server]
metrics_addr = "127.0.0.1:9001"
[media]
attachment_prefix = "files"
base_url = "https://media.example.com"
endpoint_url = "http://storage:9000"
upload_proxy_path = "/uploads"
max_attachment_file_size_bytes = 1024
[avatars]
public_url = "https://avatars.example.com"
path = "/avatars"
[auth]
debug_auth_enabled = true
"#;
        let config = AppConfig::resolve(parse(source), env(&base()), false);
        assert_eq!(config.server.metrics_addr.port(), 9001);
        assert_eq!(config.media.attachment_prefix, "files");
        assert_eq!(
            config.media.base_url.as_deref(),
            Some("https://media.example.com")
        );
        assert_eq!(
            config.media.endpoint_url.as_deref(),
            Some("http://storage:9000")
        );
        assert_eq!(config.media.upload_proxy_path.as_deref(), Some("/uploads"));
        assert_eq!(config.media.max_attachment_file_size_bytes, 1024);
        assert_eq!(config.avatars.as_ref().unwrap().path, "/avatars");
        assert!(config.auth.debug_auth_enabled);
        let mut values = base();
        values.extend([
            ("METRICS_ADDR", "127.0.0.1:9002"),
            ("ATTACHMENTS_PREFIX", "override"),
            ("S3_BASE_URL", "https://override.example.com"),
            ("S3_ENDPOINT_URL", "http://override:9000"),
            ("S3_UPLOAD_PROXY_PATH", "/proxy"),
            ("ATTACHMENT_MAX_FILE_SIZE_BYTES", "2048"),
            (
                "DISCUZ_AVATAR_PUBLIC_URL",
                "https://override.example.com/avatars",
            ),
            ("DISCUZ_AVATAR_PATH", "/override"),
            ("ENABLE_DEBUG_AUTH", "false"),
        ]);
        let config = AppConfig::resolve(parse(source), env(&values), false);
        assert_eq!(config.server.metrics_addr.port(), 9002);
        assert_eq!(config.media.attachment_prefix, "override");
        assert_eq!(
            config.media.base_url.as_deref(),
            Some("https://override.example.com")
        );
        assert_eq!(
            config.media.endpoint_url.as_deref(),
            Some("http://override:9000")
        );
        assert_eq!(config.media.upload_proxy_path.as_deref(), Some("/proxy"));
        assert_eq!(config.media.max_attachment_file_size_bytes, 2048);
        assert_eq!(config.avatars.as_ref().unwrap().path, "/override");
        assert_eq!(
            config.avatars.as_ref().unwrap().public_url,
            "https://override.example.com/avatars"
        );
        assert!(!config.auth.debug_auth_enabled);
        assert!(
            AppConfig::resolve(parse(source), env(&values), true)
                .auth
                .debug_auth_enabled
        );
    }
    #[test]
    fn preview_headers_resolve_environment_secrets_at_startup() {
        let source =
            "[[link_previews.sites]]\nhost='example.com'\nheaders={Cookie={env='PREVIEW_COOKIE'}}";
        assert!(std::panic::catch_unwind(|| AppConfig::resolve(
            parse(source),
            env(&base()),
            false
        ))
        .is_err());
        let mut values = base();
        values.push(("PREVIEW_COOKIE", "session=secret"));
        let config = AppConfig::resolve(parse(source), env(&values), false);
        let headers = config.link_previews.headers_for("example.com").unwrap();
        assert_eq!(headers["cookie"], "session=secret");
        assert!(headers["cookie"].is_sensitive());
    }
}
