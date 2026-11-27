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
