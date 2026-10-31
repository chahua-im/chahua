use std::sync::Arc;
use std::time::Instant;

use axum::extract::{MatchedPath, State};
use axum::http::{Method, Request};
use axum::middleware::Next;
use axum::response::Response;

use super::api::ApiMetrics;

/// Record application calls around all inner middleware, including client tracking.
pub async fn track_http_metrics(
    State(metrics): State<Arc<ApiMetrics>>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let start = Instant::now();
    let path = request.uri().path();
    // The upgrade endpoint is not an API call, even if the handshake fails.
    // Documentation and infrastructure traffic must not affect transport shares.
    let ignored = matches!(
        path,
        "/ws" | "/ws/" | "/docs" | "/api-docs" | "/metrics" | "/health" | "/healthz" | "/readyz"
    ) || path.starts_with("/docs/")
        || path.starts_with("/api-docs/");
    let api = canonical_api(
        request.method(),
        request
            .extensions()
            .get::<MatchedPath>()
            .map(MatchedPath::as_str),
    );
    let response = next.run(request).await;
    if !ignored {
        let status = response.status();
        let error_code = if status.is_client_error() || status.is_server_error() {
            status.as_str()
        } else {
            "none"
        };
        metrics.record(
            "http",
            api,
            status,
            error_code,
            start.elapsed().as_secs_f64(),
        );
    }
    response
}

// Match only route templates and supported methods; never put request paths or
// arbitrary methods into labels. Nested routers can expose a trailing slash.
fn canonical_api(method: &Method, path: Option<&str>) -> &'static str {
    let path = path.unwrap_or("").trim_end_matches('/');
    let method = if *method == Method::HEAD {
        &Method::GET
    } else {
        method
    };
    match (method.as_str(), path) {
        ("POST", "/auth/dev-session") => "auth.createDevSession",
        ("POST", "/auth/refresh") => "auth.refresh",
        ("GET", "/ws/ticket") => "sessions.createWebSocketTicket",
        ("GET", "/ws/clients") => "sessions.listClients",
        ("GET", "/users/auth-token") => "users.getAuthToken",
        ("GET", "/chats") => "chats.list",
        ("GET", "/chats/unread") => "chats.getTotalUnreadCount",
        ("PUT", "/chats/{chat_id}/archive") => "chats.archive",
        ("DELETE", "/chats/{chat_id}/archive") => "chats.unarchive",
        ("POST", "/chats/{chat_id}/read") => "chats.markAsRead",
        ("GET", "/chats/{chat_id}/read-receipt") => "chats.getReadReceipt",
        ("POST", "/chats/{chat_id}/unread") => "chats.markAsUnread",
        ("GET", "/chats/{chat_id}/unread") => "chats.getUnreadCount",
        ("GET", "/chats/{chat_id}/mentions") => "chats.listMentions",
        ("GET", "/chats/{chat_id}/reactions") => "chats.listUnreadReactions",
        ("POST", "/chats/{chat_id}/reactions/read") => "chats.acknowledgeReactions",
        ("GET", "/chats/{chat_id}/messages") => "messages.list",
        ("POST", "/chats/{chat_id}/messages") => "messages.send",
        ("GET", "/chats/{chat_id}/messages/search") => "messages.search",
        ("GET", "/chats/{chat_id}/messages/{message_id}") => "messages.get",
        ("PATCH", "/chats/{chat_id}/messages/{message_id}") => "messages.edit",
        ("DELETE", "/chats/{chat_id}/messages/{message_id}") => "messages.delete",
        ("POST", "/chats/{chat_id}/messages/bulk-delete") => "messages.deleteMany",
        ("POST", "/chats/{chat_id}/messages/forward") => "messages.forward",
        ("POST", "/chats/{chat_id}/messages/{message_id}/forward") => "messages.forwardOne",
        ("GET", "/chats/{chat_id}/messages/{message_id}/forwarded-messages") => {
            "messages.listForwardedMessages"
        }
        (
            "GET",
            "/chats/{chat_id}/messages/{message_id}/forwarded-bundles/{bundle_id}/messages",
        ) => "messages.listForwardedBundleMessages",
        ("POST", "/chats/{chat_id}/threads/{thread_id}/messages") => "messages.sendInThread",
        ("GET", "/chats/{chat_id}/messages/{message_id}/reactions") => "reactions.list",
        ("PUT", "/chats/{chat_id}/messages/{message_id}/reactions/{emoji}") => "reactions.add",
        ("DELETE", "/chats/{chat_id}/messages/{message_id}/reactions/{emoji}") => {
            "reactions.remove"
        }
        ("GET", "/chats/{chat_id}/pins") => "pins.list",
        ("POST", "/chats/{chat_id}/pins") => "pins.create",
        ("DELETE", "/chats/{chat_id}/pins/{pin_id}") => "pins.delete",
        ("GET", "/chats/{chat_id}/threads/{thread_root_id}/pins") => "pins.listForThread",
        ("POST", "/chats/{chat_id}/threads/{thread_root_id}/pins") => "pins.createForThread",
        ("DELETE", "/chats/{chat_id}/threads/{thread_root_id}/pins/{pin_id}") => {
            "pins.deleteForThread"
        }
        ("GET", "/chats/{chat_id}/saved-messages") => "savedMessages.listForChat",
        ("GET", "/saved-messages") => "savedMessages.list",
        ("PUT", "/saved-messages/{message_id}") => "savedMessages.save",
        ("DELETE", "/saved-messages/by-message/{message_id}") => "savedMessages.deleteByMessage",
        ("DELETE", "/saved-messages/by-id/{saved_message_id}") => "savedMessages.delete",
        ("GET", "/saved-messages/{saved_message_id}/forwarded-messages") => {
            "savedMessages.listForwardedMessages"
        }
        ("GET", "/saved-messages/{saved_message_id}/forwarded-bundles/{bundle_id}/messages") => {
            "savedMessages.listForwardedBundleMessages"
        }
        ("GET", "/threads") => "threads.list",
        ("GET", "/threads/unread") => "threads.getUnreadCount",
        ("GET", "/chats/{chat_id}/threads") => "threads.listForChat",
        ("GET", "/chats/{chat_id}/threads/{thread_root_id}/participants") => {
            "threads.listParticipants"
        }
        ("POST", "/chats/{chat_id}/threads/{thread_root_id}/read")
        | ("POST", "/threads/{thread_root_id}/read") => "threads.markAsRead",
        ("GET", "/chats/{chat_id}/threads/{thread_root_id}/read-state")
        | ("GET", "/threads/{thread_root_id}/read-state") => "threads.getReadState",
        ("GET", "/chats/{chat_id}/threads/{thread_root_id}/subscribe") => {
            "threads.getSubscriptionStatus"
        }
        ("PUT", "/chats/{chat_id}/threads/{thread_root_id}/subscribe") => "threads.subscribe",
        ("DELETE", "/chats/{chat_id}/threads/{thread_root_id}/subscribe") => "threads.unsubscribe",
        ("PUT", "/chats/{chat_id}/threads/{thread_root_id}/archive") => "threads.archive",
        ("DELETE", "/chats/{chat_id}/threads/{thread_root_id}/archive") => "threads.unarchive",
        ("GET", "/chats/{chat_id}/attachments") => "attachments.listForChat",
        ("POST", "/attachments/upload-url") => "attachments.createUploadUrl",
        ("GET", "/attachments/config") => "attachments.getConfig",
        ("GET", "/group") => "groups.list",
        ("POST", "/group") => "groups.create",
        ("GET", "/group/{chat_id}") => "groups.get",
        ("PATCH", "/group/{chat_id}") => "groups.update",
        ("POST", "/group/{chat_id}/avatar/upload-url") => "groups.createAvatarUploadUrl",
        ("PUT", "/group/{chat_id}/mute") => "groups.mute",
        ("DELETE", "/group/{chat_id}/mute") => "groups.unmute",
        ("PUT", "/group/{chat_id}/notification-setting") => "groups.updateNotificationSetting",
        ("PUT", "/group/{chat_id}/speaking-mode") => "groups.updateSpeakingMode",
        ("GET", "/group/{chat_id}/members") => "groups.listMembers",
        ("POST", "/group/{chat_id}/members") => "groups.addMember",
        ("DELETE", "/group/{chat_id}/members/{uid}") => "groups.removeMember",
        ("PATCH", "/group/{chat_id}/members/{uid}") => "groups.updateMember",
        ("PUT", "/group/{chat_id}/members/{uid}/speaking-mode") => {
            "groups.updateMemberSpeakingMode"
        }
        ("GET", "/invites") => "invites.list",
        ("POST", "/invites") => "invites.create",
        ("POST", "/invites/send") => "invites.send",
        ("GET", "/invites/invite/{invite_id}") => "invites.get",
        ("GET", "/invites/invite") => "invites.getByCode",
        ("PATCH", "/invites/invite/{invite_id}") => "invites.update",
        ("DELETE", "/invites/invite/{invite_id}") => "invites.delete",
        ("POST", "/invites/redeem") => "invites.redeem",
        ("GET", "/friends") => "friends.list",
        ("GET", "/friends/{uid}") => "friends.getRelationship",
        ("DELETE", "/friends/{uid}") => "friends.remove",
        ("POST", "/friends/requests") => "friends.createRequest",
        ("GET", "/friends/requests") => "friends.listRequests",
        ("GET", "/friends/requests/pending/count") => "friends.getPendingRequestCount",
        ("POST", "/friends/requests/{request_id}/accept") => "friends.acceptRequest",
        ("POST", "/friends/requests/{request_id}/reject") => "friends.rejectRequest",
        ("PUT", "/friends/requests/{request_id}/archive") => "friends.archiveRequest",
        ("GET", "/friends/me/settings") => "friends.getSettings",
        ("PUT", "/friends/me/settings") => "friends.updateSettings",
        ("GET", "/friends/add-info/{uid}") => "friends.getAddInfo",
        ("GET", "/friends/{uid}/presence-settings") => "friends.getPresenceSettings",
        ("PUT", "/friends/{uid}/presence-settings") => "friends.updatePresenceSettings",
        ("GET", "/friends/{uid}/read-receipt-settings") => "friends.getReadReceiptSettings",
        ("PUT", "/friends/{uid}/read-receipt-settings") => "friends.updateReadReceiptSettings",
        ("GET", "/me/presence-settings") => "privacy.getPresenceSettings",
        ("PUT", "/me/presence-settings") => "privacy.updatePresenceSettings",
        ("GET", "/me/read-receipt-settings") => "privacy.getReadReceiptSettings",
        ("PUT", "/me/read-receipt-settings") => "privacy.updateReadReceiptSettings",
        ("GET", "/me/privacy-exceptions") => "privacy.listExceptions",
        ("DELETE", "/me/privacy-exceptions") => "privacy.clearExceptions",
        ("GET", "/blocks") => "blocks.list",
        ("POST", "/blocks") => "blocks.create",
        ("DELETE", "/blocks/{uid}") => "blocks.delete",
        ("GET", "/users/me") => "users.getMe",
        ("PUT", "/users/me/stickerpack-order") => "users.updateStickerPackOrder",
        ("PUT", "/users/me/chat-settings") => "users.updateChatSettings",
        ("GET", "/users/search") => "users.search",
        ("GET", "/users/me/notification-settings") => "users.getNotificationSettings",
        ("PATCH", "/users/me/notification-settings") => "users.updateNotificationSettings",
        ("GET", "/users/me/notification-exceptions") => "users.listNotificationExceptions",
        ("DELETE", "/users/me/notification-exceptions") => "users.clearNotificationExceptions",
        ("GET", "/push/vapid-public-key") => "push.getVapidPublicKey",
        ("GET", "/push/subscription-status") => "push.getSubscriptionStatus",
        ("POST", "/push/subscribe") => "push.subscribe",
        ("POST", "/push/unsubscribe") => "push.unsubscribe",
        ("GET", "/stickers/packs") => "stickers.listPacks",
        ("POST", "/stickers/packs") => "stickers.createPack",
        ("GET", "/stickers/packs/{pack_id}") => "stickers.getPack",
        ("PATCH", "/stickers/packs/{pack_id}") => "stickers.updatePack",
        ("DELETE", "/stickers/packs/{pack_id}") => "stickers.deletePack",
        ("GET", "/stickers/packs/mine/subscribed") => "stickers.listSubscribedPacks",
        ("GET", "/stickers/packs/mine/owned") => "stickers.listOwnedPacks",
        ("PUT", "/stickers/packs/{pack_id}/subscription") => "stickers.subscribeToPack",
        ("DELETE", "/stickers/packs/{pack_id}/subscription") => "stickers.unsubscribeFromPack",
        ("POST", "/stickers/packs/{pack_id}/stickers") => "stickers.uploadToPack",
        ("PUT", "/stickers/packs/{pack_id}/stickers/{sticker_id}") => "stickers.addToPack",
        ("DELETE", "/stickers/packs/{pack_id}/stickers/{sticker_id}") => "stickers.removeFromPack",
        ("GET", "/stickers/{sticker_id}") => "stickers.get",
        ("PUT", "/stickers/{sticker_id}/favorite") => "stickers.favorite",
        ("DELETE", "/stickers/{sticker_id}/favorite") => "stickers.unfavorite",
        ("GET", "/stickers/mine/favorites") => "stickers.listFavorites",
        ("POST", "/service-tokens") => "serviceTokens.create",
        ("GET", "/service-tokens") => "serviceTokens.list",
        ("DELETE", "/service-tokens/{id}") => "serviceTokens.delete",
        ("POST", "/service-tokens/{id}/rotate") => "serviceTokens.rotate",
        ("POST", "/external/invites") => "external.createInvite",
        ("POST", "/external/social/relationships") => "external.getRelationships",
        ("GET", "/external/sessions/{uid}") => "external.getSessionGeneration",
        ("POST", "/external/sessions/{uid}/revoke") => "external.revokeSessions",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
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
}
