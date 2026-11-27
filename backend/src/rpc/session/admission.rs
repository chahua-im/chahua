//! Bounded, process-wide admission for ordinary RPC work.
//!
//! Running reservations hold all three capacities together. Waiting requests
//! hold none; accounts take turns, while a busy connection may be bypassed by
//! another connection belonging to the same account.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::{
    sync::{oneshot, OwnedSemaphorePermit, Semaphore},
    time::Instant,
};

pub(super) const MAX_ACCOUNT_IN_FLIGHT: usize = 16;
pub(super) const MAX_WAITING: usize = 256;
pub(super) const MAX_ACCOUNT_WAITING: usize = 64;
pub(super) const MAX_WAIT: Duration = Duration::from_secs(5);

pub(super) struct Admission {
    global_limit: usize,
    account_limit: usize,
    queue_limit: usize,
    account_queue_limit: usize,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    running: usize,
    waiting: usize,
    next_id: u64,
    accounts: HashMap<i32, Account>,
    // Exactly one entry per account with a nonempty queue.
    round_robin: VecDeque<i32>,
}

#[derive(Default)]
struct Account {
    running: usize,
    queue: VecDeque<Waiter>,
}

struct Waiter {
    id: u64,
    connection: Arc<Semaphore>,
    deadline: Instant,
    sender: oneshot::Sender<Permit>,
    metrics: Arc<crate::metrics::RpcAdmissionMetrics>,
    enqueued: Instant,
}

pub(super) struct Request {
    admission: Arc<Admission>,
    uid: i32,
    inner: Option<RequestInner>,
}

enum RequestInner {
    Immediate(Permit),
    Queued {
        id: u64,
        receiver: oneshot::Receiver<Permit>,
    },
}

pub(super) struct Permit {
    admission: Arc<Admission>,
    uid: i32,
    connection: Option<OwnedSemaphorePermit>,
}

impl Admission {
    pub(super) fn new(
        global_limit: usize,
        account_limit: usize,
        queue_limit: usize,
        account_queue_limit: usize,
    ) -> Arc<Self> {
        Arc::new(Self {
            global_limit,
            account_limit,
            queue_limit,
            account_queue_limit,
            state: Mutex::new(State::default()),
        })
    }

    pub(super) fn request(
        self: &Arc<Self>,
        uid: i32,
        connection: &Arc<Semaphore>,
        deadline: Instant,
        metrics: &Arc<crate::metrics::RpcAdmissionMetrics>,
    ) -> Option<Request> {
        let mut state = self.state.lock().expect("admission lock");
        let account_running = state.accounts.get(&uid).map_or(0, |a| a.running);
        if deadline > Instant::now()
            && state.running < self.global_limit
            && account_running < self.account_limit
        {
            if let Ok(connection_permit) = connection.clone().try_acquire_owned() {
                state.running += 1;
                state.accounts.entry(uid).or_default().running += 1;
                return Some(Request {
                    admission: self.clone(),
                    uid,
                    inner: Some(RequestInner::Immediate(Permit {
                        admission: self.clone(),
                        uid,
                        connection: Some(connection_permit),
                    })),
                });
            }
        }

        if state.waiting >= self.queue_limit
            || state.accounts.get(&uid).map_or(0, |a| a.queue.len()) >= self.account_queue_limit
        {
            return None;
        }
        let id = state.next_id;
        state.next_id = state.next_id.wrapping_add(1);
        let (sender, receiver) = oneshot::channel();
        let account = state.accounts.entry(uid).or_default();
        let was_empty = account.queue.is_empty();
        account.queue.push_back(Waiter {
            id,
            connection: connection.clone(),
            deadline,
            sender,
            metrics: metrics.clone(),
            enqueued: Instant::now(),
        });
        if was_empty {
            state.round_robin.push_back(uid);
        }
        state.waiting += 1;
        metrics.queued();
        Some(Request {
            admission: self.clone(),
            uid,
            inner: Some(RequestInner::Queued { id, receiver }),
        })
    }

    // Return deliveries to the caller: sending or dropping a permit while the
    // state lock is held could recursively enter this scheduler.
    fn schedule(self: &Arc<Self>, state: &mut State) -> Vec<(oneshot::Sender<Permit>, Permit)> {
        let mut deliveries = Vec::new();
        let mut skipped = 0;
        while state.running < self.global_limit && skipped < state.round_robin.len() {
            let uid = state.round_robin.pop_front().expect("nonempty round robin");
            let account = state.accounts.get_mut(&uid).expect("queued account");
            let mut selected = None;
            if account.running < self.account_limit {
                for (index, waiter) in account.queue.iter().enumerate() {
                    if waiter.deadline <= Instant::now() {
                        continue;
                    }
                    if let Ok(connection) = waiter.connection.clone().try_acquire_owned() {
                        selected = Some((index, connection));
                        break;
                    }
                }
            }
            if let Some((index, connection)) = selected {
                let waiter = account.queue.remove(index).expect("selected waiter");
                waiter
                    .metrics
                    .dequeued(waiter.enqueued.elapsed(), "started");
                account.running += 1;
                state.running += 1;
                state.waiting -= 1;
                deliveries.push((
                    waiter.sender,
                    Permit {
                        admission: self.clone(),
                        uid,
                        connection: Some(connection),
                    },
                ));
                skipped = 0;
            } else {
                skipped += 1;
            }
            if !account.queue.is_empty() {
                state.round_robin.push_back(uid);
            }
        }
        deliveries
    }

    fn cancel(&self, uid: i32, id: u64) {
        let mut state = self.state.lock().expect("admission lock");
        let Some(account) = state.accounts.get_mut(&uid) else {
            return;
        };
        let Some(index) = account.queue.iter().position(|w| w.id == id) else {
            return;
        };
        let waiter = account.queue.remove(index).expect("queued waiter");
        let empty_queue = account.queue.is_empty();
        let idle = empty_queue && account.running == 0;
        waiter.metrics.dequeued(
            waiter.enqueued.elapsed(),
            if waiter.deadline <= Instant::now() {
                "timeout"
            } else {
                "cancelled"
            },
        );
        state.waiting -= 1;
        if empty_queue {
            state.round_robin.retain(|queued_uid| *queued_uid != uid);
        }
        if idle {
            state.accounts.remove(&uid);
        }
        // Sender holds no permit; drop it outside the lock as a general rule.
        drop(state);
        drop(waiter);
    }
}

impl Request {
    pub(super) fn is_waiting(&self) -> bool {
        matches!(&self.inner, Some(RequestInner::Queued { .. }))
    }

    pub(super) async fn wait(mut self) -> Permit {
        match self.inner.as_mut().expect("request already consumed") {
            RequestInner::Immediate(_) => match self.inner.take().expect("immediate request") {
                RequestInner::Immediate(permit) => permit,
                RequestInner::Queued { .. } => unreachable!(),
            },
            RequestInner::Queued { receiver, .. } => {
                let permit = receiver
                    .await
                    .expect("admission sender dropped before request");
                self.inner = None;
                permit
            }
        }
    }
}

impl Drop for Request {
    fn drop(&mut self) {
        if let Some(RequestInner::Queued { id, .. }) = &self.inner {
            self.admission.cancel(self.uid, *id);
        }
        // The receiver (or immediate permit) drops after cancellation, outside
        // the scheduler lock. A grant racing cancellation is released there.
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        drop(self.connection.take());
        let deliveries = {
            let mut state = self.admission.state.lock().expect("admission lock");
            state.running -= 1;
            let account = state.accounts.get_mut(&self.uid).expect("running account");
            account.running -= 1;
            if account.running == 0 && account.queue.is_empty() {
                state.accounts.remove(&self.uid);
            }
            self.admission.schedule(&mut state)
        };
        for (sender, permit) in deliveries {
            // On cancellation, send returns the permit, which is dropped here
            // outside the lock and schedules the next eligible request.
            let _ = sender.send(permit);
        }
    }
}

#[cfg(test)]
mod tests;
