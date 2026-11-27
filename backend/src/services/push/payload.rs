use serde::Serialize;

use crate::dto::messages::MessagePreviewAttachment;
use crate::models::MessageType;

use super::PushJob;
pub(super) struct RecipientNotification<'a> {
    pub(super) job: &'a PushJob,
    pub(super) recipient_uid: i32,
    /// Server-owned Main app badge: unread chats by default, capped messages when enabled.
    pub(super) unread_count: i64,
    pub(super) is_dm: bool,
}

pub(super) fn notification_body(input: &RecipientNotification<'_>) -> String {
    let job = input.job;
    match payload_type_for(job, input.recipient_uid) {
        PushPayloadType::Reply => {
            format_reply_push_body(&job.sender_username, job.body_preview.as_deref())
        }
        PushPayloadType::Mention | PushPayloadType::NewMessage => {
            format_push_body(&job.sender_username, job.body_preview.as_deref())
        }
    }
}

pub(super) const MESSAGE_PREVIEW_MAX: usize = 100;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_preview_preserves_short_and_exact_text() {
        assert_eq!(truncate_preview("hello"), "hello");
        let exact = "a".repeat(MESSAGE_PREVIEW_MAX);
        assert_eq!(truncate_preview(&exact), exact);
        let unicode =
            "不用注册tg之后感觉加群的奇怪的人会更多，感觉要考虑下禁止事项和惩罚措施了（）";
        assert_eq!(truncate_preview(unicode), unicode);
    }

    #[test]
    fn truncate_preview_adds_ellipsis_for_long_text() {
        let input = "a".repeat(MESSAGE_PREVIEW_MAX + 5);
        assert_eq!(
            truncate_preview(&input),
            format!("{}…", "a".repeat(MESSAGE_PREVIEW_MAX))
        );
    }

    #[test]
    fn body_formatting_preserves_fallback_and_reply_copy() {
        assert_eq!(format_push_body("alice", None), "alice sent a message");
        assert_eq!(
            format_reply_push_body("alice", Some("a reply")),
            "alice replied to your message: a reply"
        );
        assert_eq!(
            format_reply_push_body("alice", None),
            "alice replied to your message"
        );
    }
}
