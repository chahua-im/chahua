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

use super::sites::{LinkPreviewConfig, LinkPreviewHandler};

use super::{
    metadata::extract_preview,
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
            let mut preview = extract_preview(&final_url, &bytes)?;
            if self
                .config
                .handler_for(final_url.host_str().unwrap_or_default())
                == Some(LinkPreviewHandler::Xiaohongshu)
            {
                preview.image_url = preview
                    .image_url
                    .map(|image| xiaohongshu::cover_url(&final_url, image));
            }
            Ok(preview)
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
            let handler = self
                .config
                .handler_for(checked.host_str().unwrap_or_default());
            if html
                && handler == Some(LinkPreviewHandler::Xiaohongshu)
                && xiaohongshu::is_login_page(&checked)
            {
                return Err(PreviewFetchError::Http);
            }
            let host = checked.host_str().ok_or(PreviewFetchError::InvalidUrl)?;
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
                if challenge_attempted && zhihu::is_verification_page(&current) {
                    return Err(PreviewFetchError::Http);
                }
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
mod tests {
    use super::*;
    use std::{collections::VecDeque, sync::Mutex};

    #[derive(Default)]
    struct State {
        answers: VecDeque<Vec<SocketAddr>>,
        responses: VecDeque<Response>,
        calls: Vec<(String, SocketAddr)>,
        request_headers: Vec<Option<header::HeaderMap>>,
        cookies: Vec<Option<String>>,
        dns_hangs: bool,
        http_hangs: bool,
    }

    struct Fake(Arc<Mutex<State>>);

    impl Transport for Fake {
        fn resolve<'a>(
            &'a self,
            _: &'a str,
        ) -> BoxFuture<'a, Result<Vec<SocketAddr>, PreviewFetchError>> {
            Box::pin(async move {
                let (hang, answer) = {
                    let mut state = self.0.lock().unwrap();
                    (
                        state.dns_hangs,
                        state.answers.pop_front().unwrap_or_default(),
                    )
                };
                if hang {
                    futures::future::pending::<()>().await;
                }
                Ok(answer)
            })
        }

        fn get<'a>(
            &'a self,
            url: &'a Url,
            address: SocketAddr,
            headers: Option<&'a header::HeaderMap>,
        ) -> BoxFuture<'a, Result<Response, PreviewFetchError>> {
            Box::pin(async move {
                let (hang, response) = {
                    let mut state = self.0.lock().unwrap();
                    state.calls.push((url.to_string(), address));
                    state.request_headers.push(headers.cloned());
                    state.cookies.push(
                        headers
                            .and_then(|h| h.get(header::COOKIE))
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_owned),
                    );
                    (state.http_hangs, state.responses.pop_front())
                };
                if hang {
                    futures::future::pending::<()>().await;
                }
                response.ok_or(PreviewFetchError::Http)
            })
        }
    }

    fn addr(ip: &str) -> SocketAddr {
        SocketAddr::new(ip.parse().unwrap(), 443)
    }
    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }
    fn fetcher(state: Arc<Mutex<State>>) -> SecurePreviewFetcher {
        SecurePreviewFetcher {
            transport: Box::new(Fake(state)),
            config: Arc::new(LinkPreviewConfig::default()),
        }
    }
    fn configured_fetcher(state: Arc<Mutex<State>>) -> SecurePreviewFetcher {
        let settings: crate::config::LinkPreviewSettings = toml::from_str(
            r#"
[[sites]]
host = "example.com"
[sites.headers]
Cookie = { env = "ORIGIN_COOKIE" }
Authorization = { env = "ORIGIN_AUTH" }

[[sites]]
host = "other.example"
[sites.headers]
Cookie = { env = "DESTINATION_COOKIE" }
Referer = "https://other.example/"

[[sites]]
host = "blocked.example"
[sites.headers]
Cookie = { env = "BLOCKED_COOKIE" }
"#,
        )
        .unwrap();
        let config = crate::config::LinkPreviewConfig::from_settings(settings, |name| match name {
            "ORIGIN_COOKIE" => Some("origin=session".into()),
            "ORIGIN_AUTH" => Some("Bearer origin".into()),
            "DESTINATION_COOKIE" => Some("destination=session".into()),
            "BLOCKED_COOKIE" => Some("blocked=session".into()),
            _ => None,
        })
        .unwrap();
        let config = LinkPreviewConfig::default().with_overrides(&config);
        SecurePreviewFetcher {
            transport: Box::new(Fake(state)),
            config: Arc::new(config),
        }
    }
    fn response(status: StatusCode, headers: &[(&str, &str)], chunks: Vec<Vec<u8>>) -> Response {
        let mut map = header::HeaderMap::new();
        for (name, value) in headers {
            map.append(
                header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        Response {
            status,
            headers: map,
            body: Box::pin(futures::stream::iter(
                chunks
                    .into_iter()
                    .map(|chunk| Ok(bytes::Bytes::from(chunk))),
            )),
        }
    }
    fn ok_html(body: &str) -> Response {
        response(
            StatusCode::OK,
            &[("content-type", "text/html; charset=utf-8")],
            vec![body.as_bytes().to_vec()],
        )
    }
    fn redirect(location: &str) -> Response {
        response(StatusCode::FOUND, &[("location", location)], vec![])
    }

    fn zhihu_challenge() -> Response {
        response(
            StatusCode::FORBIDDEN,
            &[("content-type", "text/html")],
            vec![zhihu::tests::challenge_html().into_bytes()],
        )
    }

    fn zhihu_script() -> Response {
        response(
            StatusCode::OK,
            &[("content-type", "application/javascript")],
            vec![zhihu::tests::script()],
        )
    }

    fn response_state(responses: Vec<Response>) -> Arc<Mutex<State>> {
        Arc::new(Mutex::new(State {
            answers: vec![vec![addr("93.184.216.34")]; responses.len()].into(),
            responses: responses.into(),
            ..Default::default()
        }))
    }

    #[tokio::test]
    async fn xiaohongshu_share_preserves_parameters_and_extracts_note_metadata() {
        let destination = "https://www.xiaohongshu.com/discovery/item/123?xsec_token=abc%2Bdef%3D&xsec_source=app_share&app_platform=android";
        let state = response_state(vec![redirect(destination), ok_html("<meta name='og:title' content='Note title'><meta name='description' content='Note description'>")]);
        let result = fetcher(state.clone())
            .fetch_page(&url("https://xhslink.cn/o/test"))
            .await
            .unwrap();
        assert_eq!(result.title, "Note title");
        assert_eq!(result.description.as_deref(), Some("Note description"));
        assert_eq!(state.lock().unwrap().calls[1].0, destination);
    }

    #[tokio::test]
    async fn xiaohongshu_login_redirect_does_not_become_slogan_preview() {
        let state = response_state(vec![
            redirect("https://www.xiaohongshu.com/login?redirectPath=note"),
            ok_html("<title>小红书 - 你的生活兴趣社区</title>"),
        ]);
        assert!(matches!(
            fetcher(state.clone())
                .fetch_page(&url("https://xhslink.cn/o/test"))
                .await,
            Err(PreviewFetchError::Http)
        ));
        assert_eq!(state.lock().unwrap().calls.len(), 1);
    }

    #[tokio::test]
    async fn zhihu_challenge_retries_once_and_extracts_real_metadata() {
        let state = response_state(vec![zhihu_challenge(), zhihu_script(), ok_html("<meta property='og:title' content='Answer title'><meta name='description' content='Answer summary'>")]);
        let preview = fetcher(state.clone())
            .fetch_page(&url("https://www.zhihu.com/question/1/answer/2"))
            .await
            .unwrap();
        assert_eq!(preview.title, "Answer title");
        assert_eq!(preview.description.as_deref(), Some("Answer summary"));
        let state = state.lock().unwrap();
        assert_eq!(state.calls.len(), 3);
        assert!(state.cookies[0].is_none());
        assert!(state.cookies[1].is_none());
        assert!(state.cookies[2]
            .as_ref()
            .unwrap()
            .starts_with("__zse_ck=005_"));
    }

    #[tokio::test]
    async fn configured_headers_and_generated_cookie_work_together() {
        let state = response_state(vec![
            zhihu_challenge(),
            zhihu_script(),
            ok_html("<title>Answer</title>"),
        ]);
        let mut fetcher = fetcher(state.clone());
        let overrides = crate::config::LinkPreviewConfig::from_settings(
            toml::from_str(
                r#"
[[sites]]
host = "www.zhihu.com"
headers = { User-Agent = "custom-agent", Cookie = { env = "COOKIE" } }
"#,
            )
            .unwrap(),
            |_| Some("session=keep; __zse_ck=old; preference=keep".into()),
        )
        .unwrap();
        fetcher.config = Arc::new(LinkPreviewConfig::default().with_overrides(&overrides));
        fetcher
            .fetch_page(&url("https://www.zhihu.com/question/1"))
            .await
            .unwrap();
        let state = state.lock().unwrap();
        assert!(state.cookies[1].is_none());
        let retry = state.request_headers[2].as_ref().unwrap();
        assert_eq!(retry[header::USER_AGENT], "custom-agent");
        assert!(retry[header::COOKIE].is_sensitive());
        let cookie = state.cookies[2].as_ref().unwrap();
        assert!(cookie.contains("session=keep; preference=keep; __zse_ck=005_"));
        assert_eq!(cookie.matches("__zse_ck=").count(), 1);
    }

    #[tokio::test]
    async fn omitted_handler_disables_site_processing() {
        let state = response_state(vec![zhihu_challenge()]);
        let mut fetcher = fetcher(state.clone());
        fetcher.config = Arc::new(LinkPreviewConfig::empty());
        assert!(matches!(
            fetcher
                .fetch_page(&url("https://www.zhihu.com/question/1"))
                .await,
            Err(PreviewFetchError::Http)
        ));
        assert_eq!(state.lock().unwrap().calls.len(), 1);
    }

    #[tokio::test]
    async fn zhihu_cookie_is_discarded_on_cross_origin_redirect() {
        let state = response_state(vec![
            zhihu_challenge(),
            zhihu_script(),
            redirect("https://example.com/"),
            redirect("https://www.zhihu.com/question/1"),
            ok_html("<title>Final</title>"),
        ]);
        fetcher(state.clone())
            .fetch_page(&url("https://www.zhihu.com/question/1"))
            .await
            .unwrap();
        let state = state.lock().unwrap();
        assert!(state.cookies[2].is_some());
        assert!(state.cookies[3].is_none());
        assert!(state.cookies[4].is_none());
    }

    #[tokio::test]
    async fn zhihu_failure_and_other_sites_do_not_repeat_challenges() {
        let state = response_state(vec![zhihu_challenge(), zhihu_script(), zhihu_challenge()]);
        assert!(matches!(
            fetcher(state.clone())
                .fetch_page(&url("https://www.zhihu.com/question/1"))
                .await,
            Err(PreviewFetchError::Http)
        ));
        assert_eq!(state.lock().unwrap().calls.len(), 3);
        let state = response_state(vec![zhihu_challenge()]);
        assert!(matches!(
            fetcher(state.clone())
                .fetch_page(&url("https://example.com/"))
                .await,
            Err(PreviewFetchError::Http)
        ));
        assert_eq!(state.lock().unwrap().calls.len(), 1);
    }

    #[tokio::test]
    async fn zhihu_manual_verification_is_not_used_as_preview() {
        let state = response_state(vec![
            zhihu_challenge(),
            zhihu_script(),
            redirect("https://www.zhihu.com/account/unhuman?next=%2Fquestion%2F1"),
        ]);
        assert!(matches!(
            fetcher(state.clone())
                .fetch_page(&url("https://www.zhihu.com/question/1"))
                .await,
            Err(PreviewFetchError::Http)
        ));
        assert_eq!(state.lock().unwrap().calls.len(), 3);
    }

    #[tokio::test]
    async fn zhihu_script_obeys_address_and_size_limits() {
        let state = response_state(vec![zhihu_challenge(), zhihu_script()]);
        state.lock().unwrap().answers[1] = vec![addr("127.0.0.1")];
        assert!(matches!(
            fetcher(state.clone())
                .fetch_page(&url("https://www.zhihu.com/question/1"))
                .await,
            Err(PreviewFetchError::ForbiddenAddress)
        ));
        assert_eq!(state.lock().unwrap().calls.len(), 1);
        let state = response_state(vec![
            zhihu_challenge(),
            response(StatusCode::OK, &[], vec![vec![b'A'; HTML_LIMIT + 1]]),
        ]);
        assert!(matches!(
            fetcher(state)
                .fetch_page(&url("https://www.zhihu.com/question/1"))
                .await,
            Err(PreviewFetchError::TooLarge)
        ));
    }

    #[test]
    fn link_preview_ip_policy_rejects_special_ranges() {
        for ip in [
            "0.1.2.3",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.0.0.1",
            "192.0.2.1",
            "192.88.99.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "::1",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
            "fe80::1",
            "2001::1",
            "2001:db8::1",
            "2002::1",
            "2620:4f:8000::1",
            "3fff::1",
        ] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(is_public(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn link_preview_extracts_prioritized_metadata_and_safe_image() {
        let page = extract_preview(
            &url("https://example.com/a/page"),
            br#"
            <base href='https://wrong.example/'><title>fallback</title>
            <meta name='twitter:title' content='Twitter'>
            <meta property='og:title' content='  One   Two '>
            <meta property='og:image' content='http://insecure.example/x'>
            <meta property='og:image' content='../cover.png'>
            <meta name='twitter:image' content='/other.png'>
        "#,
        )
        .unwrap();
        assert_eq!(page.title, "One Two");
        assert_eq!(
            page.image_url.unwrap().as_str(),
            "https://example.com/cover.png"
        );
        assert!(matches!(
            extract_preview(&url("https://example.com/"), b"<title>  </title>"),
            Err(PreviewFetchError::MissingTitle)
        ));
        let long = format!("<title>{}</title>", "x".repeat(600));
        assert_eq!(
            extract_preview(&url("https://example.com/"), long.as_bytes())
                .unwrap()
                .title
                .chars()
                .count(),
            512
        );
    }

    #[test]
    fn link_preview_description_skips_empty_values_and_preserves_normalization() {
        let base = url("https://example.com/");
        for html in [
            "<title>Title</title>",
            "<title>Title</title><meta property='og:description' content=' &#32; '>",
        ] {
            assert!(extract_preview(&base, html.as_bytes())
                .unwrap()
                .description
                .is_none());
        }
        let html = "<title>Title</title>\
            <meta property='og:description' content='  '>\
            <meta name='OG:DESCRIPTION' content='  One &amp;  Two&#10;三  '>\
            <meta property='og:description' content='later'>";
        assert_eq!(
            extract_preview(&base, html.as_bytes())
                .unwrap()
                .description
                .as_deref(),
            Some("One & Two 三")
        );
        let html = format!(
            "<title>Title</title><meta property='og:description' content='{}'>",
            "界".repeat(513)
        );
        assert_eq!(
            extract_preview(&base, html.as_bytes())
                .unwrap()
                .description
                .unwrap(),
            "界".repeat(512)
        );
    }

    #[tokio::test]
    async fn link_preview_site_headers_follow_each_redirect_target() {
        for (target, expected_cookie, expected_authorization, expected_referer) in [
            ("/next", Some("origin=session"), Some("Bearer origin"), None),
            (
                "https://other.example/next",
                Some("destination=session"),
                None,
                Some("https://other.example/"),
            ),
            ("https://sub.example.com/next", None, None, None),
        ] {
            let state = Arc::new(Mutex::new(State {
                answers: VecDeque::from([vec![addr("8.8.8.8")], vec![addr("1.1.1.1")]]),
                responses: VecDeque::from([redirect(target), ok_html("<title>ok</title>")]),
                ..State::default()
            }));
            configured_fetcher(state.clone())
                .fetch_page(&url("https://example.com/start"))
                .await
                .unwrap();
            let state = state.lock().unwrap();
            let origin = state.request_headers[0].as_ref().unwrap();
            assert_eq!(origin.get(header::COOKIE).unwrap(), "origin=session");
            assert_eq!(origin.get(header::AUTHORIZATION).unwrap(), "Bearer origin");
            let destination = state.request_headers[1].as_ref();
            let get = |name| {
                destination
                    .and_then(|headers| headers.get(name))
                    .map(|v| v.to_str().unwrap())
            };
            assert_eq!(get(header::COOKIE), expected_cookie);
            assert_eq!(get(header::AUTHORIZATION), expected_authorization);
            assert_eq!(get(header::REFERER), expected_referer);
        }
    }

    #[tokio::test]
    async fn link_preview_site_headers_use_thumbnail_host() {
        let state = Arc::new(Mutex::new(State {
            answers: VecDeque::from([vec![addr("8.8.8.8")], vec![addr("1.1.1.1")]]),
            responses: VecDeque::from([
                ok_html("<title>ok</title><meta property='og:image' content='https://other.example/image'>"),
                response(StatusCode::OK, &[], vec![b"image".to_vec()]),
            ]),
            ..State::default()
        }));
        let fetcher = configured_fetcher(state.clone());
        let page = fetcher
            .fetch_page(&url("https://example.com/"))
            .await
            .unwrap();
        assert_eq!(
            fetcher
                .fetch_thumbnail(&page.image_url.unwrap())
                .await
                .unwrap(),
            b"image"
        );
        let state = state.lock().unwrap();
        let image_headers = state.request_headers[1].as_ref().unwrap();
        assert_eq!(
            image_headers.get(header::COOKIE).unwrap(),
            "destination=session"
        );
        assert!(image_headers.get(header::AUTHORIZATION).is_none());
        assert_eq!(
            image_headers.get(header::REFERER).unwrap(),
            "https://other.example/"
        );
    }

    #[tokio::test]
    async fn link_preview_site_headers_cannot_bypass_redirect_address_policy() {
        let state = Arc::new(Mutex::new(State {
            answers: VecDeque::from([vec![addr("8.8.8.8")], vec![addr("127.0.0.1")]]),
            responses: VecDeque::from([redirect("https://blocked.example/")]),
            ..State::default()
        }));
        assert!(matches!(
            configured_fetcher(state.clone())
                .fetch_page(&url("https://example.com/"))
                .await,
            Err(PreviewFetchError::ForbiddenAddress)
        ));
        let state = state.lock().unwrap();
        assert_eq!(state.calls.len(), 1);
        assert_eq!(
            state.request_headers[0]
                .as_ref()
                .unwrap()
                .get(header::COOKIE)
                .unwrap(),
            "origin=session"
        );
    }

    #[tokio::test]
    async fn link_preview_pins_validated_address_and_revalidates_redirects() {
        let state = Arc::new(Mutex::new(State {
            answers: VecDeque::from([
                vec![addr("8.8.8.8"), addr("1.1.1.1")],
                vec![addr("1.1.1.1")],
            ]),
            responses: VecDeque::from([redirect("/next#fragment"), ok_html("<title>ok</title>")]),
            ..State::default()
        }));
        let result = fetcher(state.clone())
            .fetch_page(&url("https://example.com/start#fragment"))
            .await
            .unwrap();
        assert_eq!(result.title, "ok");
        assert_eq!(
            state.lock().unwrap().calls,
            vec![
                ("https://example.com/start".into(), addr("8.8.8.8")),
                ("https://example.com/next".into(), addr("1.1.1.1")),
            ]
        );

        // A rebinding answer on the next hop is rejected before a second dial.
        let state = Arc::new(Mutex::new(State {
            answers: VecDeque::from([vec![addr("8.8.8.8")], vec![addr("127.0.0.1")]]),
            responses: VecDeque::from([redirect("/next")]),
            ..State::default()
        }));
        assert!(matches!(
            fetcher(state.clone())
                .fetch_page(&url("https://example.com/"))
                .await,
            Err(PreviewFetchError::ForbiddenAddress)
        ));
        assert_eq!(state.lock().unwrap().calls.len(), 1);
        let state = Arc::new(Mutex::new(State {
            answers: VecDeque::from([vec![addr("8.8.8.8"), addr("10.0.0.1")]]),
            ..State::default()
        }));
        assert!(matches!(
            fetcher(state.clone())
                .fetch_thumbnail(&url("https://example.com/"))
                .await,
            Err(PreviewFetchError::ForbiddenAddress)
        ));
        assert!(state.lock().unwrap().calls.is_empty());
    }

    #[tokio::test]
    async fn link_preview_rejects_unsafe_urls_and_redirects() {
        for target in [
            "http://example.com/",
            "https://127.0.0.1/",
            "https://[::1]/",
            "https://example.com:444/",
            "https://user@example.com/",
        ] {
            let state = Arc::new(Mutex::new(State::default()));
            assert!(matches!(
                fetcher(state.clone()).fetch_thumbnail(&url(target)).await,
                Err(PreviewFetchError::InvalidUrl)
            ));
            assert!(state.lock().unwrap().calls.is_empty());
        }
        for target in [
            "http://example.com/",
            "https://127.0.0.1/",
            "https://[fe80::1]/",
            "",
        ] {
            let state = Arc::new(Mutex::new(State {
                answers: VecDeque::from([vec![addr("8.8.8.8")]]),
                responses: VecDeque::from([redirect(target)]),
                ..State::default()
            }));
            assert!(fetcher(state.clone())
                .fetch_page(&url("https://example.com/"))
                .await
                .is_err());
            assert_eq!(state.lock().unwrap().calls.len(), 1);
        }
        let state = Arc::new(Mutex::new(State {
            answers: (0..4).map(|_| vec![addr("8.8.8.8")]).collect(),
            responses: (0..4).map(|_| redirect("/again")).collect(),
            ..State::default()
        }));
        assert!(matches!(
            fetcher(state.clone())
                .fetch_page(&url("https://example.com/"))
                .await,
            Err(PreviewFetchError::Redirect)
        ));
        assert_eq!(state.lock().unwrap().calls.len(), 4);
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn gzip_response(bytes: Vec<u8>) -> Response {
        response(
            StatusCode::OK,
            &[("content-type", "text/html"), ("content-encoding", "gzip")],
            bytes.chunks(7).map(<[u8]>::to_vec).collect(),
        )
    }

    const WEIXIN_META: &str = "<head><meta property='og:title' content='文章标题'><meta property='og:image' content='https://example.com/cover.jpg'><meta property='og:description' content=''>";

    #[tokio::test]
    async fn weixin_stops_before_body_despite_large_content_length() {
        let mut reply = response(
            StatusCode::OK,
            &[("content-type", "text/html"), ("content-length", "3550000")],
            vec![WEIXIN_META.as_bytes().to_vec()],
        );
        reply.body = Box::pin(reply.body.chain(futures::stream::once(async {
            Err(PreviewFetchError::Http)
        })));
        let state = response_state(vec![reply]);
        let preview = fetcher(state)
            .fetch_page(&url("https://mp.weixin.qq.com/s?sn=test"))
            .await
            .unwrap();
        assert_eq!(preview.title, "文章标题");
        assert_eq!(
            preview.image_url.unwrap().as_str(),
            "https://example.com/cover.jpg"
        );
        assert!(preview.description.is_none());
    }

    #[tokio::test]
    async fn weixin_gzip_stops_before_inflating_large_article() {
        let mut article = WEIXIN_META.as_bytes().to_vec();
        article.extend(vec![b'A'; HTML_LIMIT * 4]);
        let compressed = gzip(&article);
        let prefix = read_body(gzip_response(compressed.clone()), HTML_LIMIT, true)
            .await
            .unwrap();
        assert!(prefix.len() < 32768);
        assert!(weixin::head_complete(&prefix));
        assert!(matches!(
            read_body(gzip_response(compressed), HTML_LIMIT, false).await,
            Err(PreviewFetchError::TooLarge)
        ));
    }

    #[tokio::test]
    async fn weixin_prefix_handles_split_tags_head_end_and_size_limit() {
        let chunks = WEIXIN_META
            .as_bytes()
            .chunks(1)
            .map(<[u8]>::to_vec)
            .collect();
        let reply = response(StatusCode::OK, &[], chunks);
        assert_eq!(
            read_body(reply, HTML_LIMIT, true).await.unwrap(),
            WEIXIN_META.as_bytes()
        );
        let head = b"<head><title>Fallback</title></head>";
        let mut reply = response(StatusCode::OK, &[], vec![head.to_vec()]);
        reply.body = Box::pin(reply.body.chain(futures::stream::pending()));
        assert_eq!(read_body(reply, HTML_LIMIT, true).await.unwrap(), head);
        let reply = response(StatusCode::OK, &[], vec![vec![b'A'; HTML_LIMIT + 1]]);
        assert!(matches!(
            read_body(reply, HTML_LIMIT, true).await,
            Err(PreviewFetchError::TooLarge)
        ));
    }

    #[tokio::test]
    async fn link_preview_decodes_chunked_gzip_after_redirect() {
        let state = response_state(vec![redirect("https://example.com/video"), gzip_response(gzip(b"<meta property='og:title' content='Video'><meta name='description' content='Summary'>"))]);
        let result = fetcher(state)
            .fetch_page(&url("https://short.example/"))
            .await
            .unwrap();
        assert_eq!(result.title, "Video");
        assert_eq!(result.description.as_deref(), Some("Summary"));
    }

    #[tokio::test]
    async fn link_preview_decodes_gzip_thumbnail_and_concatenated_members() {
        let bytes = b"image bytes";
        let state = response_state(vec![gzip_response(gzip(bytes))]);
        assert_eq!(
            fetcher(state)
                .fetch_thumbnail(&url("https://example.com/image"))
                .await
                .unwrap(),
            bytes
        );
        let mut compressed = gzip(b"<title>");
        compressed.extend(gzip(b"Title</title>"));
        let state = response_state(vec![gzip_response(compressed)]);
        assert_eq!(
            fetcher(state)
                .fetch_page(&url("https://example.com/"))
                .await
                .unwrap()
                .title,
            "Title"
        );
    }

    #[tokio::test]
    async fn link_preview_gzip_enforces_wire_and_decoded_limits() {
        let compressed = gzip(&vec![b'A'; 4096]);
        assert!(compressed.len() < 1024);
        assert!(matches!(
            read_body(gzip_response(compressed), 1024, false).await,
            Err(PreviewFetchError::TooLarge)
        ));
        let mut reply = gzip_response(vec![0; 1025]);
        reply.body = Box::pin(futures::stream::iter([Ok(bytes::Bytes::from(vec![
            0;
            1025
        ]))]));
        assert!(matches!(
            read_body(reply, 1024, false).await,
            Err(PreviewFetchError::TooLarge)
        ));
        assert_eq!(
            read_body(gzip_response(gzip(&vec![b'A'; 1024])), 1024, false)
                .await
                .unwrap()
                .len(),
            1024
        );
    }

    #[tokio::test]
    async fn link_preview_rejects_truncated_corrupt_and_unsupported_encodings() {
        let valid = gzip(b"<title>Title</title>");
        let mut corrupt = valid.clone();
        let crc = corrupt.len() - 8;
        corrupt[crc] ^= 1;
        for body in [
            Vec::new(),
            b"not gzip".to_vec(),
            valid[..valid.len() - 1].to_vec(),
            corrupt,
        ] {
            assert!(matches!(
                read_body(gzip_response(body), HTML_LIMIT, false).await,
                Err(PreviewFetchError::ContentEncoding)
            ));
        }
        for encoding in ["br", "gzip, gzip", "gzip, br"] {
            let reply = response(
                StatusCode::OK,
                &[("content-encoding", encoding)],
                vec![valid.clone()],
            );
            assert!(matches!(
                read_body(reply, HTML_LIMIT, false).await,
                Err(PreviewFetchError::ContentEncoding)
            ));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn link_preview_gzip_body_still_obeys_operation_deadline() {
        let mut reply = gzip_response(gzip(b"<title>Title</title>"));
        reply.body = Box::pin(reply.body.chain(futures::stream::pending()));
        let state = response_state(vec![reply]);
        assert!(matches!(
            fetcher(state)
                .fetch_page(&url("https://example.com/"))
                .await,
            Err(PreviewFetchError::Timeout)
        ));
    }

    #[tokio::test]
    async fn link_preview_rejects_bad_responses_and_streamed_overflow() {
        for (reply, html) in [
            (
                response(
                    StatusCode::OK,
                    &[("content-type", "text/html"), ("content-encoding", "gzip")],
                    vec![],
                ),
                true,
            ),
            (
                response(StatusCode::OK, &[("content-type", "text/plain")], vec![]),
                true,
            ),
            (response(StatusCode::NOT_FOUND, &[], vec![]), false),
            (
                response(
                    StatusCode::OK,
                    &[("content-type", "text/html")],
                    vec![vec![0; HTML_LIMIT], vec![0]],
                ),
                true,
            ),
            (
                response(StatusCode::OK, &[], vec![vec![0; IMAGE_LIMIT], vec![0]]),
                false,
            ),
        ] {
            let state = Arc::new(Mutex::new(State {
                answers: VecDeque::from([vec![addr("8.8.8.8")]]),
                responses: VecDeque::from([reply]),
                ..State::default()
            }));
            let fetcher = fetcher(state.clone());
            let result = fetcher
                .fetch_bytes(
                    &url("https://example.com/"),
                    if html { HTML_LIMIT } else { IMAGE_LIMIT },
                    html,
                )
                .await;
            assert!(result.is_err());
            assert_eq!(state.lock().unwrap().calls.len(), 1);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn link_preview_enforces_dns_and_operation_deadlines() {
        let state = Arc::new(Mutex::new(State {
            dns_hangs: true,
            ..State::default()
        }));
        assert!(matches!(
            fetcher(state)
                .fetch_page(&url("https://example.com/"))
                .await,
            Err(PreviewFetchError::Timeout)
        ));
        let state = Arc::new(Mutex::new(State {
            answers: VecDeque::from([vec![addr("8.8.8.8")]]),
            http_hangs: true,
            ..State::default()
        }));
        assert!(matches!(
            fetcher(state)
                .fetch_thumbnail(&url("https://example.com/"))
                .await,
            Err(PreviewFetchError::Timeout)
        ));
    }
}
