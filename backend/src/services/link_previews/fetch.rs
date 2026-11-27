use std::{
    io::{self, Write},
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::{Arc, LazyLock},
    time::Duration,
};

use flate2::write::MultiGzDecoder;
use futures::{future::BoxFuture, stream::Stream, StreamExt};
use ipnet::IpNet;
use reqwest::{header, redirect::Policy, StatusCode};
use url::Url;

use crate::config::{LinkPreviewConfig, LinkPreviewHandler};

use super::{
    metadata::{extract_preview, extract_preview_with_image_fallback},
    sites::{weixin, xiaohongshu, zhihu},
    validate_url,
};

const DEFAULT_USER_AGENT: &str = "chahua-link-preview/1.0";
const HTML_LIMIT: usize = 1024 * 1024;
const IMAGE_LIMIT: usize = 4 * 1024 * 1024;
const OPERATION_TIMEOUT: Duration = Duration::from_secs(8);
const DNS_TIMEOUT: Duration = Duration::from_secs(2);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_REDIRECTS: usize = 3;

#[derive(Debug)]
pub enum PreviewFetchError {
    InvalidUrl,
    Dns,
    ForbiddenAddress,
    Timeout,
    Http,
    Redirect,
    ContentEncoding,
    ContentType,
    TooLarge,
    MissingTitle,
}

#[derive(Debug)]
pub struct FetchedLinkPreview {
    pub title: String,
    pub description: Option<String>,
    pub image_url: Option<Url>,
}

type BodyStream = Pin<Box<dyn Stream<Item = Result<bytes::Bytes, PreviewFetchError>> + Send>>;

struct Response {
    status: StatusCode,
    headers: header::HeaderMap,
    body: BodyStream,
}

// The boundary permits tests to replace DNS and transport independently of URL/IP policy.
trait Transport: Send + Sync {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
    ) -> BoxFuture<'a, Result<Vec<SocketAddr>, PreviewFetchError>>;
    fn get<'a>(
        &'a self,
        url: &'a Url,
        address: SocketAddr,
        headers: Option<&'a header::HeaderMap>,
    ) -> BoxFuture<'a, Result<Response, PreviewFetchError>>;
}

struct SystemTransport;

impl Transport for SystemTransport {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
    ) -> BoxFuture<'a, Result<Vec<SocketAddr>, PreviewFetchError>> {
        Box::pin(async move {
            tokio::net::lookup_host((host, 443))
                .await
                .map(|addresses| addresses.collect())
                .map_err(|_| PreviewFetchError::Dns)
        })
    }

    fn get<'a>(
        &'a self,
        url: &'a Url,
        address: SocketAddr,
        headers: Option<&'a header::HeaderMap>,
    ) -> BoxFuture<'a, Result<Response, PreviewFetchError>> {
        Box::pin(async move {
            let host = url.host_str().ok_or(PreviewFetchError::InvalidUrl)?;
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(Policy::none())
                .retry(reqwest::retry::never())
                .referer(false)
                .connect_timeout(CONNECT_TIMEOUT)
                .resolve_to_addrs(host, &[address])
                .user_agent(DEFAULT_USER_AGENT)
                .build()
                .map_err(|_| PreviewFetchError::Http)?;
            let mut request = client
                .get(url.clone())
                .header(header::ACCEPT_ENCODING, "gzip, identity");
            if let Some(headers) = headers {
                for (name, value) in headers {
                    request = request.header(name, value);
                }
            }
            let response = request.send().await.map_err(|_| PreviewFetchError::Http)?;
            let status = response.status();
            let headers = response.headers().clone();
            let body = response
                .bytes_stream()
                .map(|chunk| chunk.map_err(|_| PreviewFetchError::Http));
            Ok(Response {
                status,
                headers,
                body: Box::pin(body),
            })
        })
    }
}

pub struct SecurePreviewFetcher {
    transport: Box<dyn Transport>,
    config: Arc<LinkPreviewConfig>,
}

impl SecurePreviewFetcher {
    pub(super) fn new(config: Arc<LinkPreviewConfig>) -> Self {
        Self {
            transport: Box::new(SystemTransport),
            config,
        }
    }

    pub async fn fetch_page(&self, url: &Url) -> Result<FetchedLinkPreview, PreviewFetchError> {
        tokio::time::timeout(OPERATION_TIMEOUT, async {
            let (final_url, bytes) = self.fetch_bytes(url, HTML_LIMIT, true).await?;
            let handler = final_url
                .host_str()
                .and_then(|host| self.config.handler_for(host));
            match handler {
                Some(LinkPreviewHandler::Weixin) => extract_preview_with_image_fallback(
                    &final_url,
                    &bytes,
                    Some(weixin::secure_cover_url),
                ),
                Some(LinkPreviewHandler::Xiaohongshu) => {
                    xiaohongshu::extract_preview(&final_url, &bytes)
                }
                _ => extract_preview(&final_url, &bytes),
            }
        })
        .await
        .map_err(|_| PreviewFetchError::Timeout)?
    }

    pub async fn fetch_thumbnail(&self, url: &Url) -> Result<Vec<u8>, PreviewFetchError> {
        tokio::time::timeout(OPERATION_TIMEOUT, async {
            self.fetch_bytes(url, IMAGE_LIMIT, false)
                .await
                .map(|(_, bytes)| bytes)
        })
        .await
        .map_err(|_| PreviewFetchError::Timeout)?
    }

    async fn fetch_bytes(
        &self,
        url: &Url,
        limit: usize,
        html: bool,
    ) -> Result<(Url, Vec<u8>), PreviewFetchError> {
        let mut current = url.clone();
        current.set_fragment(None);
        let mut redirects = 0;
        let mut guest_cookie: Option<(url::Origin, String)> = None;
        let mut challenge_attempted = false;
        loop {
            let checked = validate_url(current.as_str()).ok_or(PreviewFetchError::InvalidUrl)?;
            let host = checked.host_str().ok_or(PreviewFetchError::InvalidUrl)?;
            let handler = self.config.handler_for(host);
            if html
                && handler == Some(LinkPreviewHandler::Xiaohongshu)
                && xiaohongshu::is_unavailable_page(&checked)
            {
                return Err(PreviewFetchError::Http);
            }
            if challenge_attempted
                && handler == Some(LinkPreviewHandler::Zhihu)
                && zhihu::is_verification_page(&checked)
            {
                return Err(PreviewFetchError::Http);
            }
            let addresses = tokio::time::timeout(DNS_TIMEOUT, self.transport.resolve(host))
                .await
                .map_err(|_| PreviewFetchError::Timeout)??;
            if addresses.is_empty() {
                return Err(PreviewFetchError::Dns);
            }
            if addresses.iter().any(|address| !is_public(address.ip())) {
                return Err(PreviewFetchError::ForbiddenAddress);
            }
            // Pin exactly one vetted address; the original URL retains its host for TLS/SNI.
            let address = SocketAddr::new(addresses[0].ip(), 443);
            let mut headers = self.config.headers_for(host).cloned();
            // Generated credentials never leave the issuing origin.
            if let Some((_, cookie)) = guest_cookie
                .as_ref()
                .filter(|(origin, _)| *origin == checked.origin())
            {
                let headers = headers.get_or_insert_with(header::HeaderMap::new);
                let existing = headers
                    .get(header::COOKIE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("");
                let mut cookies: Vec<&str> = existing
                    .split(';')
                    .map(str::trim)
                    .filter(|part| {
                        !part.is_empty()
                            && part
                                .split_once('=')
                                .is_none_or(|(name, _)| name.trim() != "__zse_ck")
                    })
                    .collect();
                cookies.push(cookie);
                let mut value = header::HeaderValue::from_str(&cookies.join("; "))
                    .map_err(|_| PreviewFetchError::Http)?;
                value.set_sensitive(true);
                headers.insert(header::COOKIE, value);
            }
            let response = self
                .transport
                .get(&checked, address, headers.as_ref())
                .await?;
            if response.status.is_redirection() {
                if redirects == MAX_REDIRECTS {
                    return Err(PreviewFetchError::Redirect);
                }
                let location = response
                    .headers
                    .get(header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .filter(|value| !value.trim().is_empty())
                    .ok_or(PreviewFetchError::Redirect)?;
                current =
                    resolve_reference(&checked, location).ok_or(PreviewFetchError::Redirect)?;
                current.set_fragment(None);
                // Never carry credentials through a different origin, even if it redirects back.
                if guest_cookie
                    .as_ref()
                    .is_some_and(|(origin, _)| *origin != current.origin())
                {
                    guest_cookie = None;
                }
                redirects += 1;
                continue;
            }
            let challenge = html
                && !challenge_attempted
                && handler == Some(LinkPreviewHandler::Zhihu)
                && response.status == StatusCode::FORBIDDEN;
            if !response.status.is_success() && !challenge {
                return Err(PreviewFetchError::Http);
            }
            if html {
                let content_type = response
                    .headers
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<mime::Mime>().ok())
                    .ok_or(PreviewFetchError::ContentType)?;
                if content_type.essence_str() != "text/html"
                    && content_type.essence_str() != "application/xhtml+xml"
                {
                    return Err(PreviewFetchError::ContentType);
                }
            }
            let head_only = html && handler == Some(LinkPreviewHandler::Weixin);
            if let Some(length) = response
                .headers
                .get(header::CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
            {
                if !head_only && length > limit as u64 {
                    return Err(PreviewFetchError::TooLarge);
                }
            }
            let bytes = read_body(response, limit, head_only).await?;
            if challenge {
                challenge_attempted = true;
                let challenge =
                    zhihu::Challenge::parse(&checked, &bytes).ok_or(PreviewFetchError::Http)?;
                // Reuse the same DNS/IP, redirect, encoding and byte-limit checks.
                // Boxing bounds the async recursion; script requests cannot solve challenges.
                let (_, script) =
                    Box::pin(self.fetch_bytes(&challenge.script, HTML_LIMIT, false)).await?;
                let user_agent = headers
                    .as_ref()
                    .and_then(|h| h.get(header::USER_AGENT))
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or(DEFAULT_USER_AGENT)
                    .to_owned();
                let cookie =
                    tokio::task::spawn_blocking(move || challenge.cookie(&script, &user_agent))
                        .await
                        .map_err(|_| PreviewFetchError::Http)?
                        .ok_or(PreviewFetchError::Http)?;
                guest_cookie = Some((checked.origin(), cookie));
                continue;
            }
            return Ok((checked, bytes));
        }
    }
}

// Keep limits on both wire bytes and decoded bytes; Content-Length describes only
// the former. Decode incrementally so a small gzip cannot allocate an enormous body.
async fn read_body(
    mut response: Response,
    limit: usize,
    head_only: bool,
) -> Result<Vec<u8>, PreviewFetchError> {
    let mut gzip = false;
    for value in response.headers.get_all(header::CONTENT_ENCODING) {
        for encoding in value
            .to_str()
            .map_err(|_| PreviewFetchError::ContentEncoding)?
            .split(',')
        {
            match encoding.trim() {
                name if name.eq_ignore_ascii_case("identity") => {}
                name if name.eq_ignore_ascii_case("gzip") && !gzip => gzip = true,
                _ => return Err(PreviewFetchError::ContentEncoding),
            }
        }
    }
    let mut decoder = gzip.then(|| {
        MultiGzDecoder::new(LimitedBody {
            bytes: Vec::new(),
            limit,
            exceeded: false,
            head_only,
            complete: false,
        })
    });
    let mut bytes = Vec::new();
    let mut wire_bytes = 0;
    while let Some(chunk) = response.body.next().await {
        let chunk = chunk?;
        if !head_only && chunk.len() > limit - wire_bytes {
            return Err(PreviewFetchError::TooLarge);
        }
        let consumed = chunk.len().min(limit - wire_bytes);
        wire_bytes += consumed;
        let chunk = &chunk[..consumed];
        if let Some(decoder) = decoder.as_mut() {
            for part in chunk.chunks(8192) {
                let result = decoder.write_all(part);
                if decoder.get_ref().complete {
                    // Intentionally partial gzip: unread trailer/CRC cannot be checked.
                    return Ok(std::mem::take(&mut decoder.get_mut().bytes));
                }
                result.map_err(|_| gzip_error(decoder))?;
                // Yield between bounded decode operations so the overall fetch deadline applies.
                tokio::task::yield_now().await;
            }
        } else {
            for part in chunk.chunks(8192) {
                bytes.extend_from_slice(part);
                if head_only && weixin::head_complete(&bytes) {
                    return Ok(bytes);
                }
            }
        }
        if head_only && wire_bytes == limit {
            return Err(PreviewFetchError::TooLarge);
        }
    }
    if let Some(mut decoder) = decoder {
        decoder.try_finish().map_err(|_| gzip_error(&decoder))?;
        return Ok(std::mem::take(&mut decoder.get_mut().bytes));
    }
    Ok(bytes)
}

fn gzip_error(decoder: &MultiGzDecoder<LimitedBody>) -> PreviewFetchError {
    if decoder.get_ref().exceeded {
        PreviewFetchError::TooLarge
    } else {
        PreviewFetchError::ContentEncoding
    }
}

struct LimitedBody {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
    head_only: bool,
    complete: bool,
}

impl Write for LimitedBody {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.complete {
            return Err(io::Error::other("preview head complete"));
        }
        if bytes.len() > self.limit - self.bytes.len() {
            self.exceeded = true;
            return Err(io::Error::other("decoded preview exceeds byte limit"));
        }
        self.bytes.extend_from_slice(bytes);
        if self.head_only && weixin::head_complete(&self.bytes) {
            self.complete = true;
            return Err(io::Error::other("preview head complete"));
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn is_public(ip: IpAddr) -> bool {
    static IPV4_DENY: LazyLock<Vec<IpNet>> = LazyLock::new(|| {
        [
            "0.0.0.0/8",
            "10.0.0.0/8",
            "100.64.0.0/10",
            "127.0.0.0/8",
            "169.254.0.0/16",
            "172.16.0.0/12",
            "192.0.0.0/24",
            "192.0.2.0/24",
            "192.88.99.0/24",
            "192.168.0.0/16",
            "198.18.0.0/15",
            "198.51.100.0/24",
            "203.0.113.0/24",
            "224.0.0.0/4",
            "240.0.0.0/4",
        ]
        .iter()
        .map(|s| s.parse().expect("static IP network"))
        .collect()
    });
    static IPV6_DENY: LazyLock<Vec<IpNet>> = LazyLock::new(|| {
        [
            "2001::/23",
            "2001:db8::/32",
            "2002::/16",
            "2620:4f:8000::/48",
            "3fff::/20",
        ]
        .iter()
        .map(|s| s.parse().expect("static IP network"))
        .collect()
    });
    static IPV6_GLOBAL: LazyLock<IpNet> =
        LazyLock::new(|| "2000::/3".parse().expect("static IP network"));
    match ip {
        IpAddr::V4(_) => !IPV4_DENY.iter().any(|net| net.contains(&ip)),
        IpAddr::V6(_) => {
            IPV6_GLOBAL.contains(&ip) && !IPV6_DENY.iter().any(|net| net.contains(&ip))
        }
    }
}

// Check the original authority before URL parsing can normalize away empty userinfo.
pub(super) fn resolve_reference(base: &Url, reference: &str) -> Option<Url> {
    let reference = reference.trim();
    if reference.is_empty() || reference.contains('\\') {
        return None;
    }
    if reference.starts_with("//") {
        validate_url(&format!("https:{reference}"))?;
    } else if reference.contains("://") {
        validate_url(reference)?;
    }
    let url = base.join(reference).ok()?;
    validate_url(url.as_str())
}

#[cfg(test)]
mod tests;
