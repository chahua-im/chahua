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
    let file = parse("[message_search]\nmeili_url=' http://search:7700 ' \nindex_uid='custom'\n");
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
fn group_chat_write_restrictions_use_toml_and_default_to_empty() {
    let values = base();
    let config = AppConfig::resolve(ConfigFile::default(), env(&values), false);
    assert!(config.restricted_user_group_ids.is_empty());

    let file = parse("[group_chat.write]\nrestricted_user_group_ids = [17, 42]\n");
    let config = AppConfig::resolve(file, env(&values), false);
    assert_eq!(config.restricted_user_group_ids, vec![17, 42]);
}

#[test]
fn message_sync_retention_uses_environment_then_file_then_default() {
    let values = base();
    let config = AppConfig::resolve(ConfigFile::default(), env(&values), false);
    assert_eq!(config.message_sync_retention_hours, 72);
    let file = || parse("[message_sync]\nretention_hours = 48\n");
    let config = AppConfig::resolve(file(), env(&values), false);
    assert_eq!(config.message_sync_retention_hours, 48);
    let mut values = values;
    values.push(("MESSAGE_SYNC_RETENTION_HOURS", "2160"));
    let config = AppConfig::resolve(file(), env(&values), false);
    assert_eq!(config.message_sync_retention_hours, 2160);
}

#[test]
fn message_sync_retention_rejects_values_outside_the_range() {
    const MESSAGE: &str = "MESSAGE_SYNC_RETENTION_HOURS must be an integer from 1 to 2160";
    for value in ["0", "2161", "not an integer"] {
        let mut values = base();
        values.push(("MESSAGE_SYNC_RETENTION_HOURS", value));
        let error = std::panic::catch_unwind(|| {
            AppConfig::resolve(ConfigFile::default(), env(&values), false)
        })
        .err()
        .unwrap();
        assert_eq!(error.downcast_ref::<&str>(), Some(&MESSAGE));
    }
    for value in ["0", "2161", "1.5", "'72'"] {
        let file = parse(&format!("[message_sync]\nretention_hours = {value}\n"));
        let error = std::panic::catch_unwind(|| AppConfig::resolve(file, env(&base()), false))
            .err()
            .unwrap();
        assert_eq!(error.downcast_ref::<&str>(), Some(&MESSAGE));
    }
}

#[test]
fn list_sync_retention_uses_environment_then_file_then_default() {
    let values = base();
    assert_eq!(
        AppConfig::resolve(ConfigFile::default(), env(&values), false).list_sync_retention_days,
        30
    );
    let file = || parse("[list_sync]\nretention_days = 15\n");
    assert_eq!(
        AppConfig::resolve(file(), env(&values), false).list_sync_retention_days,
        15
    );
    let mut values = values;
    values.push(("LIST_SYNC_RETENTION_DAYS", "365"));
    assert_eq!(
        AppConfig::resolve(file(), env(&values), false).list_sync_retention_days,
        365
    );
    // Only the selected source is validated.
    let file = parse("[list_sync]\nretention_days = 'invalid'\n");
    assert_eq!(
        AppConfig::resolve(file, env(&values), false).list_sync_retention_days,
        365
    );
}

#[test]
fn list_sync_retention_rejects_invalid_environment_and_file_values() {
    const MESSAGE: &str = "LIST_SYNC_RETENTION_DAYS must be an integer from 1 to 365";
    for value in ["", "0", "-1", "366", "1.5", "invalid"] {
        let mut values = base();
        values.push(("LIST_SYNC_RETENTION_DAYS", value));
        let error = std::panic::catch_unwind(|| {
            AppConfig::resolve(ConfigFile::default(), env(&values), false)
        })
        .err()
        .unwrap();
        assert_eq!(error.downcast_ref::<&str>(), Some(&MESSAGE));
    }
    for value in ["0", "-1", "366", "1.5", "'30'", "true", "[]", "{}"] {
        let file = parse(&format!("[list_sync]\nretention_days = {value}\n"));
        let error = std::panic::catch_unwind(|| AppConfig::resolve(file, env(&base()), false))
            .err()
            .unwrap();
        assert_eq!(error.downcast_ref::<&str>(), Some(&MESSAGE));
    }
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
    assert!(
        ConfigFile::load_with(env(&[("CHAHUA_CONFIG_PATH", directory.to_str().unwrap(),)]))
            .is_err()
    );
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
    let error =
        std::panic::catch_unwind(|| AppConfig::resolve(ConfigFile::default(), env(&values), false))
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
    assert_eq!(config.discuz_schema, "discuz");
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
    assert!(
        std::panic::catch_unwind(|| AppConfig::resolve(parse(source), env(&base()), false))
            .is_err()
    );
    let mut values = base();
    values.push(("PREVIEW_COOKIE", "session=secret"));
    let config = AppConfig::resolve(parse(source), env(&values), false);
    let headers = config.link_previews.headers_for("example.com").unwrap();
    assert_eq!(headers["cookie"], "session=secret");
    assert!(headers["cookie"].is_sensitive());
}

#[test]
fn discuz_schema_uses_toml_and_validates_identifier() {
    let config = AppConfig::resolve(
        parse("[discuz]\nschema = \"forum_users\"\n"),
        env(&base()),
        false,
    );
    assert_eq!(config.discuz_schema, "forum_users");

    let max_len = "a".repeat(63);
    let config = AppConfig::resolve(
        parse(&format!("[discuz]\nschema = \"{max_len}\"\n")),
        env(&base()),
        false,
    );
    assert_eq!(config.discuz_schema, max_len);

    let too_long = "a".repeat(64);
    for invalid in [
        "",
        "   ",
        "123abc",
        "discuz-v2",
        "discuz.other",
        "discuz; DROP TABLE users",
        "discuz\\\"",
        too_long.as_str(),
    ] {
        let file = parse(&format!("[discuz]\nschema = \"{invalid}\"\n"));
        let error = std::panic::catch_unwind(|| AppConfig::resolve(file, env(&base()), false))
            .err()
            .unwrap();
        assert_eq!(
            error.downcast_ref::<String>().map(String::as_str),
            Some(INVALID_DISCUZ_SCHEMA_ERROR)
        );
    }

    assert!(toml::from_str::<ConfigFile>("[discuz]\nunknown = \"x\"\n").is_err());
}
