use serde::Serialize;
use web_push::{HyperWebPushClient, WebPushClient};

use crate::config::WebPushConfig;
use crate::models::PushSubscription;
use crate::services::push::delivery::{
    DeliveryFailureAction, DeliveryFailureClass, DeliveryFailureDetails,
};
use crate::services::push::payload::{
    format_push_body, notification_body, payload_type_for, PushMessagePreview, PushPayloadType,
    RecipientNotification,
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PushPayloadData {
    chat_id: String,
    message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_root_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PushPayload {
    #[serde(rename = "type")]
    type_: PushPayloadType,
    title: String,
    body: String,
    sender_name: String,
    message_preview: PushMessagePreview,
    unread_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    mentioned_uid: Option<i32>,
    data: PushPayloadData,
    /// PWA displays DM mentions/replies using ordinary message text.
    #[serde(skip_serializing_if = "Option::is_none")]
    ordinary_message_body: Option<String>,
}

pub(in crate::services::push) struct WebPushSender {
    client: HyperWebPushClient,
    vapid_public_key: String,
    vapid_private_key: String,
    vapid_subject: String,
}

impl WebPushSender {
    pub(in crate::services::push) fn from_config(config: &WebPushConfig) -> Result<Self, String> {
        web_push::VapidSignatureBuilder::from_base64_no_sub(&config.vapid_private_key)
            .map_err(|error| format!("{error:?}"))?;
        Ok(Self {
            client: HyperWebPushClient::new(),
            vapid_public_key: config.vapid_public_key.clone(),
            vapid_private_key: config.vapid_private_key.clone(),
            vapid_subject: config.vapid_subject.clone(),
        })
    }

    pub(in crate::services::push) fn vapid_public_key(&self) -> &str {
        &self.vapid_public_key
    }

    pub(in crate::services::push) async fn send(
        &self,
        sub: &PushSubscription,
        input: &RecipientNotification<'_>,
    ) -> Result<(), DeliveryFailureDetails> {
        if sub.target.trim().is_empty() {
            return Err(failure(
                DeliveryFailureClass::InvalidSubscription,
                "missing_endpoint",
                DeliveryFailureAction::PruneImmediate,
            ));
        }
        let data = sub.web_push_data().map_err(|_| {
            failure(
                DeliveryFailureClass::InvalidSubscription,
                "invalid_provider_data",
                DeliveryFailureAction::PruneImmediate,
            )
        })?;
        let subscription =
            web_push::SubscriptionInfo::new(sub.target.clone(), data.p256dh, data.auth);
        let signature = web_push::VapidSignatureBuilder::from_base64_no_sub(
            &self.vapid_private_key,
        )
        .map_err(|_| {
            failure(
                DeliveryFailureClass::BackendConfig,
                "vapid_config",
                DeliveryFailureAction::None,
            )
        })?;
        let mut signature = signature.add_sub_info(&subscription);
        signature.add_claim("sub", self.vapid_subject.clone());
        let signature = signature.build().map_err(|_| {
            failure(
                DeliveryFailureClass::BackendConfig,
                "vapid_signature",
                DeliveryFailureAction::None,
            )
        })?;
        let payload = serde_json::to_vec(&build_notification(input)).map_err(|error| {
            DeliveryFailureDetails {
                class: DeliveryFailureClass::PayloadBuild,
                reason: format!("payload_serialize: {error:?}"),
                action: DeliveryFailureAction::None,
            }
        })?;
        let mut builder = web_push::WebPushMessageBuilder::new(&subscription);
        builder.set_payload(web_push::ContentEncoding::Aes128Gcm, &payload);
        builder.set_vapid_signature(signature);
        let message = builder.build().map_err(|_| {
            failure(
                DeliveryFailureClass::PayloadBuild,
                "message_build",
                DeliveryFailureAction::None,
            )
        })?;
        self.client
            .send(message)
            .await
            .map_err(|error| classify_web_push_error(&error))
    }
}

fn failure(
    class: DeliveryFailureClass,
    reason: &str,
    action: DeliveryFailureAction,
) -> DeliveryFailureDetails {
    DeliveryFailureDetails {
        class,
        reason: reason.to_string(),
        action,
    }
}

fn build_notification(input: &RecipientNotification<'_>) -> PushPayload {
    let job = input.job;
    PushPayload {
        type_: payload_type_for(job, input.recipient_uid),
        title: job.chat_name.clone(),
        body: notification_body(input),
        sender_name: job.sender_username.clone(),
        message_preview: job.message_preview.clone(),
        unread_count: input.unread_count,
        mentioned_uid: job
            .mentioned_uids
            .contains(&input.recipient_uid)
            .then_some(input.recipient_uid),
        ordinary_message_body: input
            .is_dm
            .then(|| format_push_body(&job.sender_username, job.body_preview.as_deref())),
        data: PushPayloadData {
            chat_id: job.chat_id.to_string(),
            message_id: job.message_id.to_string(),
            thread_root_id: job.thread_root_id.map(|id| id.to_string()),
        },
    }
}

fn classify_web_push_error(error: &web_push::WebPushError) -> DeliveryFailureDetails {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MessageType;
    use crate::services::push::{PushJob, PushMessagePreviewSticker};
    #[test]
    fn build_push_payload_includes_structured_preview_and_legacy_body() {
        let job = PushJob {
            chat_id: 10,
            sender_uid: 42,
            sender_username: "alice".to_string(),
            chat_name: "General".to_string(),
            message_preview: PushMessagePreview {
                message: None,
                message_type: MessageType::Sticker,
                sticker: Some(PushMessagePreviewSticker {
                    emoji: "🙂".to_string(),
                }),
                attachments: Vec::new(),
                is_deleted: false,
            },
            body_preview: Some("[Sticker] 🙂".to_string()),
            message_id: 99,
            thread_root_id: None,
            mentioned_uids: Vec::new(),
            reply_target_uid: None,
        };

        let payload = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 3,
            recipient_uid: 42,
            is_dm: false,
        });
        assert_eq!(payload.sender_name, "alice");
        assert_eq!(payload.body, "alice: [Sticker] 🙂");
        assert_eq!(payload.message_preview.message_type, MessageType::Sticker);
        assert_eq!(
            payload.message_preview.sticker,
            Some(PushMessagePreviewSticker {
                emoji: "🙂".to_string(),
            })
        );
        assert_eq!(payload.data.chat_id, "10");
        assert_eq!(payload.data.message_id, "99");
        assert_eq!(payload.unread_count, 3);

        let serialized = serde_json::to_value(&payload).expect("serialize push payload");
        assert_eq!(serialized["type"], "newMessage");
        assert_eq!(serialized["senderName"], "alice");
        assert_eq!(serialized["messagePreview"]["messageType"], "sticker");
        assert_eq!(serialized["data"]["chatId"], "10");
        assert_eq!(serialized["data"]["messageId"], "99");
        assert!(serialized.get("sender_name").is_none());
        assert!(serialized["data"].get("chat_id").is_none());
    }
    #[test]
    fn build_push_payload_marks_mention_for_mentioned_recipient() {
        let job = PushJob {
            chat_id: 10,
            sender_uid: 7,
            sender_username: "alice".to_string(),
            chat_name: "General".to_string(),
            message_preview: PushMessagePreview {
                message: Some("hi @[uid:42]".to_string()),
                message_type: MessageType::Text,
                sticker: None,
                attachments: Vec::new(),
                is_deleted: false,
            },
            body_preview: Some("hi @you".to_string()),
            message_id: 99,
            thread_root_id: None,
            mentioned_uids: vec![42],
            reply_target_uid: None,
        };

        // Mentioned recipient -> typed as Mention with context.
        let mentioned = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 1,
            recipient_uid: 42,
            is_dm: false,
        });
        assert_eq!(mentioned.type_, PushPayloadType::Mention);
        assert_eq!(mentioned.mentioned_uid, Some(42));
        let serialized = serde_json::to_value(&mentioned).expect("serialize");
        assert_eq!(serialized["type"], "mention");
        assert_eq!(serialized["mentionedUid"], 42);

        // Non-mentioned recipient -> generic newMessage, no mention context.
        let other = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 1,
            recipient_uid: 99,
            is_dm: false,
        });
        assert_eq!(other.type_, PushPayloadType::NewMessage);
        assert_eq!(other.mentioned_uid, None);
        let other_serialized = serde_json::to_value(&other).expect("serialize");
        assert!(other_serialized.get("mentionedUid").is_none());
    }
    #[test]
    fn build_push_payload_types_reply_for_reply_target() {
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
            thread_root_id: Some(55),
            mentioned_uids: Vec::new(),
            reply_target_uid: Some(42),
        };

        let reply = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 1,
            recipient_uid: 42,
            is_dm: false,
        });
        assert_eq!(reply.type_, PushPayloadType::Reply);
        assert_eq!(reply.mentioned_uid, None);
        let serialized = serde_json::to_value(&reply).expect("serialize");
        assert_eq!(serialized["type"], "reply");
        assert!(serialized.get("mentionedUid").is_none());

        // Unrelated recipient stays generic.
        let other = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 1,
            recipient_uid: 99,
            is_dm: false,
        });
        assert_eq!(other.type_, PushPayloadType::NewMessage);
    }

    #[test]
    fn build_push_payload_mention_outranks_reply_for_same_recipient() {
        let job = PushJob {
            chat_id: 10,
            sender_uid: 7,
            sender_username: "alice".to_string(),
            chat_name: "General".to_string(),
            message_preview: PushMessagePreview {
                message: Some("hi @[uid:42]".to_string()),
                message_type: MessageType::Text,
                sticker: None,
                attachments: Vec::new(),
                is_deleted: false,
            },
            body_preview: Some("hi @you".to_string()),
            message_id: 99,
            thread_root_id: None,
            mentioned_uids: vec![42],
            reply_target_uid: Some(42),
        };

        let payload = build_notification(&RecipientNotification {
            job: &job,
            unread_count: 1,
            recipient_uid: 42,
            is_dm: false,
        });
        assert_eq!(payload.type_, PushPayloadType::Mention);
        assert_eq!(payload.mentioned_uid, Some(42));
    }
    #[test]
    fn web_push_endpoint_not_found_prunes_immediately() {
        let error = web_push::request_builder::parse_response(
            http02::StatusCode::NOT_FOUND,
            b"not found".to_vec(),
        )
        .expect_err("404 should classify as endpoint not found");

        let failure = classify_web_push_error(&error);

        assert_eq!(failure.action, DeliveryFailureAction::PruneImmediate);
        assert_eq!(failure.reason, "endpoint_not_found");
    }

    #[test]
    fn web_push_endpoint_not_valid_prunes_immediately() {
        let error =
            web_push::request_builder::parse_response(http02::StatusCode::GONE, b"gone".to_vec())
                .expect_err("410 should classify as endpoint not valid");

        let failure = classify_web_push_error(&error);

        assert_eq!(failure.action, DeliveryFailureAction::PruneImmediate);
        assert_eq!(failure.reason, "endpoint_not_valid");
    }

    #[test]
    fn web_push_unspecified_counts_toward_pruning() {
        let failure = classify_web_push_error(&web_push::WebPushError::Unspecified);

        assert_eq!(failure.action, DeliveryFailureAction::Counted);
        assert_eq!(failure.reason, "unspecified");
    }

    #[test]
    fn web_push_server_error_is_retryable_without_pruning() {
        let error = web_push::request_builder::parse_response(
            http02::StatusCode::SERVICE_UNAVAILABLE,
            b"temporarily unavailable".to_vec(),
        )
        .expect_err("503 should classify as server error");

        let failure = classify_web_push_error(&error);

        assert_eq!(failure.action, DeliveryFailureAction::None);
        assert_eq!(failure.reason, "server_error");
    }

    #[test]
    fn dm_uses_ordinary_message_body_for_reply() {
        let job = PushJob {
            chat_id: 1,
            sender_uid: 1,
            sender_username: "alice".into(),
            chat_name: "DM".into(),
            message_preview: PushMessagePreview {
                message: Some("hello".into()),
                message_type: MessageType::Text,
                sticker: None,
                attachments: vec![],
                is_deleted: false,
            },
            body_preview: Some("hello".into()),
            message_id: 2,
            thread_root_id: None,
            mentioned_uids: vec![],
            reply_target_uid: Some(42),
        };
        let input = RecipientNotification {
            job: &job,
            recipient_uid: 42,
            unread_count: 1,
            is_dm: true,
        };
        let payload = build_notification(&input);
        assert_eq!(payload.body, "alice replied to your message: hello");
        assert_eq!(
            payload.ordinary_message_body.as_deref(),
            Some("alice: hello")
        );
        let input = RecipientNotification {
            is_dm: false,
            ..input
        };
        assert!(serde_json::to_value(build_notification(&input))
            .unwrap()
            .get("ordinaryMessageBody")
            .is_none());
    }
}
