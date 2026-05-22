use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ThreadPushState {
    NotThreadMessage,
    NoSubscription,
    ActiveSubscription,
    ArchivedSubscription,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PushRecipientContext {
    pub uid: i32,
    pub is_sender: bool,
    pub is_mentioned: bool,
    pub is_reply_target: bool,
    pub chat_archived: bool,
    pub group_muted_until: Option<DateTime<Utc>>,
    pub thread_state: ThreadPushState,
    pub has_active_presence: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PushDecision {
    Send,
    SendOneOffMention,
    Skip(PushSkipReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PushSkipReason {
    Sender,
    ChatArchived,
    ActivePresence,
    GroupMuted,
    ThreadArchived,
    NoThreadSubscription,
}

pub(crate) fn should_send_push(
    recipient: &PushRecipientContext,
    now: DateTime<Utc>,
) -> PushDecision {
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
            if recipient.is_mentioned || !is_group_muted(recipient.group_muted_until, now) {
                PushDecision::Send
            } else {
                PushDecision::Skip(PushSkipReason::GroupMuted)
            }
        }
        ThreadPushState::ActiveSubscription => PushDecision::Send,
        ThreadPushState::ArchivedSubscription => {
            if recipient.is_mentioned {
                PushDecision::SendOneOffMention
            } else {
                PushDecision::Skip(PushSkipReason::ThreadArchived)
            }
        }
        ThreadPushState::NoSubscription => {
            if recipient.is_mentioned {
                PushDecision::SendOneOffMention
            } else {
                PushDecision::Skip(PushSkipReason::NoThreadSubscription)
            }
        }
    }
}

fn is_group_muted(muted_until: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    muted_until.is_some_and(|t| t > now)
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
                group_muted_until: None,
                thread_state,
                has_active_presence: false,
            },
        )
    }

    #[test]
    fn top_level_unmuted_recipient_receives_push() {
        let (now, recipient) = base(ThreadPushState::NotThreadMessage);
        assert_eq!(should_send_push(&recipient, now), PushDecision::Send);
    }

    #[test]
    fn top_level_group_mute_suppresses_unmentioned_recipient() {
        let (now, mut recipient) = base(ThreadPushState::NotThreadMessage);
        recipient.group_muted_until = Some(now + Duration::minutes(5));
        assert_eq!(
            should_send_push(&recipient, now),
            PushDecision::Skip(PushSkipReason::GroupMuted)
        );
    }

    #[test]
    fn top_level_mention_bypasses_group_mute() {
        let (now, mut recipient) = base(ThreadPushState::NotThreadMessage);
        recipient.group_muted_until = Some(now + Duration::minutes(5));
        recipient.is_mentioned = true;
        assert_eq!(should_send_push(&recipient, now), PushDecision::Send);
    }

    #[test]
    fn normal_reply_target_bypasses_group_mute() {
        let (now, mut reply_target) = base(ThreadPushState::NotThreadMessage);
        reply_target.uid = 42;
        reply_target.is_reply_target = true;
        reply_target.group_muted_until = Some(now + Duration::minutes(5));

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
        recipient.group_muted_until = Some(now + Duration::minutes(5));
        assert_eq!(should_send_push(&recipient, now), PushDecision::Send);
    }

    #[test]
    fn root_author_active_thread_subscription_ignores_group_mute() {
        let (now, mut recipient) = base(ThreadPushState::ActiveSubscription);
        recipient.uid = 42;
        recipient.group_muted_until = Some(now + Duration::days(1));
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
