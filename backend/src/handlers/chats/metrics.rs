use prometheus::{register_int_counter_vec_with_registry, IntCounterVec, Registry};

pub(crate) struct ChatMetrics {
    messages_total: IntCounterVec,
}

impl ChatMetrics {
    pub(crate) fn new(registry: &Registry) -> Self {
        let messages_total = register_int_counter_vec_with_registry!(
            "messages_total",
            "Total number of messages successfully persisted",
            &["chat_id"],
            registry
        )
        .expect("messages_total registration should succeed");

        Self { messages_total }
    }

    pub(crate) fn record_message(&self, chat_id: i64) {
        let chat_id = chat_id.to_string();
        self.messages_total.with_label_values(&[&chat_id]).inc();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_metrics_render_expected_values() {
        let registry = Registry::new();
        let metrics = ChatMetrics::new(&registry);
        metrics.record_message(123);

        let rendered = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(rendered.contains("messages_total{chat_id=\"123\"} 1"));
    }
}
