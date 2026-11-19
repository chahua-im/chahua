use std::{
    collections::{BTreeSet, HashSet},
    sync::Mutex,
};

use tokio::sync::Notify;

#[derive(Debug, Default)]
pub struct SyncSubscription {
    state: Mutex<SubscriptionState>,
    changed: Notify,
}

#[derive(Debug, Default)]
struct SubscriptionState {
    attached: HashSet<i64>,
    dirty: BTreeSet<i64>,
    closed: bool,
}

impl SyncSubscription {
    pub(crate) fn mark(&self, chat_id: i64) {
        let mut state = self.state.lock().unwrap();
        if !state.closed && state.dirty.insert(chat_id) {
            self.changed.notify_one();
        }
    }

    pub(crate) fn mark_attached(&self) {
        let mut state = self.state.lock().unwrap();
        let SubscriptionState {
            attached, dirty, ..
        } = &mut *state;
        if !attached.is_empty() {
            dirty.extend(attached.iter().copied());
            self.changed.notify_one();
        }
    }

    pub(crate) fn close(&self) {
        *self.state.lock().unwrap() = SubscriptionState {
            closed: true,
            ..Default::default()
        };
        self.changed.notify_one();
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.state.lock().unwrap().closed
    }

    pub(crate) async fn notified(&self) {
        self.changed.notified().await;
    }

    pub(super) fn attach(&self, chats: impl IntoIterator<Item = i64>) {
        let mut state = self.state.lock().unwrap();
        if !state.closed {
            state.attached.extend(chats);
        }
    }

    pub(super) fn detach(&self, chat_id: i64) {
        self.state.lock().unwrap().attached.remove(&chat_id);
    }

    pub(super) fn take_dirty(&self) -> BTreeSet<i64> {
        std::mem::take(&mut self.state.lock().unwrap().dirty)
    }

    pub(super) fn notify_if_dirty(&self) {
        if !self.state.lock().unwrap().dirty.is_empty() {
            self.changed.notify_one();
        }
    }
}
