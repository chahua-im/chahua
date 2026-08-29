pub mod invites;
mod social;

use crate::AppState;
use utoipa_axum::router::OpenApiRouter;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .nest("/invites", invites::router())
        .nest("/social", social::router())
}
