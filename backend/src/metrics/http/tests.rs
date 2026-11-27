use super::*;
use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::routing::{get, post};
use axum::{middleware, Router};
use prometheus::{proto::Metric, Registry};
use std::time::Duration;
use tower::ServiceExt;

fn sample(registry: &Registry, family: &str, labels: &[(&str, &str)]) -> Option<Metric> {
    registry
        .gather()
        .into_iter()
        .find(|metric| metric.get_name() == family)?
        .get_metric()
        .iter()
        .find(|metric| {
            labels.iter().all(|(name, value)| {
                metric
                    .get_label()
                    .iter()
                    .any(|label| label.get_name() == *name && label.get_value() == *value)
            })
        })
        .cloned()
}

#[test]
fn operation_mapping_is_method_sensitive_and_bounded() {
    assert_eq!(
        canonical_api(&Method::GET, Some("/chats/difference")),
        "chats.difference"
    );
    assert_eq!(
        canonical_api(&Method::HEAD, Some("/chats/difference")),
        "unknown"
    );
    assert_eq!(
        canonical_api(&Method::POST, Some("/chats/difference")),
        "unknown"
    );
    assert_eq!(
        canonical_api(&Method::GET, Some("/chats/{chat_id}/messages/")),
        "messages.list"
    );
    assert_eq!(
        canonical_api(&Method::POST, Some("/chats/{chat_id}/messages")),
        "messages.send"
    );
    assert_eq!(
        canonical_api(&Method::DELETE, Some("/chats/{chat_id}/messages")),
        "unknown"
    );
    assert_eq!(
        canonical_api(&Method::GET, Some("/chats/private-id/messages")),
        "unknown"
    );
    assert_eq!(canonical_api(&Method::GET, None), "unknown");
    assert_eq!(
        canonical_api(&Method::POST, Some("/stickers/packs/{pack_id}/stickers")),
        "stickers.uploadToPack"
    );
}

async fn delayed(next_request: Request<Body>, next: Next) -> Response {
    tokio::time::sleep(Duration::from_millis(20)).await;
    next.run(next_request).await
}

async fn upload() -> StatusCode {
    tokio::time::sleep(Duration::from_millis(20)).await;
    StatusCode::BAD_REQUEST
}

#[tokio::test]
async fn multipart_errors_and_latency_include_inner_middleware() {
    let registry = Registry::new();
    let metrics = Arc::new(ApiMetrics::new(&registry));
    let app = Router::new()
        .nest(
            "/stickers",
            Router::new().route("/packs/{pack_id}/stickers", post(upload)),
        )
        .layer(middleware::from_fn(delayed))
        .layer(middleware::from_fn_with_state(metrics, track_http_metrics));
    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/stickers/packs/42/stickers")
                .header(header::CONTENT_TYPE, "multipart/form-data; boundary=abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let labels = [
        ("transport", "http"),
        ("api", "stickers.uploadToPack"),
        ("status", "400"),
    ];
    let counter = sample(
        &registry,
        "api_requests_total",
        &[labels[0], labels[1], labels[2], ("error_code", "400")],
    )
    .unwrap();
    assert_eq!(counter.get_counter().get_value(), 1.0);
    let histogram = sample(&registry, "api_request_duration_seconds", &labels).unwrap();
    assert_eq!(histogram.get_histogram().get_sample_count(), 1);
    assert!(histogram.get_histogram().get_sample_sum() >= 0.035);
}

#[tokio::test]
async fn multipart_success_is_counted_in_both_families() {
    let registry = Registry::new();
    let metrics = Arc::new(ApiMetrics::new(&registry));
    let app = Router::new()
        .route(
            "/stickers/packs/{pack_id}/stickers",
            post(|| async { StatusCode::CREATED }),
        )
        .layer(middleware::from_fn_with_state(metrics, track_http_metrics));
    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/stickers/packs/42/stickers")
                .header(header::CONTENT_TYPE, "multipart/form-data; boundary=abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let labels = [
        ("transport", "http"),
        ("api", "stickers.uploadToPack"),
        ("status", "201"),
    ];
    let counter = sample(
        &registry,
        "api_requests_total",
        &[labels[0], labels[1], labels[2], ("error_code", "none")],
    )
    .unwrap();
    assert_eq!(counter.get_counter().get_value(), 1.0);
    let histogram = sample(&registry, "api_request_duration_seconds", &labels).unwrap();
    assert_eq!(histogram.get_histogram().get_sample_count(), 1);
}

#[tokio::test]
async fn unknown_requests_are_bounded_and_docs_and_upgrade_are_ignored() {
    let registry = Registry::new();
    let metrics = Arc::new(ApiMetrics::new(&registry));
    let app = Router::new()
        .route("/chats", get(|| async { StatusCode::OK }))
        .route("/ws", get(|| async { StatusCode::BAD_REQUEST }))
        .route("/api-docs/openrpc.json", get(|| async { StatusCode::OK }))
        .layer(middleware::from_fn_with_state(metrics, track_http_metrics));
    for (method, uri) in [
        (Method::GET, "/chats"),
        (Method::POST, "/chats"),
        (Method::GET, "/missing/private"),
        (Method::GET, "/ws"),
        (Method::GET, "/api-docs/openrpc.json"),
    ] {
        app.clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
    }
    let success = sample(
        &registry,
        "api_requests_total",
        &[
            ("api", "chats.list"),
            ("status", "200"),
            ("error_code", "none"),
        ],
    )
    .unwrap();
    assert_eq!(success.get_counter().get_value(), 1.0);
    for status in ["404", "405"] {
        let count = sample(
            &registry,
            "api_requests_total",
            &[
                ("api", "unknown"),
                ("status", status),
                ("error_code", status),
            ],
        )
        .unwrap();
        assert_eq!(count.get_counter().get_value(), 1.0);
    }
    let family = registry
        .gather()
        .into_iter()
        .find(|family| family.get_name() == "api_requests_total")
        .unwrap();
    assert_eq!(family.get_metric().len(), 3);
}
