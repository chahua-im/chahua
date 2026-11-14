use a2::{
    request::payload::PayloadLike, Client as ApnsClient, ClientConfig as ApnsClientConfig,
    DefaultNotificationBuilder, Endpoint as ApnsEndpoint, ErrorReason as ApnsErrorReason,
    NotificationBuilder, NotificationOptions, Priority as ApnsPriority, PushType as ApnsPushType,
};
use serde::Deserialize;
use std::fs::File;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tracing::{error, warn};
use web_push::WebPushClient;

use crate::models::{PushEnvironment, PushProvider, PushSubscription};

use super::payload::{ApnsNotification, FcmData, FcmNotification};
use super::PushService;

const APNS_CUSTOM_DATA_ROOT: &str = "wettyChat";

const FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_DEFAULT_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const FCM_JWT_LIFETIME_SECS: i64 = 3600;
const FCM_ACCESS_TOKEN_REFRESH_MARGIN: Duration = Duration::from_secs(60);
const FCM_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const FCM_MESSAGE_TTL: &str = "86400s";

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

/// Firebase Cloud Messaging sender. Access tokens are minted from the service
/// account JSON with the OAuth2 JWT-bearer flow and cached until shortly before
/// they expire.
pub(super) struct FcmSender {
    http: reqwest::Client,
    project_id: String,
    service_account: FcmServiceAccount,
    cached_token: Mutex<Option<CachedFcmToken>>,
}

#[derive(Clone, Deserialize)]
struct FcmServiceAccount {
    client_email: String,
    private_key: String,
    #[serde(default)]
    token_uri: Option<String>,
}

impl std::fmt::Debug for FcmServiceAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never render the private key.
        f.debug_struct("FcmServiceAccount")
            .field("client_email", &self.client_email)
            .finish_non_exhaustive()
    }
}

struct CachedFcmToken {
    token: String,
    expires_at: Instant,
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
        fcm_notification: &FcmNotification,
    ) -> Result<(), DeliveryFailure> {
        match sub.provider {
            PushProvider::WebPush => self.send_web_push(sub, web_payload).await,
            PushProvider::Apns => self.send_apns_push(sub, apns_notification).await,
            PushProvider::Fcm => self.send_fcm_push(sub, fcm_notification).await,
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
                    .record_notification(PushProvider::WebPush.as_metrics_label(), false);
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
                    .record_notification(PushProvider::WebPush.as_metrics_label(), false);
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

        let sig_builder = match web_push::VapidSignatureBuilder::from_base64_no_sub(
            &self.config.vapid_private_key,
        ) {
            Ok(b) => b,
            Err(e) => {
                error!(
                    "Vapid config error (should have been caught on startup): {:?}",
                    e
                );
                self.metrics
                    .record_notification(PushProvider::WebPush.as_metrics_label(), false);
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
        b.add_claim("sub", self.config.vapid_subject.clone());
        let signature = match b.build() {
            Ok(sig) => sig,
            Err(e) => {
                error!("Failed to build VAPID signature: {:?}", e);
                self.metrics
                    .record_notification(PushProvider::WebPush.as_metrics_label(), false);
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
                        .record_notification(PushProvider::WebPush.as_metrics_label(), true);
                    Ok(())
                }
                Err(e) => {
                    self.metrics
                        .record_notification(PushProvider::WebPush.as_metrics_label(), false);
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
                    .record_notification(PushProvider::WebPush.as_metrics_label(), false);
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
                    .record_notification(PushProvider::Apns.as_metrics_label(), false);
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
                    .record_notification(PushProvider::Apns.as_metrics_label(), false);
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
                .record_notification(PushProvider::Apns.as_metrics_label(), false);
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
                    .record_notification(PushProvider::Apns.as_metrics_label(), false);
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
                    .record_notification(PushProvider::Apns.as_metrics_label(), true);
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
                    .record_notification(PushProvider::Apns.as_metrics_label(), false);
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
                    .record_notification(PushProvider::Apns.as_metrics_label(), false);
                Err(DeliveryFailure::from_details(sub, details))
            }
        }
    }

    async fn send_fcm_push(
        &self,
        sub: &PushSubscription,
        notification: &FcmNotification,
    ) -> Result<(), DeliveryFailure> {
        let sender = match &self.fcm_sender {
            Some(sender) => sender,
            None => {
                warn!(
                    "received FCM subscription {} without FCM sender configured",
                    sub.id
                );
                self.metrics
                    .record_notification(PushProvider::Fcm.as_metrics_label(), false);
                return Err(DeliveryFailure::from_details(
                    sub,
                    DeliveryFailureDetails {
                        class: DeliveryFailureClass::BackendConfig,
                        reason: "fcm_not_configured".to_string(),
                        action: DeliveryFailureAction::None,
                    },
                ));
            }
        };
        let device_token = match sub.device_token.as_deref().filter(|t| !t.trim().is_empty()) {
            Some(token) => token,
            None => {
                warn!("FCM subscription {} missing device token", sub.id);
                self.metrics
                    .record_notification(PushProvider::Fcm.as_metrics_label(), false);
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

        match sender.send(device_token, notification).await {
            Ok(()) => {
                self.metrics
                    .record_notification(PushProvider::Fcm.as_metrics_label(), true);
                Ok(())
            }
            Err(details) if details.action == DeliveryFailureAction::PruneImmediate => {
                warn!(
                    provider = PushProvider::Fcm.as_metrics_label(),
                    subscription_id = sub.id,
                    user_id = sub.user_id,
                    reason = %details.reason,
                    action = "prune",
                    "stale FCM subscription"
                );
                self.metrics
                    .record_notification(PushProvider::Fcm.as_metrics_label(), false);
                Err(DeliveryFailure::from_details(sub, details))
            }
            Err(details) => {
                error!(
                    provider = PushProvider::Fcm.as_metrics_label(),
                    subscription_id = sub.id,
                    user_id = sub.user_id,
                    failure_class = details.class.as_metrics_label(),
                    reason = %details.reason,
                    action = "retry",
                    "failed to send FCM notification"
                );
                self.metrics
                    .record_notification(PushProvider::Fcm.as_metrics_label(), false);
                Err(DeliveryFailure::from_details(sub, details))
            }
        }
    }
}

impl ApnsSender {
    pub(super) fn from_config(config: &crate::config::ApnsConfig) -> Result<Self, String> {
        let sandbox_client = Self::build_client(
            &config.private_key_path,
            &config.key_id,
            &config.team_id,
            ApnsEndpoint::Sandbox,
        )?;
        let production_client = Self::build_client(
            &config.private_key_path,
            &config.key_id,
            &config.team_id,
            ApnsEndpoint::Production,
        )?;

        Ok(Self {
            sandbox_client,
            production_client,
            topic: config.topic.clone(),
        })
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
            // Matches the Apple client's text-input Reply notification category.
            .set_category("chahua")
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

impl FcmSender {
    pub(super) fn from_config(config: &crate::config::FcmConfig) -> Result<Self, String> {
        let contents = std::fs::read_to_string(&config.service_account_path)
            .map_err(|e| format!("failed to read FCM service account file: {:?}", e))?;
        let service_account: FcmServiceAccount = serde_json::from_str(&contents)
            .map_err(|e| format!("invalid FCM service account JSON: {:?}", e))?;
        if service_account.client_email.trim().is_empty()
            || service_account.private_key.trim().is_empty()
        {
            return Err("FCM service account is missing client_email or private_key".to_string());
        }
        let http = reqwest::Client::builder()
            .timeout(FCM_REQUEST_TIMEOUT)
            .build()
            .map_err(|e| format!("failed to build FCM HTTP client: {:?}", e))?;
        Ok(Self {
            http,
            project_id: config.project_id.clone(),
            service_account,
            cached_token: Mutex::new(None),
        })
    }

    async fn send(
        &self,
        device_token: &str,
        notification: &FcmNotification,
    ) -> Result<(), DeliveryFailureDetails> {
        let access_token = self.access_token().await?;
        let url = format!(
            "https://fcm.googleapis.com/v1/projects/{}/messages:send",
            self.project_id
        );
        let body =
            build_fcm_message(device_token, notification).map_err(|e| DeliveryFailureDetails {
                class: DeliveryFailureClass::PayloadBuild,
                reason: format!("payload_serialize: {:?}", e),
                action: DeliveryFailureAction::None,
            })?;
        let response = self
            .http
            .post(url)
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {access_token}"),
            )
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|e| DeliveryFailureDetails {
                class: DeliveryFailureClass::ProviderTransient,
                reason: format!("request_failed: {:?}", e.without_url()),
                action: DeliveryFailureAction::None,
            })?;
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        if (200..300).contains(&status) {
            return Ok(());
        }
        Err(classify_fcm_error(status, &text))
    }

    async fn access_token(&self) -> Result<String, DeliveryFailureDetails> {
        let mut cached = self.cached_token.lock().await;
        if let Some(token) = cached.as_ref() {
            if Instant::now() < token.expires_at {
                return Ok(token.token.clone());
            }
        }
        let (token, lifetime) = self.request_access_token().await?;
        let ttl = lifetime
            .checked_sub(FCM_ACCESS_TOKEN_REFRESH_MARGIN)
            .unwrap_or(lifetime / 2);
        *cached = Some(CachedFcmToken {
            token: token.clone(),
            expires_at: Instant::now() + ttl,
        });
        Ok(token)
    }

    async fn request_access_token(&self) -> Result<(String, Duration), DeliveryFailureDetails> {
        let token_uri = self
            .service_account
            .token_uri
            .as_deref()
            .filter(|uri| !uri.trim().is_empty())
            .unwrap_or(FCM_DEFAULT_TOKEN_URI);
        let issued_at = chrono::Utc::now().timestamp();
        let claims = serde_json::json!({
            "iss": self.service_account.client_email,
            "scope": FCM_SCOPE,
            "aud": token_uri,
            "iat": issued_at,
            "exp": issued_at + FCM_JWT_LIFETIME_SECS,
        });
        let key =
            jsonwebtoken::EncodingKey::from_rsa_pem(self.service_account.private_key.as_bytes())
                .map_err(|e| DeliveryFailureDetails {
                    class: DeliveryFailureClass::BackendConfig,
                    reason: format!("fcm_private_key: {:?}", e),
                    action: DeliveryFailureAction::None,
                })?;
        let assertion = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
            &claims,
            &key,
        )
        .map_err(|e| DeliveryFailureDetails {
            class: DeliveryFailureClass::BackendConfig,
            reason: format!("fcm_assertion: {:?}", e),
            action: DeliveryFailureAction::None,
        })?;
        let form = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
            .append_pair("assertion", &assertion)
            .finish();

        let response = self
            .http
            .post(token_uri)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body(form)
            .send()
            .await
            .map_err(|e| DeliveryFailureDetails {
                class: DeliveryFailureClass::ProviderTransient,
                reason: format!("token_request_failed: {:?}", e.without_url()),
                action: DeliveryFailureAction::None,
            })?;
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(classify_fcm_token_error(status, &text));
        }
        let token: FcmTokenResponse =
            serde_json::from_str(&text).map_err(|e| DeliveryFailureDetails {
                class: DeliveryFailureClass::ProviderRejected,
                reason: format!("token_response_invalid: {:?}", e),
                action: DeliveryFailureAction::None,
            })?;
        let lifetime = Duration::from_secs(token.expires_in.max(1));
        Ok((token.access_token, lifetime))
    }
}

#[derive(Deserialize)]
struct FcmTokenResponse {
    access_token: String,
    #[serde(default = "default_fcm_token_lifetime")]
    expires_in: u64,
}

fn default_fcm_token_lifetime() -> u64 {
    FCM_JWT_LIFETIME_SECS as u64
}

#[derive(Deserialize)]
struct FcmErrorResponse {
    error: FcmErrorBody,
}

#[derive(Deserialize)]
struct FcmErrorBody {
    #[serde(default)]
    status: String,
    #[serde(default)]
    details: Vec<FcmErrorDetail>,
}

#[derive(Deserialize)]
struct FcmErrorDetail {
    #[serde(default, rename = "errorCode")]
    error_code: Option<String>,
}

/// Builds the FCM HTTP v1 request body. Message data must be a string map, so
/// the structured preview is embedded as JSON text.
pub(super) fn build_fcm_message(
    device_token: &str,
    notification: &FcmNotification,
) -> Result<String, serde_json::Error> {
    serde_json::to_string(&serde_json::json!({
        "message": {
            "token": device_token,
            "data": fcm_data_map(&notification.data)?,
            "android": {
                "priority": "high",
                "ttl": FCM_MESSAGE_TTL,
                "collapse_key": notification.collapse_key,
            },
        }
    }))
}

fn fcm_data_map(
    data: &FcmData,
) -> Result<std::collections::BTreeMap<String, String>, serde_json::Error> {
    let value = serde_json::to_value(data)?;
    let mut map = std::collections::BTreeMap::new();
    if let serde_json::Value::Object(fields) = value {
        for (key, value) in fields {
            let text = match value {
                serde_json::Value::String(text) => text,
                other => other.to_string(),
            };
            map.insert(key, text);
        }
    }
    Ok(map)
}

pub(super) fn classify_fcm_error(status: u16, body: &str) -> DeliveryFailureDetails {
    let error = serde_json::from_str::<FcmErrorResponse>(body).ok();
    let error_code = error
        .as_ref()
        .and_then(|error| {
            error
                .error
                .details
                .iter()
                .find_map(|detail| detail.error_code.clone())
        })
        .or_else(|| {
            error
                .as_ref()
                .map(|error| error.error.status.clone())
                .filter(|status| !status.is_empty())
        })
        .unwrap_or_else(|| format!("http_{status}"));

    let (class, action) = match error_code.as_str() {
        "UNREGISTERED" | "SENDER_ID_MISMATCH" => (
            DeliveryFailureClass::ProviderRejected,
            DeliveryFailureAction::PruneImmediate,
        ),
        "INVALID_ARGUMENT" => (
            DeliveryFailureClass::ProviderRejected,
            DeliveryFailureAction::None,
        ),
        "UNAVAILABLE" | "INTERNAL" | "QUOTA_EXCEEDED" => (
            DeliveryFailureClass::ProviderTransient,
            DeliveryFailureAction::None,
        ),
        "THIRD_PARTY_AUTH_ERROR" => (
            DeliveryFailureClass::BackendConfig,
            DeliveryFailureAction::None,
        ),
        _ if status == 401 || status == 403 => (
            DeliveryFailureClass::BackendConfig,
            DeliveryFailureAction::None,
        ),
        _ => (
            DeliveryFailureClass::ProviderTransient,
            DeliveryFailureAction::None,
        ),
    };

    DeliveryFailureDetails {
        class,
        reason: error_code,
        action,
    }
}

fn classify_fcm_token_error(status: u16, body: &str) -> DeliveryFailureDetails {
    // Token endpoint errors contain no message content; keep a short,
    // non-secret diagnostic instead of the whole response body.
    let snippet: String = body.chars().take(200).collect();
    warn!(status = status, body = %snippet, "FCM token request failed");
    DeliveryFailureDetails {
        class: if (400..500).contains(&status) {
            DeliveryFailureClass::BackendConfig
        } else {
            DeliveryFailureClass::ProviderTransient
        },
        reason: if (400..500).contains(&status) {
            "fcm_auth_rejected".to_string()
        } else {
            "fcm_token_unavailable".to_string()
        },
        action: DeliveryFailureAction::None,
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
