use super::*;
use std::{collections::VecDeque, sync::Mutex};

#[derive(Default)]
struct State {
    answers: VecDeque<Vec<SocketAddr>>,
    responses: VecDeque<Response>,
    calls: Vec<(String, SocketAddr)>,
    request_headers: Vec<Option<header::HeaderMap>>,
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
        config: Arc::default(),
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

fn response_state(responses: Vec<Response>) -> Arc<Mutex<State>> {
    Arc::new(Mutex::new(State {
        answers: vec![vec![addr("93.184.216.34")]; responses.len()].into(),
        responses: responses.into(),
        ..Default::default()
    }))
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
    let start = url("https://example.com/start");
    for (target, expected_cookie, expected_authorization, expected_referer) in [
        ("/next", Some("origin=session"), Some("Bearer origin"), None),
        (
            "https://other.example/next?token=abc%2Bdef%3D&source=share",
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
            .fetch_page(&start)
            .await
            .unwrap();
        let state = state.lock().unwrap();
        assert_eq!(state.calls[1].0, start.join(target).unwrap().as_str());
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
            ok_html(
                "<title>ok</title><meta property='og:image' content='https://other.example/image'>",
            ),
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
