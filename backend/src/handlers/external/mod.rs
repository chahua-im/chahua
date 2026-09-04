pub mod invites;
mod sessions;
mod social;

use crate::AppState;
use utoipa_axum::router::OpenApiRouter;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .nest("/invites", invites::router())
        .nest("/social", social::router())
        .nest("/sessions", sessions::router())
}
