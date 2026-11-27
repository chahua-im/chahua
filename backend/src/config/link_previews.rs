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
mod tests;
