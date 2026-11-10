use std::{
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::LazyLock,
    time::Duration,
};

use futures::{future::BoxFuture, stream::Stream, StreamExt};
use ipnet::IpNet;
use reqwest::{header, redirect::Policy, StatusCode};
use scraper::{Html, Selector};
use url::Url;

use super::validate_url;

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
                .user_agent("chahua-link-preview/1.0")
                .build()
                .map_err(|_| PreviewFetchError::Http)?;
            let response = client
                .get(url.clone())
                .header(header::ACCEPT_ENCODING, "identity")
                .send()
                .await
                .map_err(|_| PreviewFetchError::Http)?;
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
}

impl Default for SecurePreviewFetcher {
    fn default() -> Self {
        Self::new()
    }
}

impl SecurePreviewFetcher {
    pub fn new() -> Self {
        Self {
            transport: Box::new(SystemTransport),
        }
    }

    pub async fn fetch_page(&self, url: &Url) -> Result<FetchedLinkPreview, PreviewFetchError> {
        tokio::time::timeout(OPERATION_TIMEOUT, async {
            let (final_url, bytes) = self.fetch_bytes(url, HTML_LIMIT, true).await?;
            extract_preview(&final_url, &bytes)
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
        for redirects in 0..=MAX_REDIRECTS {
            let checked = validate_url(current.as_str()).ok_or(PreviewFetchError::InvalidUrl)?;
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
            let mut response = self.transport.get(&checked, address).await?;
            for value in response.headers.get_all(header::CONTENT_ENCODING) {
                let value = value
                    .to_str()
                    .map_err(|_| PreviewFetchError::ContentEncoding)?;
                if !value.trim().eq_ignore_ascii_case("identity") {
                    return Err(PreviewFetchError::ContentEncoding);
                }
            }
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
                continue;
            }
            if !response.status.is_success() {
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
            if let Some(length) = response
                .headers
                .get(header::CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
            {
                if length > limit as u64 {
                    return Err(PreviewFetchError::TooLarge);
                }
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.body.next().await {
                let chunk = chunk?;
                if chunk.len() > limit - bytes.len() {
                    return Err(PreviewFetchError::TooLarge);
                }
                bytes.extend_from_slice(&chunk);
            }
            return Ok((checked, bytes));
        }
        Err(PreviewFetchError::Redirect)
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
fn resolve_reference(base: &Url, reference: &str) -> Option<Url> {
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

fn extract_preview(base: &Url, bytes: &[u8]) -> Result<FetchedLinkPreview, PreviewFetchError> {
    let document = Html::parse_document(&String::from_utf8_lossy(bytes));
    let meta = Selector::parse("meta").expect("static selector");
    let title_selector = Selector::parse("title").expect("static selector");
    let metadata = |name: &'static str| {
        document.select(&meta).filter_map(move |element| {
            let value = element.value();
            let matches = value
                .attr("property")
                .into_iter()
                .chain(value.attr("name"))
                .any(|attribute| attribute.eq_ignore_ascii_case(name));
            matches.then(|| value.attr("content")).flatten()
        })
    };
    let normalize = |s: &str| {
        let mut normalized = String::new();
        for word in s.split_whitespace() {
            if !normalized.is_empty() {
                normalized.push(' ');
            }
            normalized.push_str(word);
        }
        normalized
    };
    let mut title = metadata("og:title")
        .chain(metadata("twitter:title"))
        .map(normalize)
        .find(|value| !value.is_empty())
        .or_else(|| {
            document
                .select(&title_selector)
                .map(|element| normalize(&element.text().collect::<String>()))
                .find(|value| !value.is_empty())
        })
        .ok_or(PreviewFetchError::MissingTitle)?;
    if let Some((end, _)) = title.char_indices().nth(512) {
        title.truncate(end);
    }
    let image_url = metadata("og:image")
        .chain(metadata("twitter:image"))
        .filter_map(|raw| resolve_reference(base, raw))
        .next();
    Ok(FetchedLinkPreview { title, image_url })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };

    #[derive(Default)]
    struct State {
        answers: VecDeque<Vec<SocketAddr>>,
        responses: VecDeque<Response>,
        calls: Vec<(String, SocketAddr)>,
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
        ) -> BoxFuture<'a, Result<Response, PreviewFetchError>> {
            Box::pin(async move {
                let (hang, response) = {
                    let mut state = self.0.lock().unwrap();
                    state.calls.push((url.to_string(), address));
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
