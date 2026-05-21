use a2::{
    request::payload::PayloadLike, Client as ApnsClient, ClientConfig as ApnsClientConfig,
    DefaultNotificationBuilder, Endpoint as ApnsEndpoint, ErrorReason as ApnsErrorReason,
    NotificationBuilder, NotificationOptions, Priority as ApnsPriority, PushType as ApnsPushType,
};
use std::fs::File;
use tracing::{error, warn};
use web_push::WebPushClient;

use crate::models::{PushEnvironment, PushProvider, PushSubscription};

use super::payload::ApnsNotification;
use super::PushService;

const APNS_CUSTOM_DATA_ROOT: &str = "wettyChat";

#[derive(Debug)]
struct PayloadWithThreadId<'a> {
    inner: a2::request::payload::Payload<'a>,
    thread_id: String,
}

impl serde::Serialize for PayloadWithThreadId<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::Error as _;
        let mut value = serde_json::to_value(&self.inner).map_err(S::Error::custom)?;
        if let Some(aps) = value
            .as_object_mut()
            .and_then(|o| o.get_mut("aps"))
            .and_then(|v| v.as_object_mut())
        {
            aps.insert(
                "thread-id".to_string(),
                serde_json::Value::String(self.thread_id.clone()),
            );
        }
        value.serialize(serializer)
    }
}

impl PayloadLike for PayloadWithThreadId<'_> {
    fn get_device_token(&self) -> &str {
        self.inner.get_device_token()
    }
    fn get_options(&self) -> &NotificationOptions<'_> {
        self.inner.get_options()
    }
}

#[derive(Debug, Clone)]
pub(super) struct ApnsSender {
    sandbox_client: ApnsClient,
    production_client: ApnsClient,
    topic: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DeliveryFailureAction {
    None,
    Counted,
    PruneImmediate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DeliveryFailureClass {
    InvalidSubscription,
    ProviderRejected,
    ProviderTransient,
    BackendConfig,
    PayloadBuild,
}

impl DeliveryFailureClass {
    pub(super) fn as_metrics_label(self) -> &'static str {
        match self {
            Self::InvalidSubscription => "invalid_subscription",
            Self::ProviderRejected => "provider_rejected",
            Self::ProviderTransient => "provider_transient",
            Self::BackendConfig => "backend_config",
            Self::PayloadBuild => "payload_build",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DeliveryFailureDetails {
    pub(super) class: DeliveryFailureClass,
    pub(super) reason: String,
    pub(super) action: DeliveryFailureAction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DeliveryFailure {
    pub(super) subscription_id: i64,
    pub(super) user_id: i32,
    pub(super) provider: PushProvider,
    pub(super) class: DeliveryFailureClass,
    pub(super) reason: String,
    pub(super) action: DeliveryFailureAction,
}

impl DeliveryFailure {
    fn from_details(sub: &PushSubscription, details: DeliveryFailureDetails) -> Self {
        Self {
            subscription_id: sub.id,
            user_id: sub.user_id,
            provider: sub.provider,
            class: details.class,
            reason: details.reason,
            action: details.action,
        }
    }
}

impl PushService {
    pub(super) async fn send_to_subscription(
        &self,
        sub: &PushSubscription,
        web_payload: &[u8],
        apns_notification: &ApnsNotification,
    ) -> Result<(), DeliveryFailure> {
        match sub.provider {
            PushProvider::WebPush => self.send_web_push(sub, web_payload).await,
            PushProvider::Apns => self.send_apns_push(sub, apns_notification).await,
        }
    }

    async fn send_web_push(
        &self,
        sub: &PushSubscription,
        payload: &[u8],
    ) -> Result<(), DeliveryFailure> {
        let endpoint = match &sub.endpoint {
            Some(endpoint) => endpoint.clone(),
            None => {
                self.metrics
                    .record_push_notification(PushProvider::WebPush.as_metrics_label(), false);
                return Err(DeliveryFailure::from_details(
                    sub,
                    DeliveryFailureDetails {
                        class: DeliveryFailureClass::InvalidSubscription,
                        reason: "missing_endpoint".to_string(),
                        action: DeliveryFailureAction::PruneImmediate,
                    },
                ));
            }
        };
        let data = match sub.web_push_data() {
            Ok(data) => data,
            Err(e) => {
                self.metrics
                    .record_push_notification(PushProvider::WebPush.as_metrics_label(), false);
                warn!(
                    "web push subscription {} has invalid provider data: {:?}",
                    sub.id, e
                );
                return Err(DeliveryFailure::from_details(
                    sub,
                    DeliveryFailureDetails {
                        class: DeliveryFailureClass::InvalidSubscription,
                        reason: "invalid_provider_data".to_string(),
                        action: DeliveryFailureAction::PruneImmediate,
                    },
                ));
            }
        };

        let subscription_info =
            web_push::SubscriptionInfo::new(endpoint.clone(), data.p256dh, data.auth);

        let sig_builder =
            match web_push::VapidSignatureBuilder::from_base64_no_sub(&self.vapid_private_key) {
                Ok(b) => b,
                Err(e) => {
                    error!(
                        "Vapid config error (should have been caught on startup): {:?}",
                        e
                    );
                    self.metrics
                        .record_push_notification(PushProvider::WebPush.as_metrics_label(), false);
                    return Err(DeliveryFailure::from_details(
                        sub,
                        DeliveryFailureDetails {
                            class: DeliveryFailureClass::BackendConfig,
                            reason: "vapid_config".to_string(),
                            action: DeliveryFailureAction::None,
                        },
                    ));
                }
            };

        let mut b = sig_builder.add_sub_info(&subscription_info);
        b.add_claim("sub", self.vapid_subject.clone());
        let signature = match b.build() {
            Ok(sig) => sig,
            Err(e) => {
                error!("Failed to build VAPID signature: {:?}", e);
                self.metrics
                    .record_push_notification(PushProvider::WebPush.as_metrics_label(), false);
                return Err(DeliveryFailure::from_details(
                    sub,
                    DeliveryFailureDetails {
                        class: DeliveryFailureClass::BackendConfig,
                        reason: "vapid_signature".to_string(),
                        action: DeliveryFailureAction::None,
                    },
                ));
            }
        };

        let mut builder = web_push::WebPushMessageBuilder::new(&subscription_info);
        builder.set_payload(web_push::ContentEncoding::Aes128Gcm, payload);
        builder.set_vapid_signature(signature);

        match builder.build() {
            Ok(message) => match self.client.send(message).await {
                Ok(_) => {
                    self.metrics
                        .record_push_notification(PushProvider::WebPush.as_metrics_label(), true);
                    Ok(())
                }
                Err(e) => {
                    self.metrics
                        .record_push_notification(PushProvider::WebPush.as_metrics_label(), false);
                    let details = classify_web_push_error(&e);
                    if details.action == DeliveryFailureAction::PruneImmediate {
                        warn!(
                            provider = PushProvider::WebPush.as_metrics_label(),
                            subscription_id = sub.id,
                            user_id = sub.user_id,
                            reason = %details.reason,
                            action = "prune",
                            "stale web push subscription"
                        );
                    } else {
                        error!(
                            provider = PushProvider::WebPush.as_metrics_label(),
                            subscription_id = sub.id,
                            user_id = sub.user_id,
                            failure_class = details.class.as_metrics_label(),
                            reason = %details.reason,
                            action = "retry",
                            "failed to send web push notification"
                        );
                    }
                    Err(DeliveryFailure::from_details(sub, details))
                }
            },
            Err(e) => {
                error!("Failed to build web push message: {:?}", e);
                self.metrics
                    .record_push_notification(PushProvider::WebPush.as_metrics_label(), false);
                Err(DeliveryFailure::from_details(
                    sub,
                    DeliveryFailureDetails {
                        class: DeliveryFailureClass::PayloadBuild,
                        reason: "message_build".to_string(),
                        action: DeliveryFailureAction::None,
                    },
                ))
            }
        }
    }

    async fn send_apns_push(
        &self,
        sub: &PushSubscription,
        notification: &ApnsNotification,
    ) -> Result<(), DeliveryFailure> {
        let sender = match &self.apns_sender {
            Some(sender) => sender,
            None => {
                warn!(
                    "received APNs subscription {} without APNs sender configured",
                    sub.id
                );
                self.metrics
                    .record_push_notification(PushProvider::Apns.as_metrics_label(), false);
                return Err(DeliveryFailure::from_details(
                    sub,
                    DeliveryFailureDetails {
                        class: DeliveryFailureClass::BackendConfig,
                        reason: "apns_not_configured".to_string(),
                        action: DeliveryFailureAction::None,
                    },
                ));
            }
        };
        let device_token = match &sub.device_token {
            Some(token) => token.as_str(),
            None => {
                warn!("APNs subscription {} missing device token", sub.id);
                self.metrics
                    .record_push_notification(PushProvider::Apns.as_metrics_label(), false);
                return Err(DeliveryFailure::from_details(
                    sub,
                    DeliveryFailureDetails {
                        class: DeliveryFailureClass::InvalidSubscription,
                        reason: "missing_device_token".to_string(),
                        action: DeliveryFailureAction::PruneImmediate,
                    },
                ));
            }
        };
        if let Err(e) = sub.apns_data() {
            warn!(
                "APNs subscription {} has invalid provider data: {:?}",
                sub.id, e
            );
            self.metrics
                .record_push_notification(PushProvider::Apns.as_metrics_label(), false);
            return Err(DeliveryFailure::from_details(
                sub,
                DeliveryFailureDetails {
                    class: DeliveryFailureClass::InvalidSubscription,
                    reason: "invalid_provider_data".to_string(),
                    action: DeliveryFailureAction::PruneImmediate,
                },
            ));
        }
        let environment = match sub.apns_environment {
            Some(environment) => environment,
            None => {
                warn!("APNs subscription {} missing environment", sub.id);
                self.metrics
                    .record_push_notification(PushProvider::Apns.as_metrics_label(), false);
                return Err(DeliveryFailure::from_details(
                    sub,
                    DeliveryFailureDetails {
                        class: DeliveryFailureClass::InvalidSubscription,
                        reason: "missing_environment".to_string(),
                        action: DeliveryFailureAction::PruneImmediate,
                    },
                ));
            }
        };

        match sender.send(device_token, &environment, notification).await {
            Ok(()) => {
                self.metrics
                    .record_push_notification(PushProvider::Apns.as_metrics_label(), true);
                Ok(())
            }
            Err(details) if details.action == DeliveryFailureAction::PruneImmediate => {
                warn!(
                    provider = PushProvider::Apns.as_metrics_label(),
                    subscription_id = sub.id,
                    user_id = sub.user_id,
                    reason = %details.reason,
                    action = "prune",
                    "stale APNs subscription"
                );
                self.metrics
                    .record_push_notification(PushProvider::Apns.as_metrics_label(), false);
                Err(DeliveryFailure::from_details(sub, details))
            }
            Err(details) => {
                error!(
                    provider = PushProvider::Apns.as_metrics_label(),
                    subscription_id = sub.id,
                    user_id = sub.user_id,
                    failure_class = details.class.as_metrics_label(),
                    reason = %details.reason,
                    action = "retry",
                    "failed to send APNs notification"
                );
                self.metrics
                    .record_push_notification(PushProvider::Apns.as_metrics_label(), false);
                Err(DeliveryFailure::from_details(sub, details))
            }
        }
    }
}

impl ApnsSender {
    pub(super) fn from_env() -> Result<Option<Self>, String> {
        let key_id = std::env::var("APNS_KEY_ID").ok();
        let team_id = std::env::var("APNS_TEAM_ID").ok();
        let private_key_path = std::env::var("APNS_PRIVATE_KEY_PATH").ok();
        let topic = std::env::var("APNS_TOPIC").ok();

        if key_id.is_none() && team_id.is_none() && private_key_path.is_none() && topic.is_none() {
            return Ok(None);
        }

        let key_id = key_id.ok_or_else(|| "APNS_KEY_ID must be set".to_string())?;
        let team_id = team_id.ok_or_else(|| "APNS_TEAM_ID must be set".to_string())?;
        let private_key_path =
            private_key_path.ok_or_else(|| "APNS_PRIVATE_KEY_PATH must be set".to_string())?;
        let topic = topic.ok_or_else(|| "APNS_TOPIC must be set".to_string())?;

        let sandbox_client =
            Self::build_client(&private_key_path, &key_id, &team_id, ApnsEndpoint::Sandbox)?;
        let production_client = Self::build_client(
            &private_key_path,
            &key_id,
            &team_id,
            ApnsEndpoint::Production,
        )?;

        Ok(Some(Self {
            sandbox_client,
            production_client,
            topic,
        }))
    }

    fn build_client(
        private_key_path: &str,
        key_id: &str,
        team_id: &str,
        endpoint: ApnsEndpoint,
    ) -> Result<ApnsClient, String> {
        let mut file = File::open(private_key_path)
            .map_err(|e| format!("failed to open APNS private key: {:?}", e))?;
        let config = ApnsClientConfig {
            endpoint,
            ..Default::default()
        };
        ApnsClient::token(&mut file, key_id, team_id, config)
            .map_err(|e| format!("failed to initialize APNS client: {:?}", e))
    }

    async fn send(
        &self,
        device_token: &str,
        environment: &PushEnvironment,
        notification: &ApnsNotification,
    ) -> Result<(), DeliveryFailureDetails> {
        let title_loc_args = [notification.title_loc_args[0].as_str()];
        let body_loc_args: Vec<&str> = notification
            .body_loc_args
            .iter()
            .map(String::as_str)
            .collect();
        let builder = DefaultNotificationBuilder::new()
            .set_title_loc_key(notification.title_loc_key)
            .set_title_loc_args(&title_loc_args)
            .set_loc_key(notification.body_loc_key)
            .set_loc_args(&body_loc_args)
            .set_badge(notification.badge)
            .set_sound("default");
        let options = NotificationOptions {
            apns_push_type: Some(ApnsPushType::Alert),
            apns_priority: Some(ApnsPriority::High),
            apns_topic: Some(self.topic.as_str()),
            ..Default::default()
        };

        let mut inner_payload = builder.build(device_token, options);
        inner_payload
            .add_custom_data(APNS_CUSTOM_DATA_ROOT, &notification.custom_data)
            .map_err(|e| DeliveryFailureDetails {
                class: DeliveryFailureClass::PayloadBuild,
                reason: format!("payload_serialize: {:?}", e),
                action: DeliveryFailureAction::None,
            })?;
        let payload = PayloadWithThreadId {
            inner: inner_payload,
            thread_id: notification.thread_id.clone(),
        };

        let client = match environment {
            PushEnvironment::Sandbox => &self.sandbox_client,
            PushEnvironment::Production => &self.production_client,
        };
        let response = client
            .send(payload)
            .await
            .map_err(|e| classify_apns_send_error(&e))?;

        if response.code == 200 {
            Ok(())
        } else if let Some(error) = response.error {
            if is_stale_apns_error_reason(&error.reason) {
                Err(stale_apns_failure(&error.reason))
            } else {
                Err(DeliveryFailureDetails {
                    class: DeliveryFailureClass::ProviderTransient,
                    reason: format!("{:?}", error.reason),
                    action: DeliveryFailureAction::None,
                })
            }
        } else {
            Err(DeliveryFailureDetails {
                class: DeliveryFailureClass::ProviderTransient,
                reason: format!("status_{}", response.code),
                action: DeliveryFailureAction::None,
            })
        }
    }
}

pub(super) fn classify_web_push_error(error: &web_push::WebPushError) -> DeliveryFailureDetails {
    match error {
        web_push::WebPushError::EndpointNotValid(_) => DeliveryFailureDetails {
            class: DeliveryFailureClass::ProviderRejected,
            reason: "endpoint_not_valid".to_string(),
            action: DeliveryFailureAction::PruneImmediate,
        },
        web_push::WebPushError::EndpointNotFound(_) => DeliveryFailureDetails {
            class: DeliveryFailureClass::ProviderRejected,
            reason: "endpoint_not_found".to_string(),
            action: DeliveryFailureAction::PruneImmediate,
        },
        web_push::WebPushError::Unspecified => DeliveryFailureDetails {
            class: DeliveryFailureClass::ProviderTransient,
            reason: "unspecified".to_string(),
            action: DeliveryFailureAction::Counted,
        },
        other => DeliveryFailureDetails {
            class: DeliveryFailureClass::ProviderTransient,
            reason: other.short_description().to_string(),
            action: DeliveryFailureAction::None,
        },
    }
}

pub(super) fn classify_apns_send_error(error: &a2::Error) -> DeliveryFailureDetails {
    match error {
        a2::Error::ResponseError(response) => match &response.error {
            Some(body) if is_stale_apns_error_reason(&body.reason) => {
                stale_apns_failure(&body.reason)
            }
            Some(body) => DeliveryFailureDetails {
                class: DeliveryFailureClass::ProviderTransient,
                reason: format!("{:?}", body.reason),
                action: DeliveryFailureAction::None,
            },
            None => DeliveryFailureDetails {
                class: DeliveryFailureClass::ProviderTransient,
                reason: format!("status_{}", response.code),
                action: DeliveryFailureAction::None,
            },
        },
        a2::Error::RequestTimeout(_) => DeliveryFailureDetails {
            class: DeliveryFailureClass::ProviderTransient,
            reason: "request_timeout".to_string(),
            action: DeliveryFailureAction::None,
        },
        a2::Error::SignerError(_) | a2::Error::InvalidOptions(_) => DeliveryFailureDetails {
            class: DeliveryFailureClass::BackendConfig,
            reason: "apns_config".to_string(),
            action: DeliveryFailureAction::None,
        },
        a2::Error::SerializeError(_) | a2::Error::BuildRequestError(_) => DeliveryFailureDetails {
            class: DeliveryFailureClass::PayloadBuild,
            reason: "apns_payload".to_string(),
            action: DeliveryFailureAction::None,
        },
        a2::Error::ConnectionError(_) | a2::Error::ClientError(_) => DeliveryFailureDetails {
            class: DeliveryFailureClass::ProviderTransient,
            reason: "connection".to_string(),
            action: DeliveryFailureAction::None,
        },
        a2::Error::ReadError(_) | a2::Error::Tls(_) | a2::Error::InvalidCertificate => {
            DeliveryFailureDetails {
                class: DeliveryFailureClass::BackendConfig,
                reason: "apns_config".to_string(),
                action: DeliveryFailureAction::None,
            }
        }
    }
}

fn stale_apns_failure(reason: &ApnsErrorReason) -> DeliveryFailureDetails {
    DeliveryFailureDetails {
        class: DeliveryFailureClass::ProviderRejected,
        reason: format!("{:?}", reason),
        action: DeliveryFailureAction::PruneImmediate,
    }
}

pub(super) fn is_stale_apns_error_reason(reason: &ApnsErrorReason) -> bool {
    matches!(
        reason,
        ApnsErrorReason::BadDeviceToken
            | ApnsErrorReason::DeviceTokenNotForTopic
            | ApnsErrorReason::Unregistered
    )
}
