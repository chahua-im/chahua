use serde::Serialize;

use crate::dto::messages::MessagePreviewAttachment;
use crate::models::MessageType;

use super::PushJob;

pub(super) const MESSAGE_PREVIEW_MAX: usize = 100;
pub(super) const APNS_TITLE_LOC_KEY: &str = "push.chat.title";
pub(super) const APNS_BODY_LOC_KEY_WITH_PREVIEW: &str = "push.message.body";
pub(super) const APNS_BODY_LOC_KEY_NO_PREVIEW: &str = "push.message.body.generic";
pub(super) const APNS_BODY_LOC_KEY_AUDIO: &str = "push.message.body.audio";
const APNS_BODY_LOC_KEY_AUDIO_WITH_PREVIEW: &str = "push.message.body.audio.with_preview";
pub(super) const APNS_BODY_LOC_KEY_IMAGE: &str = "push.message.body.image";
pub(super) const APNS_BODY_LOC_KEY_IMAGE_WITH_PREVIEW: &str =
    "push.message.body.image.with_preview";
pub(super) const APNS_BODY_LOC_KEY_VIDEO: &str = "push.message.body.video";
const APNS_BODY_LOC_KEY_VIDEO_WITH_PREVIEW: &str = "push.message.body.video.with_preview";
const APNS_BODY_LOC_KEY_STICKER: &str = "push.message.body.sticker";
pub(super) const APNS_BODY_LOC_KEY_STICKER_EMOJI: &str = "push.message.body.sticker.emoji";
pub(super) const APNS_BODY_LOC_KEY_INVITE: &str = "push.message.body.invite";
const APNS_BODY_LOC_KEY_ATTACHMENT: &str = "push.message.body.attachment";
const APNS_BODY_LOC_KEY_ATTACHMENT_WITH_PREVIEW: &str = "push.message.body.attachment.with_preview";
const APNS_BODY_LOC_KEY_DELETED: &str = "push.message.body.deleted";
pub(super) const APNS_BODY_LOC_KEY_MENTION: &str = "push.mention.body";
pub(super) const APNS_BODY_LOC_KEY_REPLY: &str = "push.reply.body";

/// A push notification job enqueued when a new message is created.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum PushPayloadType {
    NewMessage,
    Mention,
    Reply,
}

/// Per-recipient payload kind. A mention outranks a reply when the same
/// message both mentions and replies to the recipient.
pub(super) fn payload_type_for(job: &PushJob, recipient_uid: i32) -> PushPayloadType {
    if job.mentioned_uids.contains(&recipient_uid) {
        PushPayloadType::Mention
    } else if job.reply_target_uid == Some(recipient_uid) {
        PushPayloadType::Reply
    } else {
        PushPayloadType::NewMessage
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushMessagePreviewSticker {
    pub emoji: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushMessagePreview {
    pub message: Option<String>,
    pub message_type: MessageType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sticker: Option<PushMessagePreviewSticker>,
    pub attachments: Vec<MessagePreviewAttachment>,
    pub is_deleted: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct PushPayloadData {
    pub(super) chat_id: String,
    pub(super) message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) thread_root_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct PushPayload {
    #[serde(rename = "type")]
    pub(super) type_: PushPayloadType,
    pub(super) title: String,
    pub(super) body: String,
    pub(super) sender_name: String,
    pub(super) message_preview: PushMessagePreview,
    pub(super) unread_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) mentioned_uid: Option<i32>,
    pub(super) data: PushPayloadData,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApnsCustomData {
    #[serde(rename = "type")]
    pub(super) type_: PushPayloadType,
    pub(super) chat_id: String,
    pub(super) message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) thread_root_id: Option<String>,
    pub(super) sender_name: String,
    pub(super) message_preview: PushMessagePreview,
    pub(super) unread_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) mentioned_uid: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ApnsNotification {
    pub(super) title_loc_key: &'static str,
    pub(super) title_loc_args: Vec<String>,
    pub(super) body_loc_key: &'static str,
    pub(super) body_loc_args: Vec<String>,
    pub(super) badge: u32,
    pub(super) thread_id: String,
    pub(super) custom_data: ApnsCustomData,
}

pub(super) fn build_push_payload(
    job: &PushJob,
    unread_count: i64,
    body_text: &str,
    recipient_uid: i32,
) -> PushPayload {
    let is_mention = job.mentioned_uids.contains(&recipient_uid);
    PushPayload {
        type_: payload_type_for(job, recipient_uid),
        title: job.chat_name.clone(),
        body: body_text.to_string(),
        sender_name: job.sender_username.clone(),
        message_preview: job.message_preview.clone(),
        unread_count,
        mentioned_uid: is_mention.then_some(recipient_uid),
        data: PushPayloadData {
            chat_id: job.chat_id.to_string(),
            message_id: job.message_id.to_string(),
            thread_root_id: job.thread_root_id.map(|id| id.to_string()),
        },
    }
}

pub(super) fn build_apns_notification(
    job: &PushJob,
    unread_count: i64,
    recipient_uid: i32,
) -> ApnsNotification {
    let badge = unread_count.clamp(0, u32::MAX as i64) as u32;
    let preview = &job.message_preview;
    let is_mention = job.mentioned_uids.contains(&recipient_uid);
    let payload_type = payload_type_for(job, recipient_uid);
    let is_reply = matches!(payload_type, PushPayloadType::Reply);

    let (body_loc_key, body_loc_args) = if is_mention {
        // Mentions only occur on text messages; surface a dedicated localized body.
        let text = preview.message.as_deref().unwrap_or("");
        (
            APNS_BODY_LOC_KEY_MENTION,
            vec![job.sender_username.clone(), truncate_preview(text)],
        )
    } else if is_reply {
        // Reply targets get a mention-style body: sender name + the reply's
        // preview text (empty when the reply is a media-only message).
        let text = preview.message.as_deref().unwrap_or("");
        (
            APNS_BODY_LOC_KEY_REPLY,
            vec![job.sender_username.clone(), truncate_preview(text)],
        )
    } else if preview.is_deleted {
        (APNS_BODY_LOC_KEY_DELETED, vec![job.sender_username.clone()])
    } else {
        match preview.message_type {
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

pub(super) fn format_push_body(sender_username: &str, preview: Option<&str>) -> String {
    match preview {
        Some(preview) => format!("{}: {}", sender_username, truncate_preview(preview)),
        None => format!("{} sent a message", sender_username),
    }
}

pub(super) fn format_reply_push_body(sender_username: &str, preview: Option<&str>) -> String {
    match preview {
        Some(preview) => format!(
            "{} replied to your message: {}",
            sender_username,
            truncate_preview(preview)
        ),
        None => format!("{} replied to your message", sender_username),
    }
}

pub(super) fn truncate_preview(preview: &str) -> String {
    let truncated: String = preview.chars().take(MESSAGE_PREVIEW_MAX).collect();
    if preview.chars().count() > MESSAGE_PREVIEW_MAX {
        format!("{truncated}…")
    } else {
        truncated
    }
}
