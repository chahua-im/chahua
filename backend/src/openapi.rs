use crate::dto::ws::{
    ChatArchiveStateChangedPayload, PinUpdatePayload, PresenceUpdatePayload, ReactionUpdatePayload,
    ServerWsMessage, ThreadMembershipChangedPayload, ThreadUpdatePayload,
};
use utoipa::openapi::security::{ApiKey, ApiKeyValue, Http, HttpAuthScheme, SecurityScheme};
use utoipa::OpenApi;

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Wetty Chat API",
        version = "0.1.0",
        description = "Real-time chat application backend API supporting groups, messaging, threads, stickers, invites, and push notifications.",
        license(name = "GPL-3.0", url = "https://www.gnu.org/licenses/gpl-3.0.html"),
    ),
    components(
        schemas(
            ServerWsMessage,
            ReactionUpdatePayload,
            PresenceUpdatePayload,
            ThreadUpdatePayload,
            ThreadMembershipChangedPayload,
            ChatArchiveStateChangedPayload,
            PinUpdatePayload,
        )
    ),
    modifiers(&SecurityAddon),
)]
pub struct ApiDoc;

struct SecurityAddon;

impl utoipa::Modify for SecurityAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.get_or_insert_with(Default::default);
        components.add_security_scheme(
            "uid_header",
            SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::new("X-User-Id"))),
        );
        components.add_security_scheme(
            "bearer_jwt",
            SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
        );
        components.add_security_scheme(
            "service_token_bearer",
            SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
        );
    }
}
