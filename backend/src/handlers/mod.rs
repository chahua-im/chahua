pub mod attachments;
pub mod chats;
pub mod external;
pub mod groups;
pub mod invites;
pub mod members;
pub mod pins;
pub mod push;
pub mod service_tokens;
pub mod stickers;
pub mod threads;
pub mod users;
pub mod ws;

use crate::AppState;
use utoipa_axum::router::OpenApiRouter;

pub fn api_router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .nest("/ws", ws::router())
        .nest("/chats", chats::router())
        .nest("/threads", threads::router())
        .nest("/group", groups::router())
        .nest("/invites", invites::router())
        .nest("/push", push::router())
        .nest("/external", external::router())
        .nest("/service-tokens", service_tokens::router())
        .nest("/stickers", stickers::router())
        .nest("/users", users::router())
        .nest("/attachments", attachments::router())
}
