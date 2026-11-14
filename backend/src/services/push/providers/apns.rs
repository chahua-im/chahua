use a2::{
    request::payload::PayloadLike, Client as ApnsClient, ClientConfig as ApnsClientConfig,
    DefaultNotificationBuilder, Endpoint as ApnsEndpoint, ErrorReason as ApnsErrorReason,
    NotificationBuilder, NotificationOptions, Priority as ApnsPriority, PushType as ApnsPushType,
};
use serde::Serialize;
use std::fs::File;

use crate::models::{MessageType, PushEnvironment, PushSubscription};
use crate::services::push::delivery::{
    DeliveryFailureAction, DeliveryFailureClass, DeliveryFailureDetails,
};
use crate::services::push::payload::{
    payload_type_for, truncate_preview, PushMessagePreview, PushPayloadType, RecipientNotification,
};

const APNS_CUSTOM_DATA_ROOT: &str = "wettyChat";
const APNS_TITLE_LOC_KEY: &str = "push.chat.title";
const APNS_BODY_LOC_KEY_WITH_PREVIEW: &str = "push.message.body";
const APNS_BODY_LOC_KEY_NO_PREVIEW: &str = "push.message.body.generic";
const APNS_BODY_LOC_KEY_AUDIO: &str = "push.message.body.audio";
const APNS_BODY_LOC_KEY_AUDIO_WITH_PREVIEW: &str = "push.message.body.audio.with_preview";
const APNS_BODY_LOC_KEY_IMAGE: &str = "push.message.body.image";
const APNS_BODY_LOC_KEY_IMAGE_WITH_PREVIEW: &str = "push.message.body.image.with_preview";
const APNS_BODY_LOC_KEY_VIDEO: &str = "push.message.body.video";
const APNS_BODY_LOC_KEY_VIDEO_WITH_PREVIEW: &str = "push.message.body.video.with_preview";
const APNS_BODY_LOC_KEY_STICKER: &str = "push.message.body.sticker";
const APNS_BODY_LOC_KEY_STICKER_EMOJI: &str = "push.message.body.sticker.emoji";
const APNS_BODY_LOC_KEY_INVITE: &str = "push.message.body.invite";
const APNS_BODY_LOC_KEY_ATTACHMENT: &str = "push.message.body.attachment";
const APNS_BODY_LOC_KEY_ATTACHMENT_WITH_PREVIEW: &str = "push.message.body.attachment.with_preview";
const APNS_BODY_LOC_KEY_DELETED: &str = "push.message.body.deleted";
const APNS_BODY_LOC_KEY_MENTION: &str = "push.mention.body";
const APNS_BODY_LOC_KEY_REPLY: &str = "push.reply.body";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ApnsCustomData {
    #[serde(rename = "type")]
    type_: PushPayloadType,
    chat_id: String,
    message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_root_id: Option<String>,
    sender_name: String,
    message_preview: PushMessagePreview,
    unread_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    mentioned_uid: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ApnsNotification {
    title_loc_key: &'static str,
    title_loc_args: Vec<String>,
    body_loc_key: &'static str,
    body_loc_args: Vec<String>,
    badge: u32,
    thread_id: String,
    custom_data: ApnsCustomData,
}

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
pub(in crate::services::push) struct ApnsSender {
    sandbox_client: ApnsClient,
    production_client: ApnsClient,
    topic: String,
}

impl ApnsSender {
    pub(in crate::services::push) fn from_config(
        config: &crate::config::ApnsConfig,
    ) -> Result<Self, String> {
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

    pub(in crate::services::push) async fn send(
        &self,
        sub: &PushSubscription,
        input: &RecipientNotification<'_>,
    ) -> Result<(), DeliveryFailureDetails> {
        let device_token = sub
            .device_token
            .as_deref()
            .ok_or_else(|| invalid_subscription("missing_device_token"))?;
        sub.apns_data()
            .map_err(|_| invalid_subscription("invalid_provider_data"))?;
        let environment = sub
            .apns_environment
            .ok_or_else(|| invalid_subscription("missing_environment"))?;
        let notification = build_notification(input);
        self.send_notification(device_token, &environment, &notification)
            .await
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

    async fn send_notification(
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

fn invalid_subscription(reason: &str) -> DeliveryFailureDetails {
    DeliveryFailureDetails {
        class: DeliveryFailureClass::InvalidSubscription,
        reason: reason.to_string(),
        action: DeliveryFailureAction::PruneImmediate,
    }
}

fn build_notification(input: &RecipientNotification<'_>) -> ApnsNotification {
    let job = input.job;
    let unread_count = input.unread_count;
    let recipient_uid = input.recipient_uid;
    let badge = unread_count.clamp(0, u32::MAX as i64) as u32;
    let preview = &job.message_preview;
    let is_mention = job.mentioned_uids.contains(&recipient_uid);
    let payload_type = payload_type_for(job, recipient_uid);
    let is_reply = matches!(payload_type, PushPayloadType::Reply);
    // Keep reason codes in the structured payload, but never use them as the
    // human-readable APNs body (including reply notifications).
    let display_message = if preview.message_type == MessageType::Placeholder {
        Some(
            preview
                .message
                .as_deref()
                .and_then(crate::models::ForwardPlaceholder::from_code)
                .map(crate::models::ForwardPlaceholder::notification_text)
                .unwrap_or("[Unavailable message]"),
        )
    } else {
        preview.message.as_deref()
    };

    let (body_loc_key, body_loc_args) = if is_mention {
        // Mentions only occur on text messages; surface a dedicated localized body.
        let text = display_message.unwrap_or("");
        (
            APNS_BODY_LOC_KEY_MENTION,
            vec![job.sender_username.clone(), truncate_preview(text)],
        )
    } else if is_reply {
        // Reply targets get a mention-style body: sender name + the reply's
        // preview text (empty when the reply is a media-only message).
        let text = display_message.unwrap_or("");
        (
            APNS_BODY_LOC_KEY_REPLY,
            vec![job.sender_username.clone(), truncate_preview(text)],
        )
    } else if preview.is_deleted {
        (APNS_BODY_LOC_KEY_DELETED, vec![job.sender_username.clone()])
    } else {
        match preview.message_type {
            MessageType::Placeholder => (
                APNS_BODY_LOC_KEY_WITH_PREVIEW,
                vec![
                    job.sender_username.clone(),
                    display_message.unwrap_or("").to_owned(),
                ],
            ),
            MessageType::Audio => (APNS_BODY_LOC_KEY_AUDIO, vec![job.sender_username.clone()]),
            MessageType::Sticker => match &preview.sticker {
                Some(s) if !s.emoji.trim().is_empty() => (
                    APNS_BODY_LOC_KEY_STICKER_EMOJI,
                    vec![job.sender_username.clone(), s.emoji.clone()],
                ),
                _ => (APNS_BODY_LOC_KEY_STICKER, vec![job.sender_username.clone()]),
            },
            MessageType::Invite => (APNS_BODY_LOC_KEY_INVITE, vec![job.sender_username.clone()]),
            MessageType::File => match &preview.message {
                Some(message) if !message.trim().is_empty() => (
                    APNS_BODY_LOC_KEY_ATTACHMENT_WITH_PREVIEW,
                    vec![job.sender_username.clone(), truncate_preview(message)],
                ),
                _ => (
                    APNS_BODY_LOC_KEY_ATTACHMENT,
                    vec![job.sender_username.clone()],
                ),
            },
            _ => {
                if let Some(first_att) = preview.attachments.first() {
                    let kind = &first_att.kind;
                    if let Some(msg) = &preview.message {
                        (
                            attachment_kind_loc_key(kind, true),
                            vec![job.sender_username.clone(), truncate_preview(msg)],
                        )
                    } else {
                        (
                            attachment_kind_loc_key(kind, false),
                            vec![job.sender_username.clone()],
                        )
                    }
                } else if let Some(msg) = &preview.message {
                    (
                        APNS_BODY_LOC_KEY_WITH_PREVIEW,
                        vec![job.sender_username.clone(), truncate_preview(msg)],
                    )
                } else {
                    (
                        APNS_BODY_LOC_KEY_NO_PREVIEW,
                        vec![job.sender_username.clone()],
                    )
                }
            }
        }
    };

    let thread_id = match job.thread_root_id {
        Some(root_id) => format!("chat_{}_thread_{}", job.chat_id, root_id),
        None => format!("chat_{}", job.chat_id),
    };

    ApnsNotification {
        title_loc_key: APNS_TITLE_LOC_KEY,
        title_loc_args: vec![job.chat_name.clone()],
        body_loc_key,
        body_loc_args,
        badge,
        thread_id,
        custom_data: ApnsCustomData {
            type_: payload_type,
            chat_id: job.chat_id.to_string(),
            message_id: job.message_id.to_string(),
            thread_root_id: job.thread_root_id.map(|id| id.to_string()),
            sender_name: job.sender_username.clone(),
            message_preview: job.message_preview.clone(),
            unread_count,
            mentioned_uid: is_mention.then_some(recipient_uid),
        },
    }
}

fn attachment_kind_loc_key(kind: &str, with_preview: bool) -> &'static str {
    match (kind.split('/').next(), with_preview) {
        (Some("image"), false) => APNS_BODY_LOC_KEY_IMAGE,
        (Some("image"), true) => APNS_BODY_LOC_KEY_IMAGE_WITH_PREVIEW,
        (Some("video"), false) => APNS_BODY_LOC_KEY_VIDEO,
        (Some("video"), true) => APNS_BODY_LOC_KEY_VIDEO_WITH_PREVIEW,
        (Some("audio"), false) => APNS_BODY_LOC_KEY_AUDIO,
        (Some("audio"), true) => APNS_BODY_LOC_KEY_AUDIO_WITH_PREVIEW,
        (_, false) => APNS_BODY_LOC_KEY_ATTACHMENT,
        (_, true) => APNS_BODY_LOC_KEY_ATTACHMENT_WITH_PREVIEW,
    }
}

fn classify_apns_send_error(error: &a2::Error) -> DeliveryFailureDetails {
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

fn is_stale_apns_error_reason(reason: &ApnsErrorReason) -> bool {
    matches!(
        reason,
        ApnsErrorReason::BadDeviceToken
            | ApnsErrorReason::DeviceTokenNotForTopic
            | ApnsErrorReason::Unregistered
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::messages::MessagePreviewAttachment;
    use crate::services::push::{PushJob, PushMessagePreviewSticker};

    #[test]
    fn placeholder_text_badge_and_mention_precedence() {
        let job = PushJob {
            chat_id: 10,
            sender_uid: 7,
            sender_username: "alice".to_string(),
            chat_name: "General".to_string(),
            message_preview: PushMessagePreview {
                message: Some("unknown_reason".to_string()),
                message_type: MessageType::Placeholder,
                sticker: None,
                attachments: Vec::new(),
                is_deleted: false,
            },
            body_preview: None,
            message_id: 99,
            thread_root_id: None,
            mentioned_uids: vec![42],
            reply_target_uid: Some(42),
        };
        let input = RecipientNotification {
            job: &job,
            recipient_uid: 42,
            unread_count: i64::MAX,
            is_dm: false,
        };
        let notification = build_notification(&input);
        assert_eq!(notification.badge, u32::MAX);
        assert_eq!(notification.body_loc_key, APNS_BODY_LOC_KEY_MENTION);
        assert_eq!(
            notification.body_loc_args,
            ["alice", "[Unavailable message]"]
        );
        assert_eq!(notification.custom_data.type_, PushPayloadType::Mention);

        let notification = build_notification(&RecipientNotification {
            unread_count: -1,
            recipient_uid: 99,
            ..input
        });
        assert_eq!(notification.badge, 0);
        assert_eq!(notification.body_loc_key, APNS_BODY_LOC_KEY_WITH_PREVIEW);
        assert_eq!(
            notification.body_loc_args,
            ["alice", "[Unavailable message]"]
        );
    }

    #[test]
    fn build_apns_notification_uses_mention_loc_key_for_mentioned_recipient() {
        let job = PushJob {
            chat_id: 10,
            sender_uid: 7,
            sender_username: "alice".to_string(),
            chat_name: "General".to_string(),
            message_preview: PushMessagePreview {
                message: Some("hello there".to_string()),
                message_type: MessageType::Text,
                sticker: None,
                attachments: Vec::new(),
                is_deleted: false,
            },
            body_preview: Some("hello there".to_string()),
            message_id: 99,
            thread_root_id: None,
            mentioned_uids: vec![42],
            reply_target_uid: None,
        };

        let n = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 1,
            recipient_uid: 42,
            is_dm: false,
        });
        assert_eq!(n.body_loc_key, APNS_BODY_LOC_KEY_MENTION);
        assert_eq!(
            n.body_loc_args,
            vec!["alice".to_string(), "hello there".to_string()]
        );
        assert_eq!(n.custom_data.type_, PushPayloadType::Mention);
        assert_eq!(n.custom_data.mentioned_uid, Some(42));

        // Non-mentioned recipient falls back to the standard text-with-preview key.
        let other = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 1,
            recipient_uid: 99,
            is_dm: false,
        });
        assert_eq!(other.body_loc_key, APNS_BODY_LOC_KEY_WITH_PREVIEW);
        assert_eq!(other.custom_data.type_, PushPayloadType::NewMessage);
        assert_eq!(other.custom_data.mentioned_uid, None);
    }

    #[test]
    fn build_apns_notification_uses_reply_loc_key_for_reply_target() {
        let job = PushJob {
            chat_id: 10,
            sender_uid: 7,
            sender_username: "alice".to_string(),
            chat_name: "General".to_string(),
            message_preview: PushMessagePreview {
                message: Some("a reply".to_string()),
                message_type: MessageType::Text,
                sticker: None,
                attachments: Vec::new(),
                is_deleted: false,
            },
            body_preview: Some("a reply".to_string()),
            message_id: 99,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
            reply_target_uid: Some(42),
        };

        let n = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 1,
            recipient_uid: 42,
            is_dm: false,
        });
        assert_eq!(n.body_loc_key, APNS_BODY_LOC_KEY_REPLY);
        assert_eq!(
            n.body_loc_args,
            vec!["alice".to_string(), "a reply".to_string()]
        );
        assert_eq!(n.custom_data.type_, PushPayloadType::Reply);
        assert_eq!(n.custom_data.mentioned_uid, None);
    }

    #[test]
    fn build_apns_notification_uses_localized_keys_and_custom_data() {
        let job = PushJob {
            chat_id: 10,
            sender_uid: 42,
            sender_username: "alice".to_string(),
            chat_name: "General".to_string(),
            message_preview: PushMessagePreview {
                message: Some("Hello".to_string()),
                message_type: MessageType::Text,
                sticker: None,
                attachments: Vec::new(),
                is_deleted: false,
            },
            body_preview: Some("hello there".to_string()),
            message_id: 99,
            thread_root_id: Some(77),
            mentioned_uids: Vec::new(),
            reply_target_uid: None,
        };

        let n = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 7,
            recipient_uid: 42,
            is_dm: false,
        });
        assert_eq!(n.title_loc_key, APNS_TITLE_LOC_KEY);
        assert_eq!(n.title_loc_args, vec!["General".to_string()]);
        assert_eq!(n.body_loc_key, APNS_BODY_LOC_KEY_WITH_PREVIEW);
        assert_eq!(
            n.body_loc_args,
            vec!["alice".to_string(), "Hello".to_string()]
        );
        assert_eq!(n.badge, 7);
        assert_eq!(n.thread_id, "chat_10_thread_77");
        assert_eq!(n.custom_data.chat_id, "10");
        assert_eq!(n.custom_data.thread_root_id, Some("77".to_string()));
        assert_eq!(n.custom_data.unread_count, 7);
    }

    #[test]
    fn build_apns_notification_falls_back_when_preview_missing() {
        let job = PushJob {
            chat_id: 10,
            sender_uid: 42,
            sender_username: "alice".to_string(),
            chat_name: "General".to_string(),
            message_preview: PushMessagePreview {
                message: None,
                message_type: MessageType::Text,
                sticker: None,
                attachments: Vec::new(),
                is_deleted: false,
            },
            body_preview: None,
            message_id: 99,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
            reply_target_uid: None,
        };

        let payload = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 0,
            recipient_uid: 42,
            is_dm: false,
        });
        assert_eq!(payload.body_loc_key, APNS_BODY_LOC_KEY_NO_PREVIEW);
        assert_eq!(payload.body_loc_args, vec!["alice".to_string()]);
        assert_eq!(payload.badge, 0);
        assert_eq!(payload.thread_id, "chat_10");
    }

    #[test]
    fn build_apns_notification_audio_message() {
        let job = PushJob {
            chat_id: 5,
            sender_uid: 1,
            sender_username: "bob".to_string(),
            chat_name: "DMs".to_string(),
            message_preview: PushMessagePreview {
                message: None,
                message_type: MessageType::Audio,
                sticker: None,
                attachments: Vec::new(),
                is_deleted: false,
            },
            body_preview: None,
            message_id: 50,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
            reply_target_uid: None,
        };

        let n = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 2,
            recipient_uid: 42,
            is_dm: false,
        });
        assert_eq!(n.body_loc_key, APNS_BODY_LOC_KEY_AUDIO);
        assert_eq!(n.body_loc_args, vec!["bob".to_string()]);
    }

    #[test]
    fn build_apns_notification_sticker_with_emoji() {
        let job = PushJob {
            chat_id: 5,
            sender_uid: 1,
            sender_username: "bob".to_string(),
            chat_name: "DMs".to_string(),
            message_preview: PushMessagePreview {
                message: None,
                message_type: MessageType::Sticker,
                sticker: Some(PushMessagePreviewSticker {
                    emoji: "🎉".to_string(),
                }),
                attachments: Vec::new(),
                is_deleted: false,
            },
            body_preview: Some("[Sticker] 🎉".to_string()),
            message_id: 51,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
            reply_target_uid: None,
        };

        let n = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 0,
            recipient_uid: 42,
            is_dm: false,
        });
        assert_eq!(n.body_loc_key, APNS_BODY_LOC_KEY_STICKER_EMOJI);
        assert_eq!(n.body_loc_args, vec!["bob".to_string(), "🎉".to_string()]);
    }

    #[test]
    fn build_apns_notification_image_attachment() {
        let job = PushJob {
            chat_id: 5,
            sender_uid: 1,
            sender_username: "bob".to_string(),
            chat_name: "DMs".to_string(),
            message_preview: PushMessagePreview {
                message: None,
                message_type: MessageType::Text,
                sticker: None,
                attachments: vec![MessagePreviewAttachment {
                    kind: "image/jpeg".to_string(),
                }],
                is_deleted: false,
            },
            body_preview: None,
            message_id: 52,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
            reply_target_uid: None,
        };

        let n = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 1,
            recipient_uid: 42,
            is_dm: false,
        });
        assert_eq!(n.body_loc_key, "push.message.body.image");
        assert_eq!(n.body_loc_args, vec!["bob".to_string()]);
    }

    #[test]
    fn build_apns_notification_prefers_attachment_key_over_caption_preview() {
        let job = PushJob {
            chat_id: 5,
            sender_uid: 1,
            sender_username: "bob".to_string(),
            chat_name: "DMs".to_string(),
            message_preview: PushMessagePreview {
                message: Some("look at this".to_string()),
                message_type: MessageType::File,
                sticker: None,
                attachments: vec![MessagePreviewAttachment {
                    kind: "image/jpeg".to_string(),
                }],
                is_deleted: false,
            },
            body_preview: Some("[Image]".to_string()),
            message_id: 54,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
            reply_target_uid: None,
        };

        let n = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 0,
            recipient_uid: 42,
            is_dm: false,
        });
        assert_eq!(n.body_loc_key, "push.message.body.attachment.with_preview");
        assert_eq!(
            n.body_loc_args,
            vec!["bob".to_string(), "look at this".to_string()]
        );
    }

    #[test]
    fn build_apns_notification_video_attachment() {
        let job = PushJob {
            chat_id: 5,
            sender_uid: 1,
            sender_username: "bob".to_string(),
            chat_name: "DMs".to_string(),
            message_preview: PushMessagePreview {
                message: None,
                message_type: MessageType::Text,
                sticker: None,
                attachments: vec![MessagePreviewAttachment {
                    kind: "video/mp4".to_string(),
                }],
                is_deleted: false,
            },
            body_preview: None,
            message_id: 53,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
            reply_target_uid: None,
        };

        let n = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 0,
            recipient_uid: 42,
            is_dm: false,
        });
        assert_eq!(n.body_loc_key, "push.message.body.video");
    }

    #[test]
    fn build_apns_notification_file_attachment_uses_generic_key() {
        let job = PushJob {
            chat_id: 5,
            sender_uid: 1,
            sender_username: "bob".to_string(),
            chat_name: "DMs".to_string(),
            message_preview: PushMessagePreview {
                message: None,
                message_type: MessageType::File,
                sticker: None,
                attachments: vec![MessagePreviewAttachment {
                    kind: "application/pdf".to_string(),
                }],
                is_deleted: false,
            },
            body_preview: None,
            message_id: 55,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
            reply_target_uid: None,
        };

        let n = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 0,
            recipient_uid: 42,
            is_dm: false,
        });
        assert_eq!(n.body_loc_key, "push.message.body.attachment");
        assert_eq!(n.body_loc_args, vec!["bob".to_string()]);
    }

    #[test]
    fn build_apns_notification_invite() {
        let job = PushJob {
            chat_id: 5,
            sender_uid: 1,
            sender_username: "bob".to_string(),
            chat_name: "DMs".to_string(),
            message_preview: PushMessagePreview {
                message: None,
                message_type: MessageType::Invite,
                sticker: None,
                attachments: Vec::new(),
                is_deleted: false,
            },
            body_preview: Some("sent an invite".to_string()),
            message_id: 54,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
            reply_target_uid: None,
        };

        let n = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 0,
            recipient_uid: 42,
            is_dm: false,
        });
        assert_eq!(n.body_loc_key, APNS_BODY_LOC_KEY_INVITE);
        assert_eq!(n.body_loc_args, vec!["bob".to_string()]);
    }

    #[test]
    fn stale_apns_error_reason_classification_matches_expected_errors() {
        assert!(is_stale_apns_error_reason(&ApnsErrorReason::BadDeviceToken));
        assert!(is_stale_apns_error_reason(
            &ApnsErrorReason::DeviceTokenNotForTopic
        ));
        assert!(is_stale_apns_error_reason(&ApnsErrorReason::Unregistered));
        assert!(!is_stale_apns_error_reason(
            &ApnsErrorReason::TooManyRequests
        ));
        assert!(!is_stale_apns_error_reason(
            &ApnsErrorReason::InternalServerError
        ));
    }

    #[test]
    fn apns_response_error_with_bad_device_token_prunes_subscription() {
        let error = a2::Error::ResponseError(a2::Response {
            apns_id: Some("test-apns-id".to_string()),
            error: Some(a2::ErrorBody {
                reason: ApnsErrorReason::BadDeviceToken,
                timestamp: None,
            }),
            code: 400,
        });

        let failure = classify_apns_send_error(&error);

        assert_eq!(failure.action, DeliveryFailureAction::PruneImmediate);
        assert_eq!(failure.reason, "BadDeviceToken");
    }

    #[test]
    fn apns_response_error_with_unregistered_prunes_subscription() {
        let error = a2::Error::ResponseError(a2::Response {
            apns_id: Some("test-apns-id".to_string()),
            error: Some(a2::ErrorBody {
                reason: ApnsErrorReason::Unregistered,
                timestamp: None,
            }),
            code: 410,
        });

        let failure = classify_apns_send_error(&error);

        assert_eq!(failure.action, DeliveryFailureAction::PruneImmediate);
        assert_eq!(failure.reason, "Unregistered");
    }

    #[test]
    fn apns_response_error_with_too_many_requests_is_retryable() {
        let error = a2::Error::ResponseError(a2::Response {
            apns_id: Some("test-apns-id".to_string()),
            error: Some(a2::ErrorBody {
                reason: ApnsErrorReason::TooManyRequests,
                timestamp: None,
            }),
            code: 429,
        });

        let failure = classify_apns_send_error(&error);

        assert_eq!(failure.action, DeliveryFailureAction::None);
        assert_eq!(failure.reason, "TooManyRequests");
    }

    #[test]
    fn apns_timeout_is_retryable() {
        let error = a2::Error::RequestTimeout(30);

        let failure = classify_apns_send_error(&error);

        assert_eq!(failure.action, DeliveryFailureAction::None);
        assert_eq!(failure.reason, "request_timeout");
    }
}
