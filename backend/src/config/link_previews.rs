use std::collections::HashMap;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::Deserialize;
use url::Host;

/// Immutable request headers indexed by canonical URL hostname.
#[derive(Debug, Default)]
pub struct LinkPreviewConfig {
    sites: HashMap<String, HeaderMap>,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LinkPreviewSettings {
    sites: Vec<SiteSettings>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SiteSettings {
    host: String,
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
    /// Resolve and validate site headers without exposing values in errors.
    pub fn from_settings(
        settings: LinkPreviewSettings,
        env: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, String> {
        let mut sites = HashMap::with_capacity(settings.sites.len());
        for site in settings.sites {
            let host = canonical_host(&site.host)?;
            let mut headers = HeaderMap::with_capacity(site.headers.len());
            for (name, value) in site.headers {
                let name = HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| "invalid link preview header name".to_owned())?;
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
                    return Err("reserved link preview header".to_owned());
                }
                let value = match value {
                    HeaderSetting::Literal(value) => {
                        if matches!(name.as_str(), "cookie" | "authorization") {
                            return Err(
                                "secret link preview headers require environment references"
                                    .to_owned(),
                            );
                        }
                        value
                    }
                    HeaderSetting::Environment(reference) => {
                        if !valid_env_name(&reference.env) {
                            return Err("invalid link preview environment reference".to_owned());
                        }
                        env(&reference.env).ok_or_else(|| {
                            "missing link preview environment reference".to_owned()
                        })?
                    }
                };
                let mut value = HeaderValue::from_str(&value)
                    .map_err(|_| "invalid link preview header value".to_owned())?;
                value.set_sensitive(true);
                if headers.insert(name, value).is_some() {
                    return Err("duplicate link preview header name".to_owned());
                }
            }
            if sites.insert(host, headers).is_some() {
                return Err("duplicate link preview host".to_owned());
            }
        }
        Ok(Self { sites })
    }

    pub(crate) fn sites(&self) -> impl Iterator<Item = (&str, &HeaderMap)> {
        self.sites
            .iter()
            .map(|(host, headers)| (host.as_str(), headers))
    }

    /// Look up the canonical hostname of a validated request URL, exactly.
    #[cfg(test)]
    pub fn headers_for(&self, host: &str) -> Option<&HeaderMap> {
        self.sites.get(host)
    }
}

fn valid_env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn canonical_host(host: &str) -> Result<String, String> {
    // Host::parse performs the same IDNA and case normalization as URL parsing,
    // but accepts only the host itself, not URL authority or path syntax.
    if host.is_empty()
        || host.chars().any(|c| {
            c.is_whitespace() || matches!(c, '/' | '\\' | ':' | '@' | '?' | '#' | '[' | ']')
        })
    {
        return Err("invalid link preview host".to_owned());
    }
    match Host::parse(host) {
        Ok(Host::Domain(domain)) if !domain.is_empty() && !domain.contains('*') => Ok(domain),
        _ => Err("invalid link preview host".to_owned()),
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
        assert!(resolve("[[sites]]\nhost = 'example.com'", |_| None)
            .unwrap()
            .headers_for("example.com")
            .unwrap()
            .is_empty());
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
            assert!(resolve(&source, |_| None).is_err(), "accepted {name}");
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
            assert!(!resolve(&source, |_| None)
                .unwrap_err()
                .contains("secret-value"));
        }
        for name in ["", "1BAD", "BAD-NAME", "BAD=NAME"] {
            let source = format!(
                "[[sites]]\nhost='example.com'\n[sites.headers]\nCookie = {{ env = '{name}' }}"
            );
            assert!(resolve(&source, |_| Some("secret-value".into())).is_err());
        }
        let source = "[[sites]]\nhost='example.com'\n[sites.headers]\nCookie = { env = 'MISSING' }";
        assert!(resolve(source, |_| None).is_err());
        let source = "[[sites]]\nhost='example.com'\n[sites.headers]\nX-Custom = { env = 'VALUE' }";
        assert!(!resolve(source, |_| Some("secret-value\n".into()))
            .unwrap_err()
            .contains("secret-value"));
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
