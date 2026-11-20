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
            RequestInner::Queued { receiver, .. } => receiver
                .await
                .expect("admission sender dropped before request"),
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
mod tests {
    use super::*;
    use futures::task::noop_waker;
    use std::{
        future::Future,
        pin::Pin,
        task::{Context, Poll},
    };

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(60)
    }
    fn metrics() -> Arc<crate::metrics::RpcAdmissionMetrics> {
        Arc::new(crate::metrics::RpcAdmissionMetrics::new(
            &prometheus::Registry::new(),
        ))
    }
    fn request(a: &Arc<Admission>, uid: i32, c: &Arc<Semaphore>) -> Request {
        a.request(uid, c, deadline(), &metrics())
            .expect("queue has room")
    }
    fn poll<F: Future>(f: Pin<&mut F>) -> Poll<F::Output> {
        f.poll(&mut Context::from_waker(&noop_waker()))
    }
    fn ready<F: Future>(f: Pin<&mut F>) -> F::Output {
        match poll(f) {
            Poll::Ready(value) => value,
            Poll::Pending => panic!("expected ready"),
        }
    }
    fn assert_idle(a: &Admission) {
        let s = a.state.lock().unwrap();
        assert_eq!(s.running, 0);
        assert_eq!(s.waiting, 0);
        assert!(s.accounts.is_empty());
        assert!(s.round_robin.is_empty());
    }

    #[tokio::test]
    async fn enforces_all_running_limits() {
        let a = Admission::new(2, 1, 10, 10);
        let c1 = Arc::new(Semaphore::new(1));
        let c2 = Arc::new(Semaphore::new(1));
        let c3 = Arc::new(Semaphore::new(1));
        let p1 = request(&a, 1, &c1).wait().await;
        let mut same_account = Box::pin(request(&a, 1, &c2).wait());
        let mut same_connection = Box::pin(request(&a, 2, &c1).wait());
        let p3 = request(&a, 3, &c3).wait().await;
        let mut global = Box::pin(request(&a, 4, &c2).wait());
        assert!(poll(same_account.as_mut()).is_pending());
        assert!(poll(same_connection.as_mut()).is_pending());
        assert!(poll(global.as_mut()).is_pending());
        drop(p1);
        let p = ready(same_account.as_mut());
        assert!(poll(same_connection.as_mut()).is_pending());
        drop(p);
        let p = ready(same_connection.as_mut());
        drop(p3);
        let p4 = ready(global.as_mut());
        drop(p);
        drop(p4);
        drop(same_account);
        drop(same_connection);
        drop(global);
        assert_idle(&a);
    }

    #[tokio::test]
    async fn accounts_take_turns_and_busy_connections_are_bypassed() {
        let a = Admission::new(1, 4, 10, 10);
        let c = Arc::new(Semaphore::new(1));
        let other = Arc::new(Semaphore::new(1));
        let held = request(&a, 9, &c).wait().await;
        let mut a1 = Box::pin(request(&a, 1, &c).wait());
        let mut a2 = Box::pin(request(&a, 1, &other).wait());
        let mut b = Box::pin(request(&a, 2, &other).wait());
        drop(held);
        let p = ready(a1.as_mut());
        drop(p);
        let p = ready(b.as_mut());
        assert!(poll(a2.as_mut()).is_pending());
        drop(p);
        drop(ready(a2.as_mut()));
        drop(a1);
        drop(a2);
        drop(b);
        assert_idle(&a);

        let a = Admission::new(2, 2, 10, 10);
        let busy = Arc::new(Semaphore::new(1));
        let free = Arc::new(Semaphore::new(1));
        let spare = Arc::new(Semaphore::new(1));
        let held = request(&a, 9, &busy).wait().await;
        let blocker = request(&a, 8, &spare).wait().await;
        let mut blocked = Box::pin(request(&a, 1, &busy).wait());
        let mut same_account = Box::pin(request(&a, 1, &free).wait());
        let mut other_account = Box::pin(request(&a, 2, &spare).wait());
        drop(blocker);
        let p = ready(same_account.as_mut());
        assert!(poll(blocked.as_mut()).is_pending());
        drop(p);
        let p = ready(other_account.as_mut());
        drop(p);
        drop(held);
        drop(ready(blocked.as_mut()));
        drop(blocked);
        drop(same_account);
        drop(other_account);
        assert_idle(&a);
    }

    #[tokio::test]
    async fn queue_bounds_and_cancellation_reclaim_state() {
        let a = Admission::new(1, 1, 2, 1);
        let c = Arc::new(Semaphore::new(1));
        let p = request(&a, 1, &c).wait().await;
        let queued = request(&a, 1, &c);
        assert!(a.request(1, &c, deadline(), &metrics()).is_none());
        let second = request(&a, 2, &c);
        assert!(a.request(3, &c, deadline(), &metrics()).is_none());
        drop(queued);
        let replacement = request(&a, 3, &c);
        drop(second);
        drop(p); // Grant happens before the receiver is polled.
        drop(replacement); // Dropping the receiver releases that grant.
        assert_idle(&a);
        let p = request(&a, 4, &c).wait().await;
        drop(p);
        assert_idle(&a);
    }

    #[tokio::test]
    async fn cancelling_polled_future_after_grant_wakes_next_waiter() {
        let a = Admission::new(1, 1, 4, 4);
        let c = Arc::new(Semaphore::new(1));
        let immediate = request(&a, 1, &c);
        assert!(!immediate.is_waiting());
        let p = immediate.wait().await;
        let queued = request(&a, 2, &c);
        assert!(queued.is_waiting());
        let mut cancelled = Box::pin(queued.wait());
        let mut next = Box::pin(request(&a, 3, &c).wait());
        assert!(poll(cancelled.as_mut()).is_pending());
        assert!(poll(next.as_mut()).is_pending());
        drop(p);
        drop(cancelled);
        drop(ready(next.as_mut()));
        drop(next);
        assert_idle(&a);
    }

    #[tokio::test(start_paused = true)]
    async fn exports_queue_depth_and_wait_outcomes() {
        let registry = prometheus::Registry::new();
        let metrics = Arc::new(crate::metrics::RpcAdmissionMetrics::new(&registry));
        let a = Admission::new(1, 1, 4, 4);
        let c = Arc::new(Semaphore::new(1));
        let p = a.request(1, &c, deadline(), &metrics).unwrap().wait().await;
        let mut started = Box::pin(a.request(2, &c, deadline(), &metrics).unwrap().wait());

        let depth = || {
            registry
                .gather()
                .into_iter()
                .find(|family| family.get_name() == "rpc_admission_queue_depth")
                .unwrap()
                .get_metric()[0]
                .get_gauge()
                .get_value()
        };
        assert_eq!(depth(), 1.0);
        tokio::time::advance(Duration::from_secs(1)).await;
        drop(p);
        let p = ready(started.as_mut());
        assert_eq!(depth(), 0.0);

        let cancelled = a.request(3, &c, deadline(), &metrics).unwrap();
        assert_eq!(depth(), 1.0);
        tokio::time::advance(Duration::from_secs(2)).await;
        drop(cancelled);
        assert_eq!(depth(), 0.0);

        let timed_out = a
            .request(4, &c, Instant::now() + Duration::from_secs(1), &metrics)
            .unwrap();
        assert_eq!(depth(), 1.0);
        tokio::time::advance(Duration::from_secs(3)).await;
        drop(timed_out);
        assert_eq!(depth(), 0.0);

        let families = registry.gather();
        let waits = families
            .iter()
            .find(|family| family.get_name() == "rpc_admission_wait_duration_seconds")
            .unwrap();
        for (outcome, seconds) in [("started", 1.0), ("cancelled", 2.0), ("timeout", 3.0)] {
            let metric = waits
                .get_metric()
                .iter()
                .find(|metric| {
                    metric
                        .get_label()
                        .iter()
                        .any(|label| label.get_name() == "outcome" && label.get_value() == outcome)
                })
                .unwrap();
            assert_eq!(metric.get_histogram().get_sample_count(), 1);
            assert_eq!(metric.get_histogram().get_sample_sum(), seconds);
        }
        drop(p);
        drop(started);
        assert_idle(&a);
    }

    #[tokio::test(start_paused = true)]
    async fn expired_waiters_are_never_granted() {
        let a = Admission::new(1, 1, 4, 4);
        let c = Arc::new(Semaphore::new(1));
        let p = request(&a, 1, &c).wait().await;
        let expired = a
            .request(2, &c, Instant::now() + Duration::from_secs(1), &metrics())
            .unwrap();
        let mut live = Box::pin(request(&a, 3, &c).wait());
        tokio::time::advance(Duration::from_secs(2)).await;
        drop(p);
        let p = ready(live.as_mut());
        assert!(expired.is_waiting());
        drop(expired);
        drop(p);
        drop(live);
        assert_idle(&a);
    }
}
