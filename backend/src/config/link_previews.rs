use std::collections::{HashMap, HashSet};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::Deserialize;
use url::Host;

// Protocol allowlist shared by startup validation and the runtime challenge handler.
pub(crate) const ZHIHU_CHALLENGE_HOSTS: [&str; 2] = ["www.zhihu.com", "zhuanlan.zhihu.com"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LinkPreviewHandler {
    Generic,
    Xiaohongshu,
    Weixin,
    Zhihu,
}

#[derive(Debug)]
struct Site {
    headers: HeaderMap,
    handler: Option<LinkPreviewHandler>,
}

/// Immutable site rules indexed by canonical URL hostname.
#[derive(Debug, Default)]
pub struct LinkPreviewConfig {
    sites: HashMap<String, Site>,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LinkPreviewSettings {
    sites: Vec<SiteSettings>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SiteSettings {
    host: Option<String>,
    hosts: Option<Vec<String>>,
    handler: Option<LinkPreviewHandler>,
    #[serde(default)]
    headers: HashMap<String, HeaderSetting>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum HeaderSetting {
    Literal(String),
    Environment(EnvironmentReference),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnvironmentReference {
    env: String,
}

impl LinkPreviewConfig {
    /// Resolve deployment rules and secret headers at startup.
    pub fn from_settings(
        settings: LinkPreviewSettings,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, String> {
        let mut sites = HashMap::new();
        let mut seen = HashSet::new();
        for (index, site) in settings.sites.into_iter().enumerate() {
            let site_number = index + 1;
            let hosts = match (site.host, site.hosts) {
                (Some(host), None) => vec![host],
                (None, Some(hosts)) if !hosts.is_empty() => hosts,
                _ => {
                    return Err(format!(
                        "site #{site_number} requires host or non-empty hosts"
                    ))
                }
            };
            let mut canonical_hosts = Vec::with_capacity(hosts.len());
            for (index, host) in hosts.into_iter().enumerate() {
                let host = canonical_host(&host).ok_or_else(|| {
                    format!("site #{site_number}, host #{}: invalid hostname", index + 1)
                })?;
                if !seen.insert(host.clone()) {
                    return Err(format!(
                        "site #{site_number}: duplicate link preview host {host:?}"
                    ));
                }
                if site.handler == Some(LinkPreviewHandler::Zhihu)
                    && !ZHIHU_CHALLENGE_HOSTS.contains(&host.as_str())
                {
                    return Err(format!(
                        "site #{site_number}, host {host:?}: handler 'zhihu' supports only {}",
                        ZHIHU_CHALLENGE_HOSTS.join(", ")
                    ));
                }
                canonical_hosts.push(host);
            }
            let headers = resolve_headers(site.headers, &canonical_hosts, &env)?;
            let handler = site
                .handler
                .filter(|handler| *handler != LinkPreviewHandler::Generic);
            for host in canonical_hosts {
                sites.insert(
                    host,
                    Site {
                        headers: headers.clone(),
                        handler,
                    },
                );
            }
        }
        Ok(Self { sites })
    }

    /// Look up the canonical hostname of a validated request URL, exactly.
    pub(crate) fn headers_for(&self, host: &str) -> Option<&HeaderMap> {
        self.sites.get(host).map(|site| &site.headers)
    }

    pub(crate) fn handler_for(&self, host: &str) -> Option<LinkPreviewHandler> {
        self.sites.get(host).and_then(|site| site.handler)
    }
}

fn resolve_headers(
    settings: HashMap<String, HeaderSetting>,
    hosts: &[String],
    env: &impl Fn(&str) -> Option<String>,
) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::with_capacity(settings.len());
    for (raw_name, value) in settings {
        // Quote untrusted names to keep diagnostics on one line. Never log header values.
        let error = |reason| format!("site hosts {hosts:?}, header {raw_name:?}: {reason}");
        let name = HeaderName::from_bytes(raw_name.as_bytes())
            .map_err(|_| error("invalid header name"))?;
        if matches!(
            name.as_str(),
            "host"
                | "accept-encoding"
                | "content-length"
                | "transfer-encoding"
                | "connection"
                | "keep-alive"
                | "proxy-connection"
                | "proxy-authorization"
                | "proxy-authenticate"
                | "te"
                | "trailer"
                | "upgrade"
        ) {
            return Err(error("reserved header"));
        }
        let value = match value {
            HeaderSetting::Literal(value) => {
                if matches!(name.as_str(), "cookie" | "authorization") {
                    return Err(error("secret headers require environment references"));
                }
                value
            }
            HeaderSetting::Environment(reference) => {
                if !valid_env_name(&reference.env) {
                    return Err(error("invalid environment reference"));
                }
                env(&reference.env).ok_or_else(|| error("missing environment reference"))?
            }
        };
        let mut value = HeaderValue::from_str(&value).map_err(|_| error("invalid header value"))?;
        value.set_sensitive(true);
        if headers.insert(name, value).is_some() {
            return Err(error("duplicate header name"));
        }
    }
    Ok(headers)
}

fn valid_env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn canonical_host(host: &str) -> Option<String> {
    // Host::parse performs the same IDNA and case normalization as URL parsing,
    // but accepts only the host itself, not URL authority or path syntax.
    if host.is_empty()
        || host.chars().any(|c| {
            c.is_whitespace() || matches!(c, '/' | '\\' | ':' | '@' | '?' | '#' | '[' | ']')
        })
    {
        return None;
    }
    match Host::parse(host) {
        Ok(Host::Domain(domain)) if !domain.is_empty() && !domain.contains('*') => Some(domain),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
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
        let overlap =
            "[[sites]]\nhosts=['first.example','example.com']\n[[sites]]\nhost='EXAMPLE.com'";
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
}
