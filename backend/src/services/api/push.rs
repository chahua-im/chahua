use chrono::Utc;
use diesel::PgConnection;

use crate::dto::push::{
    ApiPushProvider, SubscribeBody, SubscriptionStatusQuery, SubscriptionStatusResponse,
    UnsubscribeBody, VapidPublicKeyResponse,
};
use crate::errors::AppError;
use crate::models::{NewPushSubscription, PushProvider, WebPushSubscriptionData};
use crate::services::push::{
    subscriptions::{self, SubscriptionIdentity},
    PushService,
};
use crate::utils::ids::{self, IdGen};

#[derive(Debug, Clone)]
struct ValidatedSubscription {
    provider: PushProvider,
    scope: String,
    target: String,
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
                    scope: String::new(),
                    target: endpoint,
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
                    scope: environment.as_scope().to_owned(),
                    target: device_token,
                    provider_data: serde_json::json!({}),
                })
            }
            ApiPushProvider::Fcm => {
                let device_token = self
                    .device_token
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or(AppError::BadRequest("deviceToken is required for fcm"))?;

                Ok(ValidatedSubscription {
                    provider: PushProvider::Fcm,
                    scope: String::new(),
                    target: device_token,
                    provider_data: serde_json::json!({}),
                })
            }
        }
    }
}

pub fn get_vapid_public_key(
    push_service: &PushService,
) -> Result<VapidPublicKeyResponse, AppError> {
    let public_key = push_service
        .vapid_public_key()
        .ok_or(AppError::ServiceUnavailable("web push is not configured"))?;
    Ok(VapidPublicKeyResponse {
        public_key: public_key.to_owned(),
    })
}

pub async fn post_subscribe(
    uid: i32,
    client_id: String,
    body: SubscribeBody,
    conn: &mut PgConnection,
    push_service: &PushService,
    id_gen: &IdGen,
) -> Result<(), AppError> {
    let validated = body.validate()?;

    if !push_service.supports_provider(&validated.provider) {
        return Err(AppError::BadRequest(
            "the requested push provider is not configured",
        ));
    }

    let sub_id = ids::next_message_id(id_gen)
        .await
        .map_err(|_| AppError::Internal("ID generation failed"))?;

    let new_sub = NewPushSubscription {
        id: sub_id,
        user_id: uid,
        provider: validated.provider,
        scope: validated.scope,
        target: validated.target,
        provider_data: validated.provider_data,
        created_at: Utc::now().naive_utc(),
        client_id,
        delivery_failure_count: 0,
        last_delivery_error: None,
        last_delivery_error_at: None,
    };

    subscriptions::upsert(conn, &new_sub)?;
    Ok(())
}

pub fn post_unsubscribe(
    uid: i32,
    client_id: String,
    body: UnsubscribeBody,
    conn: &mut PgConnection,
) -> Result<(), AppError> {
    let identity = match body.provider {
        ApiPushProvider::WebPush => SubscriptionIdentity::WebPush(body.endpoint.as_deref().ok_or(
            AppError::BadRequest("endpoint is required for web push unsubscribe"),
        )?),
        ApiPushProvider::Apns => SubscriptionIdentity::Apns {
            device_token: body.device_token.as_deref().ok_or(AppError::BadRequest(
                "deviceToken is required for apns unsubscribe",
            ))?,
            environment: body.environment.ok_or(AppError::BadRequest(
                "environment is required for apns unsubscribe",
            ))?,
        },
        ApiPushProvider::Fcm => SubscriptionIdentity::Fcm(body.device_token.as_deref().ok_or(
            AppError::BadRequest("deviceToken is required for fcm unsubscribe"),
        )?),
    };
    subscriptions::unsubscribe(conn, uid, &client_id, &identity)?;
    Ok(())
}

pub fn get_subscription_status(
    uid: i32,
    client_id: String,
    query: SubscriptionStatusQuery,
    conn: &mut PgConnection,
) -> Result<SubscriptionStatusResponse, AppError> {
    let provider: PushProvider = query.provider.into();

    let identity = match provider {
        PushProvider::WebPush => query.endpoint.as_deref().map(SubscriptionIdentity::WebPush),
        PushProvider::Apns => match (query.device_token.as_deref(), query.environment) {
            (Some(device_token), Some(environment)) => Some(SubscriptionIdentity::Apns {
                device_token,
                environment,
            }),
            _ => None,
        },
        PushProvider::Fcm => query.device_token.as_deref().map(SubscriptionIdentity::Fcm),
    };
    let (has_active_subscription, has_matching_subscription) =
        subscriptions::status(conn, uid, &client_id, provider, identity.as_ref())?;

    Ok(SubscriptionStatusResponse {
        has_active_subscription,
        has_matching_subscription,
        has_matching_endpoint: matches!(provider, PushProvider::WebPush)
            .then_some(has_matching_subscription)
            .flatten(),
    })
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
        assert_eq!(validated.scope, "sandbox");
        assert_eq!(validated.target, "token-123");
        assert_eq!(validated.provider_data, serde_json::json!({}));
    }

    #[test]
    fn subscribe_validates_fcm_payload_without_environment() {
        let body: SubscribeBody =
            serde_json::from_str(r#"{"provider":"fcm","deviceToken":"fcm-token-123"}"#)
                .expect("parse FCM body");

        let validated = body.validate().expect("validate FCM body");
        assert_eq!(validated.provider, PushProvider::Fcm);
        assert_eq!(validated.scope, "");
        assert_eq!(validated.target, "fcm-token-123");
        assert_eq!(validated.provider_data, serde_json::json!({}));
    }

    #[test]
    fn subscribe_rejects_missing_fcm_device_token() {
        let body: SubscribeBody = serde_json::from_str(r#"{"provider":"fcm","deviceToken":"  "}"#)
            .expect("parse malformed FCM body");

        assert!(matches!(
            body.validate(),
            Err(AppError::BadRequest("deviceToken is required for fcm"))
        ));
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
