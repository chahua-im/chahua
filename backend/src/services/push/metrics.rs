use prometheus::{
    register_histogram_vec_with_registry, register_int_counter_vec_with_registry,
    register_int_counter_with_registry, HistogramVec, IntCounter, IntCounterVec, Registry,
};

pub struct PushMetrics {
    notifications_total: IntCounterVec,
    notification_jobs_total: IntCounterVec,
    notification_job_duration_seconds: HistogramVec,
    notifications_suppressed_total: IntCounter,
    delivery_failures_total: IntCounterVec,
    subscription_prunes_total: IntCounterVec,
}

impl PushMetrics {
    pub fn new(registry: &Registry) -> Self {
        let notifications_total = register_int_counter_vec_with_registry!(
            "push_notifications_total",
            "Total number of push notification delivery attempts",
            &["provider", "result"],
            registry
        )
        .expect("push_notifications_total registration should succeed");
        let notification_jobs_total = register_int_counter_vec_with_registry!(
            "push_notification_jobs_total",
            "Total number of push notification jobs processed by the worker",
            &["result"],
            registry
        )
        .expect("push_notification_jobs_total registration should succeed");
        let notification_job_duration_seconds = register_histogram_vec_with_registry!(
            "push_notification_job_duration_seconds",
            "Push notification job runtime in seconds",
            &["result"],
            vec![0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0],
            registry
        )
        .expect("push_notification_job_duration_seconds registration should succeed");
        let notifications_suppressed_total = register_int_counter_with_registry!(
            "push_notifications_suppressed_total",
            "Total number of push notifications skipped because a user had active websocket presence",
            registry
        )
        .expect("push_notifications_suppressed_total registration should succeed");
        let delivery_failures_total = register_int_counter_vec_with_registry!(
            "push_delivery_failures_total",
            "Total number of classified push delivery failures",
            &["provider", "class"],
            registry
        )
        .expect("push_delivery_failures_total registration should succeed");
        let subscription_prunes_total = register_int_counter_vec_with_registry!(
            "push_subscription_prunes_total",
            "Total number of push subscriptions pruned after delivery failures",
            &["provider", "reason"],
            registry
        )
        .expect("push_subscription_prunes_total registration should succeed");

        Self {
            notifications_total,
            notification_jobs_total,
            notification_job_duration_seconds,
            notifications_suppressed_total,
            delivery_failures_total,
            subscription_prunes_total,
        }
    }

    pub fn record_notification(&self, provider: &str, success: bool) {
        let result = if success { "success" } else { "failure" };
        self.notifications_total
            .with_label_values(&[provider, result])
            .inc();
    }

    pub fn record_job(&self, result: &str, duration_seconds: f64) {
        self.notification_jobs_total
            .with_label_values(&[result])
            .inc();
        self.notification_job_duration_seconds
            .with_label_values(&[result])
            .observe(duration_seconds);
    }

    pub fn record_suppressed(&self) {
        self.notifications_suppressed_total.inc();
    }

    pub fn record_delivery_failure(&self, provider: &str, class: &str) {
        self.delivery_failures_total
            .with_label_values(&[provider, class])
            .inc();
    }

    pub fn record_subscription_prune(&self, provider: &str, reason: &str) {
        self.subscription_prunes_total
            .with_label_values(&[provider, reason])
            .inc();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_metrics_render_expected_values() {
        let registry = Registry::new();
        let metrics = PushMetrics::new(&registry);
        metrics.record_notification("web_push", true);
        metrics.record_notification("apns", false);
        metrics.record_job("success", 0.2);
        metrics.record_job("failure", 0.4);
        metrics.record_suppressed();

        let rendered = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(rendered
            .contains("push_notifications_total{provider=\"web_push\",result=\"success\"} 1"));
        assert!(
            rendered.contains("push_notifications_total{provider=\"apns\",result=\"failure\"} 1")
        );
        assert!(rendered.contains("push_notification_jobs_total{result=\"success\"} 1"));
        assert!(rendered.contains("push_notification_jobs_total{result=\"failure\"} 1"));
        assert!(
            rendered.contains("push_notification_job_duration_seconds_sum{result=\"success\"} 0.2")
        );
        assert!(
            rendered.contains("push_notification_job_duration_seconds_sum{result=\"failure\"} 0.4")
        );
        assert!(
            rendered.contains("push_notification_job_duration_seconds_count{result=\"success\"} 1")
        );
        assert!(
            rendered.contains("push_notification_job_duration_seconds_count{result=\"failure\"} 1")
        );
        assert!(rendered.contains("push_notifications_suppressed_total 1"));
    }
}
