use crate::dto::attachments::ChatAttachmentKindFilter;
use crate::dto::ws::{
    ChatArchiveStateChangedPayload, FriendRequestReceivedPayload, FriendRequestResolvedPayload,
    FriendshipRemovedPayload, PinUpdatePayload, PresenceUpdatePayload, ReactionUpdatePayload,
    ServerWsMessage, ThreadMembershipChangedPayload, ThreadUpdatePayload,
};
use crate::handlers::groups::{GroupSearchMode, GroupSelectorScope};
use crate::services::{message_search::MessageSearchSort, user::UserSearchMode};
use utoipa::openapi::security::{Http, HttpAuthScheme, SecurityScheme};
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
            ChatAttachmentKindFilter,
            MessageSearchSort,
            GroupSearchMode,
            GroupSelectorScope,
            UserSearchMode,
            ServerWsMessage,
            ReactionUpdatePayload,
            PresenceUpdatePayload,
            ThreadUpdatePayload,
            ThreadMembershipChangedPayload,
            ChatArchiveStateChangedPayload,
            PinUpdatePayload,
            FriendRequestReceivedPayload,
            FriendRequestResolvedPayload,
            FriendshipRemovedPayload,
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
            "bearer_jwt",
            SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
        );
        components.add_security_scheme(
            "service_token_bearer",
            SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn api_document() -> Value {
        let mut document = ApiDoc::openapi();
        document.merge(crate::handlers::api_router().into_openapi());
        serde_json::to_value(document).unwrap()
    }

    #[test]
    fn api_document_has_no_unresolved_references() {
        fn check_references(value: &Value, document: &Value) {
            match value {
                Value::Object(object) => {
                    if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
                        let pointer = reference.strip_prefix('#').expect("local API reference");
                        assert!(
                            document.pointer(pointer).is_some(),
                            "unresolved: {reference}"
                        );
                    }
                    for child in object.values() {
                        check_references(child, document);
                    }
                }
                Value::Array(array) => {
                    for child in array {
                        check_references(child, document);
                    }
                }
                _ => {}
            }
        }

        let document = api_document();
        check_references(&document, &document);
    }

    #[test]
    fn api_document_uses_strings_for_snowflake_path_ids() {
        let document = api_document();
        let paths = document["paths"].as_object().unwrap();
        let snowflake_ids = [
            "chat_id",
            "message_id",
            "thread_id",
            "thread_root_id",
            "request_id",
            "invite_id",
            "pin_id",
            "pack_id",
            "sticker_id",
        ];
        let mut checked_ids = 0;

        for (path, item) in paths {
            for operation in item.as_object().unwrap().values() {
                let Some(parameters) = operation.get("parameters").and_then(Value::as_array) else {
                    continue;
                };
                for parameter in parameters {
                    let name = parameter["name"].as_str().unwrap();
                    if parameter["in"] == "path" && snowflake_ids.contains(&name) {
                        assert_eq!(
                            parameter["schema"]["type"],
                            "string",
                            "{path}: path ID {name} must preserve integers beyond JavaScript's safe range"
                        );
                        checked_ids += 1;
                    }
                }
            }
        }

        assert!(checked_ids > 0, "the document must include path IDs");
    }
}
