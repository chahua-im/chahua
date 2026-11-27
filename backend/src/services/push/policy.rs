use crate::models::GroupKind;
use crate::services::notification_preferences::{ChatNotificationSetting, NotificationDefaults};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadPushState {
    NotThreadMessage,
    NoSubscription,
    ActiveSubscription,
    ArchivedSubscription,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushRecipientContext {
    pub uid: i32,
    pub is_sender: bool,
    pub is_mentioned: bool,
    pub is_reply_target: bool,
    pub chat_archived: bool,
    pub notification_setting: ChatNotificationSetting,
    pub chat_kind: GroupKind,
    pub notification_defaults: NotificationDefaults,
    pub thread_state: ThreadPushState,
    pub has_active_presence: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushDecision {
    Send,
    /// One-off push to a directly addressed recipient (mentioned, or the
    /// target of a reply) who is not otherwise eligible — e.g. thread without
    /// an active subscription. Treated like [`PushDecision::Send`] downstream.
    SendOneOffMention,
    Skip(PushSkipReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushSkipReason {
    Sender,
    ChatArchived,
    ActivePresence,
    GroupMuted,
    ThreadArchived,
    NoThreadSubscription,
}

pub fn should_send_web_push(
    recipient: &PushRecipientContext,
    is_dm: bool,
    now: DateTime<Utc>,
) -> PushDecision {
    if is_dm {
        should_send_push(
            &PushRecipientContext {
                is_mentioned: false,
                is_reply_target: false,
                ..recipient.clone()
            },
            now,
        )
    } else {
        should_send_push(recipient, now)
    }
}

pub fn should_send_push(recipient: &PushRecipientContext, now: DateTime<Utc>) -> PushDecision {
    if recipient.is_sender {
        return PushDecision::Skip(PushSkipReason::Sender);
    }

    if recipient.has_active_presence {
        return PushDecision::Skip(PushSkipReason::ActivePresence);
    }

    if recipient.is_reply_target
        && matches!(recipient.thread_state, ThreadPushState::NotThreadMessage)
    {
        return PushDecision::Send;
    }

    if recipient.chat_archived {
        return PushDecision::Skip(PushSkipReason::ChatArchived);
    }

    match recipient.thread_state {
        ThreadPushState::NotThreadMessage => {
            if recipient.is_mentioned
                || !recipient.notification_setting.is_muted(
                    recipient.chat_kind,
                    recipient.notification_defaults,
                    now,
                )
            {
                PushDecision::Send
            } else {
                PushDecision::Skip(PushSkipReason::GroupMuted)
            }
        }
        ThreadPushState::ActiveSubscription => PushDecision::Send,
        ThreadPushState::ArchivedSubscription => {
            if recipient.is_mentioned || recipient.is_reply_target {
                PushDecision::SendOneOffMention
            } else {
                PushDecision::Skip(PushSkipReason::ThreadArchived)
            }
        }
        ThreadPushState::NoSubscription => {
            if recipient.is_mentioned || recipient.is_reply_target {
                PushDecision::SendOneOffMention
            } else {
                PushDecision::Skip(PushSkipReason::NoThreadSubscription)
            }
        }
    }
}

#[cfg(test)]
mod tests;
