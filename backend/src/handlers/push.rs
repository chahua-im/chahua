use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::push::{
    SubscribeBody, SubscriptionStatusQuery, SubscriptionStatusResponse, UnsubscribeBody,
    VapidPublicKeyResponse,
};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::services::api::push;
use crate::utils::auth::{ClientId, CurrentUid};
use crate::AppState;

#[utoipa::path(
    get,
    path = "/vapid-public-key",
    tag = "push",
    responses(
        (status = 200, description = "VAPID public key", body = VapidPublicKeyResponse)
    )
)]
async fn get_vapid_public_key(State(state): State<AppState>) -> Json<VapidPublicKeyResponse> {
    Json(push::get_vapid_public_key(state.push_service.as_ref()))
}

#[utoipa::path(
    post,
    path = "/subscribe",
    tag = "push",
    request_body = SubscribeBody,
    responses(
        (status = 201, description = "Subscribed")
    ),
    security(("bearer_jwt" = []))
)]
async fn post_subscribe(
    CurrentUid(uid): CurrentUid,
    ClientId(client_id): ClientId,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<SubscribeBody>,
) -> Result<impl IntoResponse, AppError> {
    push::post_subscribe(
        uid,
        client_id,
        body,
        &mut conn,
        state.push_service.as_ref(),
        state.id_gen.as_ref(),
    )
    .await?;
    Ok(StatusCode::CREATED)
}

#[utoipa::path(
    post,
    path = "/unsubscribe",
    tag = "push",
    request_body = UnsubscribeBody,
    responses(
        (status = 200, description = "Unsubscribed")
    ),
    security(("bearer_jwt" = []))
)]
async fn post_unsubscribe(
    CurrentUid(uid): CurrentUid,
    ClientId(client_id): ClientId,
    mut conn: DbConn,
    Json(body): Json<UnsubscribeBody>,
) -> Result<impl IntoResponse, AppError> {
    push::post_unsubscribe(uid, client_id, body, &mut conn)?;
    Ok(StatusCode::OK)
}

#[utoipa::path(
    get,
    path = "/subscription-status",
    tag = "push",
    params(SubscriptionStatusQuery),
    responses(
        (status = 200, description = "Subscription status", body = SubscriptionStatusResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn get_subscription_status(
    CurrentUid(uid): CurrentUid,
    ClientId(client_id): ClientId,
    mut conn: DbConn,
    Query(query): Query<SubscriptionStatusQuery>,
) -> Result<Json<SubscriptionStatusResponse>, AppError> {
    Ok(Json(push::get_subscription_status(
        uid, client_id, query, &mut conn,
    )?))
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(routes!(get_vapid_public_key))
        .routes(routes!(get_subscription_status))
        .routes(routes!(post_subscribe))
        .routes(routes!(post_unsubscribe))
}
