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
mod tests {
    use super::*;
    use chrono::Duration;

    fn base(thread_state: ThreadPushState) -> (DateTime<Utc>, PushRecipientContext) {
        let now = Utc::now();
        (
            now,
            PushRecipientContext {
                uid: 7,
                is_sender: false,
                is_mentioned: false,
                is_reply_target: false,
                chat_archived: false,
                notification_setting: ChatNotificationSetting {
                    muted_until: None,
                    mute_override: None,
                },
                chat_kind: GroupKind::Group,
                notification_defaults: NotificationDefaults {
                    group_chats_muted: false,
                    direct_chats_muted: false,
                },
                thread_state,
                has_active_presence: false,
            },
        )
    }

    #[test]
    fn dm_web_push_uses_ordinary_rules_without_changing_native_or_group_push() {
        for thread_state in [
            ThreadPushState::NotThreadMessage,
            ThreadPushState::ActiveSubscription,
            ThreadPushState::ArchivedSubscription,
            ThreadPushState::NoSubscription,
        ] {
            for archived in [false, true] {
                for muted in [false, true] {
                    let (now, mut ordinary) = base(thread_state);
                    ordinary.chat_archived = archived;
                    ordinary.notification_setting.muted_until =
                        muted.then_some(now + Duration::minutes(5));
                    for (mention, reply) in [(true, false), (false, true), (true, true)] {
                        let directed = PushRecipientContext {
                            is_mentioned: mention,
                            is_reply_target: reply,
                            ..ordinary.clone()
                        };
                        assert_eq!(
                            should_send_web_push(&directed, true, now),
                            should_send_push(&ordinary, now),
                        );
                        assert_eq!(
                            should_send_web_push(&directed, false, now),
                            should_send_push(&directed, now),
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn top_level_unmuted_recipient_receives_push() {
        let (now, recipient) = base(ThreadPushState::NotThreadMessage);
        assert_eq!(should_send_push(&recipient, now), PushDecision::Send);
    }

    #[test]
    fn notification_preferences_apply_to_main_chats_but_not_subscribed_threads() {
        let (now, mut recipient) = base(ThreadPushState::NotThreadMessage);
        recipient.notification_defaults = NotificationDefaults::default();
        assert_eq!(
            should_send_push(&recipient, now),
            PushDecision::Skip(PushSkipReason::GroupMuted)
        );
        recipient.notification_setting.mute_override = Some(false);
        assert_eq!(should_send_push(&recipient, now), PushDecision::Send);
        recipient.notification_setting.muted_until = Some(now + Duration::seconds(1));
        assert_eq!(
            should_send_push(&recipient, now),
            PushDecision::Skip(PushSkipReason::GroupMuted)
        );
        assert_eq!(
            should_send_push(&recipient, now + Duration::seconds(1)),
            PushDecision::Send
        );
        recipient.thread_state = ThreadPushState::ActiveSubscription;
        assert_eq!(should_send_push(&recipient, now), PushDecision::Send);
        recipient.thread_state = ThreadPushState::NotThreadMessage;
        recipient.chat_kind = GroupKind::Dm;
        recipient.notification_setting = ChatNotificationSetting {
            muted_until: None,
            mute_override: None,
        };
        assert_eq!(
            should_send_web_push(&recipient, true, now),
            PushDecision::Send
        );
        recipient.notification_setting.mute_override = Some(true);
        recipient.is_mentioned = true;
        recipient.is_reply_target = true;
        assert_eq!(
            should_send_web_push(&recipient, true, now),
            PushDecision::Skip(PushSkipReason::GroupMuted)
        );
        assert_eq!(should_send_push(&recipient, now), PushDecision::Send); // Existing APNs reply exception.
    }

    #[test]
    fn dm_archive_suppresses_notifications_without_a_mute_timestamp() {
        let (now, mut recipient) = base(ThreadPushState::NotThreadMessage);
        recipient.chat_archived = true;
        assert_eq!(
            should_send_web_push(&recipient, true, now),
            PushDecision::Skip(PushSkipReason::ChatArchived)
        );
        recipient.chat_archived = false;
        assert_eq!(
            should_send_web_push(&recipient, true, now),
            PushDecision::Send
        );
        recipient.notification_setting.muted_until =
            Some(crate::services::chat::indefinite_mute_until());
        assert_eq!(
            should_send_web_push(&recipient, true, now),
            PushDecision::Skip(PushSkipReason::GroupMuted)
        );
    }

    #[test]
    fn top_level_group_mute_suppresses_unmentioned_recipient() {
        let (now, mut recipient) = base(ThreadPushState::NotThreadMessage);
        recipient.notification_setting.muted_until = Some(now + Duration::minutes(5));
        assert_eq!(
            should_send_push(&recipient, now),
            PushDecision::Skip(PushSkipReason::GroupMuted)
        );
    }

    #[test]
    fn top_level_mention_bypasses_group_mute() {
        let (now, mut recipient) = base(ThreadPushState::NotThreadMessage);
        recipient.notification_setting.muted_until = Some(now + Duration::minutes(5));
        recipient.is_mentioned = true;
        assert_eq!(should_send_push(&recipient, now), PushDecision::Send);
    }

    #[test]
    fn normal_reply_target_bypasses_group_mute() {
        let (now, mut reply_target) = base(ThreadPushState::NotThreadMessage);
        reply_target.uid = 42;
        reply_target.is_reply_target = true;
        reply_target.notification_setting.muted_until = Some(now + Duration::minutes(5));

        assert_eq!(should_send_push(&reply_target, now), PushDecision::Send);
    }

    #[test]
    fn normal_reply_target_bypasses_chat_archive() {
        let (now, mut reply_target) = base(ThreadPushState::NotThreadMessage);
        reply_target.is_reply_target = true;
        reply_target.chat_archived = true;

        assert_eq!(should_send_push(&reply_target, now), PushDecision::Send);
    }

    #[test]
    fn chat_archive_blocks_top_level_and_thread_pushes() {
        for thread_state in [
            ThreadPushState::NotThreadMessage,
            ThreadPushState::ActiveSubscription,
            ThreadPushState::ArchivedSubscription,
            ThreadPushState::NoSubscription,
        ] {
            let (now, mut recipient) = base(thread_state);
            recipient.chat_archived = true;
            recipient.is_mentioned = true;
            assert_eq!(
                should_send_push(&recipient, now),
                PushDecision::Skip(PushSkipReason::ChatArchived)
            );
        }
    }

    #[test]
    fn active_thread_subscription_ignores_group_mute() {
        let (now, mut recipient) = base(ThreadPushState::ActiveSubscription);
        recipient.notification_setting.muted_until = Some(now + Duration::minutes(5));
        assert_eq!(should_send_push(&recipient, now), PushDecision::Send);
    }

    #[test]
    fn root_author_active_thread_subscription_ignores_group_mute() {
        let (now, mut recipient) = base(ThreadPushState::ActiveSubscription);
        recipient.uid = 42;
        recipient.notification_setting.muted_until = Some(now + Duration::days(1));
        assert_eq!(should_send_push(&recipient, now), PushDecision::Send);
    }

    #[test]
    fn archived_thread_subscription_skips_when_not_mentioned() {
        let (now, recipient) = base(ThreadPushState::ArchivedSubscription);
        assert_eq!(
            should_send_push(&recipient, now),
            PushDecision::Skip(PushSkipReason::ThreadArchived)
        );
    }

    #[test]
    fn archived_thread_subscription_mention_gets_one_off_push() {
        let (now, mut recipient) = base(ThreadPushState::ArchivedSubscription);
        recipient.is_mentioned = true;
        assert_eq!(
            should_send_push(&recipient, now),
            PushDecision::SendOneOffMention
        );
    }

    #[test]
    fn no_thread_subscription_mention_gets_one_off_push() {
        let (now, mut recipient) = base(ThreadPushState::NoSubscription);
        recipient.is_mentioned = true;
        assert_eq!(
            should_send_push(&recipient, now),
            PushDecision::SendOneOffMention
        );
    }

    #[test]
    fn archived_thread_subscription_reply_target_gets_one_off_push() {
        let (now, mut recipient) = base(ThreadPushState::ArchivedSubscription);
        recipient.is_reply_target = true;
        assert_eq!(
            should_send_push(&recipient, now),
            PushDecision::SendOneOffMention
        );
    }

    #[test]
    fn no_thread_subscription_reply_target_gets_one_off_push() {
        let (now, mut recipient) = base(ThreadPushState::NoSubscription);
        recipient.is_reply_target = true;
        assert_eq!(
            should_send_push(&recipient, now),
            PushDecision::SendOneOffMention
        );
    }

    #[test]
    fn sender_and_active_presence_are_suppressed() {
        let (now, mut sender) = base(ThreadPushState::ActiveSubscription);
        sender.is_sender = true;
        assert_eq!(
            should_send_push(&sender, now),
            PushDecision::Skip(PushSkipReason::Sender)
        );

        let (now, mut active) = base(ThreadPushState::ActiveSubscription);
        active.has_active_presence = true;
        assert_eq!(
            should_send_push(&active, now),
            PushDecision::Skip(PushSkipReason::ActivePresence)
        );
    }
}
