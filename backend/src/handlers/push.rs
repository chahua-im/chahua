use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::push::{SubscriptionStatusResponse, VapidPublicKeyResponse};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::models::{
    ApnsSubscriptionData, NewPushSubscription, PushEnvironment, PushProvider,
    WebPushSubscriptionData,
};
use crate::schema::push_subscriptions;
use crate::utils::auth::{ClientId, CurrentUid};
use crate::utils::ids;
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
    Json(VapidPublicKeyResponse {
        public_key: state.push_service.vapid_public_key.clone(),
    })
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ApiPushProvider {
    #[default]
    WebPush,
    Apns,
}

impl From<ApiPushProvider> for PushProvider {
    fn from(value: ApiPushProvider) -> Self {
        match value {
            ApiPushProvider::WebPush => PushProvider::WebPush,
            ApiPushProvider::Apns => PushProvider::Apns,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeBody {
    #[serde(default)]
    pub provider: ApiPushProvider,
    pub endpoint: Option<String>,
    pub keys: Option<SubscribeKeys>,
    pub device_token: Option<String>,
    pub environment: Option<PushEnvironment>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct SubscribeKeys {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, Clone)]
struct ValidatedSubscription {
    provider: PushProvider,
    endpoint: Option<String>,
    device_token: Option<String>,
    apns_environment: Option<PushEnvironment>,
    provider_data: serde_json::Value,
}

impl SubscribeBody {
    fn validate(&self) -> Result<ValidatedSubscription, AppError> {
        match self.provider {
            ApiPushProvider::WebPush => {
                let endpoint = self
                    .endpoint
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or(AppError::BadRequest("endpoint is required for web push"))?;
                let keys = self
                    .keys
                    .clone()
                    .ok_or(AppError::BadRequest("keys are required for web push"))?;

                Ok(ValidatedSubscription {
                    provider: PushProvider::WebPush,
                    endpoint: Some(endpoint),
                    device_token: None,
                    apns_environment: None,
                    provider_data: serde_json::to_value(WebPushSubscriptionData {
                        p256dh: keys.p256dh,
                        auth: keys.auth,
                    })
                    .map_err(|_| AppError::Internal("failed to serialize web push data"))?,
                })
            }
            ApiPushProvider::Apns => {
                let device_token = self
                    .device_token
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or(AppError::BadRequest("deviceToken is required for apns"))?;
                let environment = self
                    .environment
                    .ok_or(AppError::BadRequest("environment is required for apns"))?;

                Ok(ValidatedSubscription {
                    provider: PushProvider::Apns,
                    endpoint: None,
                    device_token: Some(device_token),
                    apns_environment: Some(environment),
                    provider_data: serde_json::to_value(ApnsSubscriptionData { environment })
                        .map_err(|_| AppError::Internal("failed to serialize APNs data"))?,
                })
            }
        }
    }
}

#[utoipa::path(
    post,
    path = "/subscribe",
    tag = "push",
    request_body = SubscribeBody,
    responses(
        (status = 201, description = "Subscribed")
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn post_subscribe(
    CurrentUid(uid): CurrentUid,
    ClientId(client_id): ClientId,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<SubscribeBody>,
) -> Result<impl IntoResponse, AppError> {
    let conn = &mut *conn;
    let validated = body.validate()?;

    if !state.push_service.supports_provider(&validated.provider) {
        return Err(AppError::BadRequest(
            "the requested push provider is not configured",
        ));
    }

    let sub_id = ids::next_message_id(state.id_gen.as_ref())
        .await
        .map_err(|_| AppError::Internal("ID generation failed"))?;

    let new_sub = NewPushSubscription {
        id: sub_id,
        user_id: uid,
        provider: validated.provider,
        endpoint: validated.endpoint.clone(),
        device_token: validated.device_token.clone(),
        apns_environment: validated.apns_environment,
        provider_data: validated.provider_data.clone(),
        created_at: Utc::now().naive_utc(),
        client_id: Some(client_id.clone()),
        delivery_failure_count: 0,
        last_delivery_error: None,
        last_delivery_error_at: None,
    };

    conn.transaction::<_, diesel::result::Error, _>(|conn| {
        let provider = new_sub.provider;
        let endpoint = new_sub.endpoint.clone();
        let device_token = new_sub.device_token.clone();
        let apns_environment = new_sub.apns_environment;
        let provider_data = new_sub.provider_data.clone();
        let created_at = new_sub.created_at;
        let current_client_id = new_sub.client_id.clone();

        let mut replace_scope = push_subscriptions::table
            .filter(push_subscriptions::dsl::user_id.eq(uid))
            .filter(push_subscriptions::dsl::client_id.eq(current_client_id.clone()))
            .filter(push_subscriptions::dsl::provider.eq(provider))
            .into_boxed();

        match provider {
            PushProvider::WebPush => {
                if let Some(endpoint) = &endpoint {
                    replace_scope = replace_scope
                        .filter(push_subscriptions::dsl::endpoint.ne(Some(endpoint.clone())));
                }
            }
            PushProvider::Apns => {
                if let Some(device_token) = &device_token {
                    replace_scope = replace_scope
                        .filter(push_subscriptions::dsl::apns_environment.eq(apns_environment))
                        .filter(
                            push_subscriptions::dsl::device_token.ne(Some(device_token.clone())),
                        );
                }
            }
        }

        let replace_ids = replace_scope
            .select(push_subscriptions::dsl::id)
            .load::<i64>(conn)?;
        if !replace_ids.is_empty() {
            diesel::delete(
                push_subscriptions::table.filter(push_subscriptions::dsl::id.eq_any(&replace_ids)),
            )
            .execute(conn)?;
        }

        let existing_id = match provider {
            PushProvider::WebPush => push_subscriptions::table
                .filter(push_subscriptions::dsl::user_id.eq(uid))
                .filter(push_subscriptions::dsl::provider.eq(provider))
                .filter(push_subscriptions::dsl::endpoint.eq(endpoint.clone()))
                .select(push_subscriptions::dsl::id)
                .first::<i64>(conn)
                .optional()?,
            PushProvider::Apns => None,
        };

        if let Some(existing_id) = existing_id {
            diesel::update(push_subscriptions::table.find(existing_id))
                .set((
                    push_subscriptions::client_id.eq(&current_client_id),
                    push_subscriptions::created_at.eq(created_at),
                    push_subscriptions::provider_data.eq(&provider_data),
                    push_subscriptions::delivery_failure_count.eq(0),
                    push_subscriptions::last_delivery_error.eq::<Option<String>>(None),
                    push_subscriptions::last_delivery_error_at
                        .eq::<Option<chrono::DateTime<chrono::Utc>>>(None),
                ))
                .execute(conn)?;
        } else {
            match provider {
                PushProvider::WebPush => {
                    diesel::insert_into(push_subscriptions::table)
                        .values(&new_sub)
                        .execute(conn)?;
                }
                PushProvider::Apns => {
                    diesel::insert_into(push_subscriptions::table)
                        .values(&new_sub)
                        .on_conflict((
                            push_subscriptions::provider,
                            push_subscriptions::device_token,
                            push_subscriptions::apns_environment,
                        ))
                        .do_update()
                        .set((
                            push_subscriptions::user_id.eq(uid),
                            push_subscriptions::client_id.eq(&current_client_id),
                            push_subscriptions::created_at.eq(created_at),
                            push_subscriptions::provider_data.eq(&provider_data),
                            push_subscriptions::delivery_failure_count.eq(0),
                            push_subscriptions::last_delivery_error.eq::<Option<String>>(None),
                            push_subscriptions::last_delivery_error_at.eq::<Option<
                                chrono::DateTime<chrono::Utc>,
                            >>(
                                None
                            ),
                        ))
                        .execute(conn)?;
                }
            }
        }

        Ok(())
    })?;

    Ok(StatusCode::CREATED)
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UnsubscribeBody {
    #[serde(default)]
    pub provider: ApiPushProvider,
    pub endpoint: Option<String>,
    pub device_token: Option<String>,
    pub environment: Option<PushEnvironment>,
}

#[utoipa::path(
    post,
    path = "/unsubscribe",
    tag = "push",
    request_body = UnsubscribeBody,
    responses(
        (status = 200, description = "Unsubscribed")
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn post_unsubscribe(
    CurrentUid(uid): CurrentUid,
    ClientId(client_id): ClientId,
    mut conn: DbConn,
    Json(body): Json<UnsubscribeBody>,
) -> Result<impl IntoResponse, AppError> {
    let conn = &mut *conn;
    let provider: PushProvider = body.provider.into();
    let mut query = push_subscriptions::table
        .filter(push_subscriptions::dsl::user_id.eq(uid))
        .filter(push_subscriptions::dsl::client_id.eq(Some(client_id)))
        .filter(push_subscriptions::dsl::provider.eq(provider))
        .into_boxed();

    match provider {
        PushProvider::WebPush => {
            let endpoint = body.endpoint.ok_or(AppError::BadRequest(
                "endpoint is required for web push unsubscribe",
            ))?;
            query = query.filter(push_subscriptions::dsl::endpoint.eq(Some(endpoint)));
        }
        PushProvider::Apns => {
            let device_token = body.device_token.ok_or(AppError::BadRequest(
                "deviceToken is required for apns unsubscribe",
            ))?;
            let environment = body.environment.ok_or(AppError::BadRequest(
                "environment is required for apns unsubscribe",
            ))?;
            query = query
                .filter(push_subscriptions::dsl::device_token.eq(Some(device_token)))
                .filter(push_subscriptions::dsl::apns_environment.eq(Some(environment)));
        }
    }

    let delete_ids = query
        .select(push_subscriptions::dsl::id)
        .load::<i64>(conn)?;
    if !delete_ids.is_empty() {
        diesel::delete(
            push_subscriptions::table.filter(push_subscriptions::dsl::id.eq_any(&delete_ids)),
        )
        .execute(conn)?;
    }

    Ok(StatusCode::OK)
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionStatusQuery {
    #[serde(default)]
    pub provider: ApiPushProvider,
    pub endpoint: Option<String>,
    pub device_token: Option<String>,
    pub environment: Option<PushEnvironment>,
}

#[utoipa::path(
    get,
    path = "/subscription-status",
    tag = "push",
    params(SubscriptionStatusQuery),
    responses(
        (status = 200, description = "Subscription status", body = SubscriptionStatusResponse)
    ),
    security(("uid_header" = []), ("bearer_jwt" = []))
)]
async fn get_subscription_status(
    CurrentUid(uid): CurrentUid,
    ClientId(client_id): ClientId,
    mut conn: DbConn,
    Query(query): Query<SubscriptionStatusQuery>,
) -> Result<Json<SubscriptionStatusResponse>, AppError> {
    let conn = &mut *conn;
    let provider: PushProvider = query.provider.into();

    let has_active_subscription = diesel::select(diesel::dsl::exists(
        push_subscriptions::table
            .filter(push_subscriptions::dsl::user_id.eq(uid))
            .filter(push_subscriptions::dsl::client_id.eq(Some(client_id.clone())))
            .filter(push_subscriptions::dsl::provider.eq(provider)),
    ))
    .get_result::<bool>(conn)?;

    let has_matching_subscription = match provider {
        PushProvider::WebPush => query
            .endpoint
            .as_ref()
            .map(|endpoint| {
                diesel::select(diesel::dsl::exists(
                    push_subscriptions::table
                        .filter(push_subscriptions::dsl::user_id.eq(uid))
                        .filter(push_subscriptions::dsl::client_id.eq(Some(client_id.clone())))
                        .filter(push_subscriptions::dsl::provider.eq(provider))
                        .filter(push_subscriptions::dsl::endpoint.eq(Some(endpoint.clone()))),
                ))
                .get_result::<bool>(conn)
            })
            .transpose()?,
        PushProvider::Apns => match (&query.device_token, query.environment) {
            (Some(device_token), Some(environment)) => Some(
                diesel::select(diesel::dsl::exists(
                    push_subscriptions::table
                        .filter(push_subscriptions::dsl::user_id.eq(uid))
                        .filter(push_subscriptions::dsl::client_id.eq(Some(client_id.clone())))
                        .filter(push_subscriptions::dsl::provider.eq(provider))
                        .filter(
                            push_subscriptions::dsl::device_token.eq(Some(device_token.clone())),
                        )
                        .filter(push_subscriptions::dsl::apns_environment.eq(Some(environment))),
                ))
                .get_result::<bool>(conn)?,
            ),
            _ => None,
        },
    };

    Ok(Json(SubscriptionStatusResponse {
        has_active_subscription,
        has_matching_subscription,
        has_matching_endpoint: matches!(provider, PushProvider::WebPush)
            .then_some(has_matching_subscription)
            .flatten(),
    }))
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(routes!(get_vapid_public_key))
        .routes(routes!(get_subscription_status))
        .routes(routes!(post_subscribe))
        .routes(routes!(post_unsubscribe))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscribe_defaults_missing_provider_to_web_push() {
        let parsed: SubscribeBody = serde_json::from_str(
            r#"{"endpoint":"https://example.com/push","keys":{"p256dh":"abc","auth":"def"}}"#,
        )
        .expect("parse web push body");

        assert_eq!(parsed.provider, ApiPushProvider::WebPush);
    }

    #[test]
    fn subscribe_validates_apns_payload() {
        let body: SubscribeBody = serde_json::from_str(
            r#"{"provider":"apns","deviceToken":"token-123","environment":"sandbox"}"#,
        )
        .expect("parse APNs body");

        let validated = body.validate().expect("validate APNs body");
        assert_eq!(validated.provider, PushProvider::Apns);
        assert_eq!(validated.device_token.as_deref(), Some("token-123"));
        assert_eq!(validated.apns_environment, Some(PushEnvironment::Sandbox));
    }

    #[test]
    fn subscribe_rejects_missing_web_keys() {
        let body: SubscribeBody =
            serde_json::from_str(r#"{"endpoint":"https://example.com/push"}"#)
                .expect("parse malformed body");

        assert!(matches!(
            body.validate(),
            Err(AppError::BadRequest("keys are required for web push"))
        ));
    }
}
