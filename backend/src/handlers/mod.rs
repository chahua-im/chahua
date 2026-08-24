pub mod attachments;
pub mod auth;
pub mod blocks;
pub mod chats;
pub mod external;
pub mod friends;
pub mod groups;
pub mod invites;
pub mod members;
pub mod pins;
pub mod push;
mod saved_messages;
pub mod service_tokens;
pub mod stickers;
pub mod threads;
pub mod users;
pub mod ws;

use crate::AppState;
use utoipa_axum::router::OpenApiRouter;

pub fn api_router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .nest("/auth", auth::router())
        .nest("/ws", ws::router())
        .nest("/chats", chats::router())
        .nest("/threads", threads::router())
        .nest("/group", groups::router())
        .nest("/invites", invites::router())
        .nest("/push", push::router())
        .nest("/saved-messages", saved_messages::router())
        .nest("/external", external::router())
        .nest("/service-tokens", service_tokens::router())
        .nest("/stickers", stickers::router())
        .nest("/users", users::router())
        .nest("/attachments", attachments::router())
        .nest("/friends", friends::router())
        .nest("/blocks", blocks::router())
}
