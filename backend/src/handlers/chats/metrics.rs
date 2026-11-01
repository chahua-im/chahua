use prometheus::{register_int_counter_vec_with_registry, IntCounter, IntCounterVec, Registry};

use crate::models::GroupKind;

pub struct ChatMetrics {
    messages_total: IntCounterVec,
    dm_messages_total: IntCounter,
    group_messages_total: IntCounter,
}

impl ChatMetrics {
    pub fn new(registry: &Registry) -> Self {
        let messages_total = register_int_counter_vec_with_registry!(
            "messages_total",
            "Total number of messages successfully persisted",
            &["chat_id"],
            registry
        )
        .expect("messages_total registration should succeed");

        let messages_by_chat_kind_total = register_int_counter_vec_with_registry!(
            "messages_by_chat_kind_total",
            "Total number of messages successfully persisted by destination chat kind",
            &["chat_kind"],
            registry
        )
        .expect("messages_by_chat_kind_total registration should succeed");
        let dm_messages_total = messages_by_chat_kind_total.with_label_values(&["dm"]);
        let group_messages_total = messages_by_chat_kind_total.with_label_values(&["group"]);

        Self {
            messages_total,
            dm_messages_total,
            group_messages_total,
        }
    }

    pub fn record_message(&self, chat_id: i64, kind: GroupKind) {
        let chat_id = chat_id.to_string();
        self.messages_total.with_label_values(&[&chat_id]).inc();
        match kind {
            GroupKind::Dm => &self.dm_messages_total,
            GroupKind::Group => &self.group_messages_total,
        }
        .inc();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_metrics_render_expected_values() {
        let registry = Registry::new();
        let metrics = ChatMetrics::new(&registry);
        let initial = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(initial.contains("messages_by_chat_kind_total{chat_kind=\"dm\"} 0"));
        assert!(initial.contains("messages_by_chat_kind_total{chat_kind=\"group\"} 0"));
        metrics.record_message(123, GroupKind::Dm);
        metrics.record_message(456, GroupKind::Group);

        let rendered = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(rendered.contains("messages_total{chat_id=\"123\"} 1"));
        assert!(rendered.contains("messages_total{chat_id=\"456\"} 1"));
        assert!(rendered.contains("messages_by_chat_kind_total{chat_kind=\"dm\"} 1"));
        assert!(rendered.contains("messages_by_chat_kind_total{chat_kind=\"group\"} 1"));
    }
}
