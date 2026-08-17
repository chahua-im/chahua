use axum::extract::{MatchedPath, State};
use axum::http::{header, Request, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use prometheus::{
    register_histogram_vec_with_registry, register_int_counter_vec_with_registry, HistogramVec,
    IntCounterVec, Registry,
};
use std::sync::Arc;
use std::time::Instant;

pub struct HttpMetrics {
    requests_total: IntCounterVec,
    request_duration_seconds: HistogramVec,
    multipart_duration_seconds: HistogramVec,
}

impl HttpMetrics {
    pub fn new(registry: &Registry) -> Self {
        let requests_total = register_int_counter_vec_with_registry!(
            "http_requests_total",
            "Total number of HTTP requests handled by the API server",
            &["method", "route", "status"],
            registry
        )
        .expect("http_requests_total registration should succeed");
        let request_duration_seconds = register_histogram_vec_with_registry!(
            "http_request_duration_seconds",
            "HTTP request latency in seconds for the API server",
            &["method", "route", "status"],
            vec![0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
            registry
        )
        .expect("http_request_duration_seconds registration should succeed");
        let multipart_duration_seconds = register_histogram_vec_with_registry!(
            "http_multipart_duration_seconds",
            "HTTP multipart request latency in seconds for the API server",
            &["method", "route", "status"],
            vec![0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
            registry
        )
        .expect("http_multipart_duration_seconds registration should succeed");

        Self {
            requests_total,
            request_duration_seconds,
            multipart_duration_seconds,
        }
    }

    pub fn record(&self, method: &str, route: &str, status: StatusCode, duration_seconds: f64) {
        let status = status.as_u16().to_string();
        self.requests_total
            .with_label_values(&[method, route, &status])
            .inc();
        self.request_duration_seconds
            .with_label_values(&[method, route, &status])
            .observe(duration_seconds);
    }

    pub fn record_multipart(
        &self,
        method: &str,
        route: &str,
        status: StatusCode,
        duration_seconds: f64,
    ) {
        let status = status.as_u16().to_string();
        self.multipart_duration_seconds
            .with_label_values(&[method, route, &status])
            .observe(duration_seconds);
    }
}

pub async fn track_http_metrics(
    State(metrics): State<Arc<HttpMetrics>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let method = request.method().as_str().to_string();
    let route = route_label(
        request
            .extensions()
            .get::<MatchedPath>()
            .map(MatchedPath::as_str),
    );
    let is_multipart = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("multipart/form-data"));
    let start = Instant::now();

    let response = next.run(request).await;
    let elapsed = start.elapsed().as_secs_f64();
    if is_multipart {
        metrics.record_multipart(&method, &route, response.status(), elapsed);
    } else {
        metrics.record(&method, &route, response.status(), elapsed);
    }

    response
}

fn route_label(matched_path: Option<&str>) -> String {
    matched_path.unwrap_or("unknown").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use axum::routing::get;
    use axum::{middleware, Router};
    use tower::ServiceExt;

    async fn ok_handler() -> &'static str {
        "ok"
    }

    async fn not_found_handler() -> StatusCode {
        StatusCode::NOT_FOUND
    }

    #[test]
    fn route_label_falls_back_to_unknown() {
        assert_eq!(route_label(None), "unknown");
    }

    #[tokio::test]
    async fn http_metrics_count_requests_by_matched_route() {
        let registry = Registry::new();
        let metrics = Arc::new(HttpMetrics::new(&registry));
        let app = Router::new()
            .route("/items/{id}", get(ok_handler))
            .layer(middleware::from_fn_with_state(metrics, track_http_metrics));

        let response = app
            .oneshot(
                HttpRequest::builder()
                    .method("GET")
                    .uri("/items/42")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("app should respond");

        assert_eq!(response.status(), StatusCode::OK);

        let rendered = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(rendered.contains("http_requests_total"));
        assert!(rendered.contains("method=\"GET\",route=\"/items/{id}\",status=\"200\""));
    }

    #[tokio::test]
    async fn http_metrics_record_unknown_for_unmatched_requests() {
        let registry = Registry::new();
        let metrics = Arc::new(HttpMetrics::new(&registry));
        let app = Router::new()
            .fallback(get(not_found_handler))
            .layer(middleware::from_fn_with_state(metrics, track_http_metrics));

        let response = app
            .oneshot(
                HttpRequest::builder()
                    .method("GET")
                    .uri("/missing")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("app should respond");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let rendered = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(rendered.contains("method=\"GET\",route=\"unknown\",status=\"404\""));
    }

    #[tokio::test]
    async fn multipart_requests_use_dedicated_duration_metric() {
        let registry = Registry::new();
        let metrics = Arc::new(HttpMetrics::new(&registry));
        let app = Router::new()
            .route("/upload", get(ok_handler))
            .layer(middleware::from_fn_with_state(metrics, track_http_metrics));

        let response = app
            .oneshot(
                HttpRequest::builder()
                    .method("GET")
                    .uri("/upload")
                    .header(header::CONTENT_TYPE, "multipart/form-data; boundary=abc123")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("app should respond");

        assert_eq!(response.status(), StatusCode::OK);

        let rendered = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(rendered.contains("http_multipart_duration_seconds"));
        assert!(rendered.contains(
            "http_multipart_duration_seconds_bucket{method=\"GET\",route=\"/upload\",status=\"200\""
        ));
        assert!(!rendered
            .contains("http_requests_total{method=\"GET\",route=\"/upload\",status=\"200\"} 1"));
        assert!(!rendered.contains(
            "http_request_duration_seconds_bucket{method=\"GET\",route=\"/upload\",status=\"200\""
        ));
    }
}
