use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tracing::warn;

use super::super::delivery::{DeliveryFailureAction, DeliveryFailureClass, DeliveryFailureDetails};
use super::super::payload::{
    notification_body, payload_type_for, truncate_preview, PushMessagePreview, PushPayloadType,
    RecipientNotification,
};
use crate::models::PushSubscription;

const FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_DEFAULT_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const FCM_JWT_LIFETIME_SECS: i64 = 3600;
const FCM_ACCESS_TOKEN_REFRESH_MARGIN: Duration = Duration::from_secs(60);
const FCM_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const FCM_MESSAGE_TTL: &str = "86400s";

/// Firebase Cloud Messaging sender. Access tokens are minted from the service
/// account JSON with the OAuth2 JWT-bearer flow and cached until shortly before
/// they expire.
pub(in crate::services::push) struct FcmSender {
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct FcmNotification {
    collapse_key: String,
    data: FcmData,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FcmData {
    #[serde(rename = "type")]
    type_: PushPayloadType,
    chat_id: String,
    message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_root_id: Option<String>,
    sender_name: String,
    chat_name: String,
    body: String,
    unread_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    mentioned_uid: Option<i32>,
    message_preview: PushMessagePreview,
}

fn build_notification(input: &RecipientNotification<'_>) -> FcmNotification {
    let job = input.job;
    let collapse_key = match job.thread_root_id {
        Some(root_id) => format!("chat_{}_thread_{}", job.chat_id, root_id),
        None => format!("chat_{}", job.chat_id),
    };
    let data = FcmData {
        type_: payload_type_for(job, input.recipient_uid),
        chat_id: job.chat_id.to_string(),
        message_id: job.message_id.to_string(),
        thread_root_id: job.thread_root_id.map(|id| id.to_string()),
        sender_name: job.sender_username.clone(),
        chat_name: job.chat_name.clone(),
        body: notification_body(input),
        unread_count: input.unread_count,
        mentioned_uid: job
            .mentioned_uids
            .contains(&input.recipient_uid)
            .then_some(input.recipient_uid),
        message_preview: PushMessagePreview {
            message_type: job.message_preview.message_type.clone(),
            sticker: job.message_preview.sticker.clone(),
            attachments: job.message_preview.attachments.clone(),
            is_deleted: job.message_preview.is_deleted,
            message: job.message_preview.message.as_deref().map(truncate_preview),
        },
    };
    FcmNotification { collapse_key, data }
}

impl FcmSender {
    pub(in crate::services::push) async fn send(
        &self,
        sub: &PushSubscription,
        input: &RecipientNotification<'_>,
    ) -> Result<(), DeliveryFailureDetails> {
        if sub.target.trim().is_empty() {
            return Err(DeliveryFailureDetails {
                class: DeliveryFailureClass::InvalidSubscription,
                reason: "missing_device_token".to_string(),
                action: DeliveryFailureAction::PruneImmediate,
            });
        }
        let notification = build_notification(input);
        self.send_notification(&sub.target, &notification).await
    }

    pub(in crate::services::push) fn from_config(
        config: &crate::config::FcmConfig,
    ) -> Result<Self, String> {
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

    async fn send_notification(
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
fn build_fcm_message(
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

fn classify_fcm_error(status: u16, body: &str) -> DeliveryFailureDetails {
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

#[cfg(test)]
mod tests {
    use super::super::super::payload::MESSAGE_PREVIEW_MAX;
    use super::super::super::PushJob;
    use super::*;
    use crate::models::MessageType;

    fn fcm_job() -> PushJob {
        PushJob {
            chat_id: 10,
            sender_uid: 42,
            sender_username: "alice".to_string(),
            chat_name: "General".to_string(),
            message_preview: PushMessagePreview {
                message: Some("a".repeat(MESSAGE_PREVIEW_MAX + 5)),
                message_type: MessageType::Text,
                sticker: None,
                attachments: Vec::new(),
                is_deleted: false,
            },
            body_preview: Some("hello there".to_string()),
            message_id: 99,
            thread_root_id: Some(55),
            mentioned_uids: Vec::new(),
            reply_target_uid: Some(42),
        }
    }

    #[test]
    fn build_fcm_notification_carries_chat_context_and_truncated_preview() {
        let job = fcm_job();
        let notification = build_notification(&RecipientNotification {
            job: &job,
            recipient_uid: 42,
            unread_count: 3,
            is_dm: false,
        });

        assert_eq!(notification.collapse_key, "chat_10_thread_55");
        assert_eq!(notification.data.type_, PushPayloadType::Reply);
        assert_eq!(notification.data.chat_id, "10");
        assert_eq!(notification.data.message_id, "99");
        assert_eq!(notification.data.thread_root_id.as_deref(), Some("55"));
        assert_eq!(notification.data.sender_name, "alice");
        assert_eq!(notification.data.chat_name, "General");
        assert_eq!(notification.data.unread_count, 3);
        assert_eq!(
            notification.data.message_preview.message,
            Some(format!("{}…", "a".repeat(MESSAGE_PREVIEW_MAX)))
        );
    }

    #[test]
    fn fcm_message_body_is_data_only_with_string_values() {
        let job = fcm_job();
        let notification = build_notification(&RecipientNotification {
            job: &job,
            recipient_uid: 99,
            unread_count: 3,
            is_dm: false,
        });

        let body: serde_json::Value =
            serde_json::from_str(&build_fcm_message("device-token", &notification).unwrap())
                .expect("parse FCM request body");
        let message = &body["message"];

        assert_eq!(message["token"], "device-token");
        assert_eq!(message["android"]["priority"], "high");
        assert_eq!(message["android"]["ttl"], "86400s");
        assert_eq!(message["android"]["collapse_key"], "chat_10_thread_55");
        // The Android client renders notifications from data, so the system
        // must not display one itself.
        assert!(message.get("notification").is_none());
        let data = message["data"].as_object().expect("FCM data object");
        assert!(data.values().all(serde_json::Value::is_string));
        assert_eq!(data["type"], "newMessage");
        assert_eq!(data["chatId"], "10");
        assert_eq!(data["threadRootId"], "55");
        assert_eq!(data["unreadCount"], "3");
        assert_eq!(data["senderName"], "alice");
        assert_eq!(data["body"], "alice: hello there");
        let preview: serde_json::Value =
            serde_json::from_str(data["messagePreview"].as_str().unwrap()).expect("preview JSON");
        assert_eq!(preview["messageType"], "text");
    }

    #[test]
    fn fcm_message_body_omits_absent_optional_fields() {
        let job = PushJob {
            thread_root_id: None,
            mentioned_uids: Vec::new(),
            reply_target_uid: None,
            ..fcm_job()
        };
        let notification = build_notification(&RecipientNotification {
            job: &job,
            recipient_uid: 42,
            unread_count: 0,
            is_dm: false,
        });
        assert_eq!(notification.collapse_key, "chat_10");

        let body: serde_json::Value =
            serde_json::from_str(&build_fcm_message("device-token", &notification).unwrap())
                .expect("parse FCM request body");
        let data = body["message"]["data"]
            .as_object()
            .expect("FCM data object");
        assert!(!data.contains_key("threadRootId"));
        assert!(!data.contains_key("mentionedUid"));
    }

    #[test]
    fn fcm_unregistered_error_prunes_subscription() {
        let body = r#"{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}"#;

        let failure = classify_fcm_error(404, body);

        assert_eq!(failure.action, DeliveryFailureAction::PruneImmediate);
        assert_eq!(failure.class, DeliveryFailureClass::ProviderRejected);
        assert_eq!(failure.reason, "UNREGISTERED");
    }

    #[test]
    fn fcm_sender_id_mismatch_prunes_subscription() {
        let body = r#"{"error":{"code":403,"status":"PERMISSION_DENIED","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"SENDER_ID_MISMATCH"}]}}"#;

        let failure = classify_fcm_error(403, body);

        assert_eq!(failure.action, DeliveryFailureAction::PruneImmediate);
        assert_eq!(failure.reason, "SENDER_ID_MISMATCH");
    }

    #[test]
    fn fcm_invalid_argument_never_prunes_a_valid_token() {
        let body = r#"{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"Invalid payload","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"INVALID_ARGUMENT"}]}}"#;

        let failure = classify_fcm_error(400, body);

        assert_eq!(failure.action, DeliveryFailureAction::None);
        assert_eq!(failure.reason, "INVALID_ARGUMENT");
    }

    #[test]
    fn fcm_unavailable_error_is_retryable() {
        let body = r#"{"error":{"code":503,"status":"UNAVAILABLE","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNAVAILABLE"}]}}"#;

        let failure = classify_fcm_error(503, body);

        assert_eq!(failure.action, DeliveryFailureAction::None);
        assert_eq!(failure.class, DeliveryFailureClass::ProviderTransient);
    }

    #[test]
    fn fcm_error_without_body_falls_back_to_http_status() {
        let failure = classify_fcm_error(500, "");

        assert_eq!(failure.action, DeliveryFailureAction::None);
        assert_eq!(failure.reason, "http_500");
    }

    #[test]
    fn mention_takes_precedence_over_reply_and_ids_are_strings() {
        let job = PushJob {
            chat_id: 9007199254740993,
            message_id: 9007199254740995,
            mentioned_uids: vec![42],
            ..fcm_job()
        };
        let notification = build_notification(&RecipientNotification {
            job: &job,
            recipient_uid: 42,
            unread_count: 7,
            is_dm: true,
        });
        assert_eq!(notification.data.type_, PushPayloadType::Mention);
        assert_eq!(notification.data.mentioned_uid, Some(42));
        let body: serde_json::Value =
            serde_json::from_str(&build_fcm_message("token", &notification).unwrap()).unwrap();
        assert_eq!(body["message"]["data"]["chatId"], "9007199254740993");
        assert_eq!(body["message"]["data"]["messageId"], "9007199254740995");
        assert_eq!(body["message"]["data"]["mentionedUid"], "42");
        assert_eq!(body["message"]["data"]["body"], "alice: hello there");
    }
}
