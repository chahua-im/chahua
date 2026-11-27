use super::*;

fn resolve(
    source: &str,
    env: impl Fn(&str) -> Option<String>,
) -> Result<LinkPreviewConfig, String> {
    let settings = toml::from_str(source).map_err(|_| "invalid settings".to_owned())?;
    LinkPreviewConfig::from_settings(settings, env)
}

#[test]
fn loads_canonical_hosts_and_exact_headers() {
    let config = resolve(
        r#"
            [[sites]]
            host = "EXAMPLE.com"
            headers = {
                User-Agent = "custom-agent",
                Cookie = { env = "PREVIEW_COOKIE" },
                Authorization = { env = "PREVIEW_AUTH" },
            }
            [[sites]]
            host = "bücher.example"
            headers = { Accept-Language = "en-US" }
        "#,
        |name| match name {
            "PREVIEW_COOKIE" => Some("session=secret".into()),
            "PREVIEW_AUTH" => Some("Bearer secret".into()),
            _ => None,
        },
    )
    .unwrap();
    let headers = config.headers_for("example.com").unwrap();
    assert_eq!(headers["user-agent"], "custom-agent");
    assert_eq!(headers["cookie"], "session=secret");
    assert_eq!(headers["authorization"], "Bearer secret");
    assert!(headers.values().all(HeaderValue::is_sensitive));
    assert_eq!(
        config.headers_for("xn--bcher-kva.example").unwrap()["accept-language"],
        "en-US"
    );
    assert!(config.headers_for("sub.example.com").is_none());
    assert!(config.headers_for("EXAMPLE.com").is_none());
    assert!(!format!("{config:?}").contains("secret"));
    assert!(!format!("{config:?}").contains("custom-agent"));
}

#[test]
fn empty_configuration_and_empty_site_are_valid() {
    assert!(resolve("", |_| None)
        .unwrap()
        .headers_for("example.com")
        .is_none());
    assert!(LinkPreviewConfig::default()
        .headers_for("example.com")
        .is_none());
    for source in [
        "[[sites]]\nhost = 'example.com'",
        "[[sites]]\nhost = 'example.com'\nhandler = 'generic'",
    ] {
        let config = resolve(source, |_| None).unwrap();
        assert_eq!(config.handler_for("example.com"), None);
        assert!(config.headers_for("example.com").unwrap().is_empty());
    }
}

#[test]
fn grouped_hosts_share_headers_without_matching_subdomains() {
    let config = resolve(
        r#"
[[sites]]
hosts = ["NOTES.example", "other.example"]
headers = { User-Agent = "mobile-agent", Cookie = { env = "COOKIE" } }
"#,
        |_| Some("session=secret".into()),
    )
    .unwrap();
    for host in ["notes.example", "other.example"] {
        let headers = config.headers_for(host).unwrap();
        assert_eq!(headers["user-agent"], "mobile-agent");
        assert_eq!(headers["cookie"], "session=secret");
        assert!(headers["cookie"].is_sensitive());
    }
    assert!(config.headers_for("sub.notes.example").is_none());
    assert!(config.headers_for("notes.example.evil.test").is_none());
    assert!(!format!("{config:?}").contains("session=secret"));
}

#[test]
fn rejects_ambiguous_empty_and_overlapping_host_groups() {
    for source in [
        "[[sites]]\nhosts=[]",
        "[[sites]]\nhost='example.com'\nhosts=[]",
        "[[sites]]\nhost='example.com'\nhosts=['other.example']",
        "[[sites]]\nhosts=['EXAMPLE.com','example.com']",
        "[[sites]]\nhosts=['example.com','*.example.com']",
        "[[sites]]\nhost='example.com'\nhandler='unknown'",
    ] {
        assert!(resolve(source, |_| None).is_err(), "accepted {source}");
    }
    let overlap = "[[sites]]\nhosts=['first.example','example.com']\n[[sites]]\nhost='EXAMPLE.com'";
    assert_eq!(
        resolve(overlap, |_| None).unwrap_err(),
        "site #2: duplicate link preview host \"example.com\""
    );
}

#[test]
fn rejects_invalid_hosts_and_duplicate_canonical_hosts() {
    for host in [
        "",
        "https://example.com",
        "example.com/path",
        "example.com:443",
        "user@example.com",
        "*.example.com",
        "127.0.0.1",
        "[::1]",
        "example.com?x",
        "example.com#x",
    ] {
        let source = format!("[[sites]]\nhost = \"{host}\"");
        assert!(resolve(&source, |_| None).is_err(), "accepted {host}");
    }
    assert!(resolve(
        "[[sites]]\nhost='example.com'\n[[sites]]\nhost='example.com'",
        |_| None
    )
    .is_err());
    assert!(resolve(
        "[[sites]]\nhost='EXAMPLE.com'\n[[sites]]\nhost='example.com'",
        |_| None
    )
    .is_err());
    assert!(resolve(
        "[[sites]]\nhost='bücher.example'\n[[sites]]\nhost='xn--bcher-kva.example'",
        |_| None
    )
    .is_err());
}

#[test]
fn rejects_invalid_and_reserved_headers() {
    for name in [
        "Host",
        "Accept-Encoding",
        "Content-Length",
        "Transfer-Encoding",
        "Connection",
        "Keep-Alive",
        "Proxy-Connection",
        "Proxy-Authorization",
        "Proxy-Authenticate",
        "TE",
        "Trailer",
        "Upgrade",
        "bad header",
    ] {
        let source =
            format!("[[sites]]\nhost='example.com'\n[sites.headers]\n\"{name}\" = \"value\"");
        let error = resolve(&source, |_| None).unwrap_err();
        assert!(error.contains("example.com"));
        assert!(error.contains(&format!("header {name:?}")));
    }
    assert!(resolve(
        "[[sites]]\nhost='example.com'\n[sites.headers]\nX-Test = \"bad\\nvalue\"",
        |_| None
    )
    .is_err());
    assert!(resolve(
        "[[sites]]\nhost='example.com'\n[sites.headers]\nX-Test = \"a\"\nx-test = \"b\"",
        |_| None
    )
    .is_err());
}

#[test]
fn rejects_literal_secrets_and_bad_environment_references_without_leaking_values() {
    for name in ["Cookie", "cOoKiE", "Authorization", "AUTHORIZATION"] {
        let source =
            format!("[[sites]]\nhost='example.com'\n[sites.headers]\n{name} = 'secret-value'");
        let error = resolve(&source, |_| None).unwrap_err();
        assert!(error.contains("example.com"));
        assert!(error.contains(&format!("header {name:?}")));
        assert!(!error.contains("secret-value"));
    }
    for name in ["", "1BAD", "BAD-NAME", "BAD=NAME"] {
        let source = format!(
            "[[sites]]\nhost='example.com'\n[sites.headers]\nCookie = {{ env = '{name}' }}"
        );
        assert!(resolve(&source, |_| Some("secret-value".into())).is_err());
    }
    let source = "[[sites]]\nhost='example.com'\n[sites.headers]\nCookie = { env = 'MISSING' }";
    assert!(resolve(source, |_| None).is_err());
    let source = "[[sites]]\nhosts=['example.com','other.example']\n[sites.headers]\nX-Custom = { env = 'VALUE' }";
    let error = resolve(source, |_| Some("secret-value\n".into())).unwrap_err();
    assert_eq!(
            error,
            "site hosts [\"example.com\", \"other.example\"], header \"X-Custom\": invalid header value"
        );
    let config = resolve(source, |_| Some("secret-value".into())).unwrap();
    assert!(config.headers_for("example.com").unwrap()["x-custom"].is_sensitive());
}

#[test]
fn rejects_unknown_fields() {
    for source in [
            "unknown = 'secret-value'",
            "[[sites]]\nhost='example.com'\nunknown = 'secret-value'",
            "[[sites]]\nhost='example.com'\n[sites.headers]\nCookie = { env = 'NAME', extra = 'secret-value' }",
            "[[sites]]\nheaders = {}",
            "[sites.'example.com']",
        ] {
            assert!(!resolve(source, |_| None)
                .unwrap_err()
                .contains("secret-value"));
        }
}
