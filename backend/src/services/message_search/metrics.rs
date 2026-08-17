use std::time::{SystemTime, UNIX_EPOCH};

use prometheus::{
    register_histogram_vec_with_registry, register_int_counter_vec_with_registry,
    register_int_gauge_with_registry, HistogramVec, IntCounterVec, IntGauge, Registry,
};

pub struct MessageSearchMetrics {
    index_operations_total: IntCounterVec,
    queries_total: IntCounterVec,
    query_duration_seconds: HistogramVec,
    index_operation_duration_seconds: HistogramVec,
    candidates_per_query: HistogramVec,
    results_per_query: HistogramVec,
    candidates_dropped_total: IntCounterVec,
    index_documents_total: IntCounterVec,
    reindex_duration_seconds: HistogramVec,
    reindex_documents_total: IntCounterVec,
    reindex_last_success_timestamp_seconds: IntGauge,
}

impl MessageSearchMetrics {
    pub fn new(registry: &Registry) -> Self {
        let index_operations_total = register_int_counter_vec_with_registry!(
            "message_search_index_operations_total",
            "Total number of message search index operations",
            &["operation", "result"],
            registry
        )
        .expect("message_search_index_operations_total registration should succeed");
        let queries_total = register_int_counter_vec_with_registry!(
            "message_search_queries_total",
            "Total number of message search queries",
            &["sort", "result"],
            registry
        )
        .expect("message_search_queries_total registration should succeed");
        for operation in ["upsert", "delete", "delete_batch"] {
            for result in ["success", "failure"] {
                index_operations_total.with_label_values(&[operation, result]);
            }
        }
        for sort in ["relevance", "newest"] {
            for result in ["success", "failure"] {
                queries_total.with_label_values(&[sort, result]);
            }
        }
        let query_duration_seconds = register_histogram_vec_with_registry!(
            "message_search_query_duration_seconds",
            "Message search request latency in seconds",
            &["sort", "result"],
            vec![0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
            registry
        )
        .expect("message_search_query_duration_seconds registration should succeed");
        let index_operation_duration_seconds = register_histogram_vec_with_registry!(
            "message_search_index_operation_duration_seconds",
            "Message search index operation latency in seconds from enqueue to Meilisearch task completion",
            &["operation", "result"],
            vec![0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0],
            registry
        )
        .expect("message_search_index_operation_duration_seconds registration should succeed");
        let candidates_per_query = register_histogram_vec_with_registry!(
            "message_search_candidates_per_query",
            "Number of Meilisearch candidate hits returned per message search query",
            &["sort"],
            vec![0.0, 1.0, 5.0, 10.0, 20.0, 50.0, 100.0, 500.0, 1000.0],
            registry
        )
        .expect("message_search_candidates_per_query registration should succeed");
        let results_per_query = register_histogram_vec_with_registry!(
            "message_search_results_per_query",
            "Number of authoritative messages returned per message search query after database filtering",
            &["sort"],
            vec![0.0, 1.0, 5.0, 10.0, 20.0, 50.0, 100.0, 500.0, 1000.0],
            registry
        )
        .expect("message_search_results_per_query registration should succeed");
        let candidates_dropped_total = register_int_counter_vec_with_registry!(
            "message_search_candidates_dropped_total",
            "Total number of message search candidates dropped during database authority checks",
            &["reason"],
            registry
        )
        .expect("message_search_candidates_dropped_total registration should succeed");
        let index_documents_total = register_int_counter_vec_with_registry!(
            "message_search_index_documents_total",
            "Total number of message search index documents affected by index operations",
            &["operation", "result"],
            registry
        )
        .expect("message_search_index_documents_total registration should succeed");
        let reindex_duration_seconds = register_histogram_vec_with_registry!(
            "message_search_reindex_duration_seconds",
            "Message search full reindex job latency in seconds",
            &["result"],
            vec![1.0, 5.0, 15.0, 30.0, 60.0, 300.0, 900.0, 1800.0, 3600.0],
            registry
        )
        .expect("message_search_reindex_duration_seconds registration should succeed");
        let reindex_documents_total = register_int_counter_vec_with_registry!(
            "message_search_reindex_documents_total",
            "Total number of documents indexed by message search reindex jobs",
            &["result"],
            registry
        )
        .expect("message_search_reindex_documents_total registration should succeed");
        let reindex_last_success_timestamp_seconds = register_int_gauge_with_registry!(
            "message_search_reindex_last_success_timestamp_seconds",
            "Unix timestamp in seconds for the last successful message search reindex job",
            registry
        )
        .expect(
            "message_search_reindex_last_success_timestamp_seconds registration should succeed",
        );
        for sort in ["relevance", "newest"] {
            candidates_per_query.with_label_values(&[sort]);
            results_per_query.with_label_values(&[sort]);
            for result in ["success", "failure"] {
                query_duration_seconds.with_label_values(&[sort, result]);
            }
        }
        for operation in ["upsert", "delete", "delete_batch"] {
            for result in ["success", "failure"] {
                index_operation_duration_seconds.with_label_values(&[operation, result]);
                index_documents_total.with_label_values(&[operation, result]);
            }
        }
        for reason in [
            "missing_db_row",
            "wrong_chat",
            "not_searchable",
            "stale_version",
        ] {
            candidates_dropped_total.with_label_values(&[reason]);
        }
        for result in ["success", "failure"] {
            reindex_duration_seconds.with_label_values(&[result]);
            reindex_documents_total.with_label_values(&[result]);
        }

        Self {
            index_operations_total,
            queries_total,
            query_duration_seconds,
            index_operation_duration_seconds,
            candidates_per_query,
            results_per_query,
            candidates_dropped_total,
            index_documents_total,
            reindex_duration_seconds,
            reindex_documents_total,
            reindex_last_success_timestamp_seconds,
        }
    }

    pub fn record_index_operation(&self, operation: &str, result: &str) {
        self.index_operations_total
            .with_label_values(&[operation, result])
            .inc();
    }

    pub fn record_query(&self, sort: &str, result: &str) {
        self.queries_total.with_label_values(&[sort, result]).inc();
    }

    pub fn record_query_duration(&self, sort: &str, result: &str, duration_seconds: f64) {
        self.query_duration_seconds
            .with_label_values(&[sort, result])
            .observe(duration_seconds);
    }

    pub fn record_index_operation_duration(
        &self,
        operation: &str,
        result: &str,
        duration_seconds: f64,
    ) {
        self.index_operation_duration_seconds
            .with_label_values(&[operation, result])
            .observe(duration_seconds);
    }

    pub fn observe_candidates(&self, sort: &str, count: usize) {
        self.candidates_per_query
            .with_label_values(&[sort])
            .observe(count as f64);
    }

    pub fn observe_results(&self, sort: &str, count: usize) {
        self.results_per_query
            .with_label_values(&[sort])
            .observe(count as f64);
    }

    pub fn record_candidate_drop(&self, reason: &str, count: usize) {
        if count == 0 {
            return;
        }
        self.candidates_dropped_total
            .with_label_values(&[reason])
            .inc_by(count as u64);
    }

    pub fn record_index_documents(&self, operation: &str, result: &str, count: usize) {
        if count == 0 {
            return;
        }
        self.index_documents_total
            .with_label_values(&[operation, result])
            .inc_by(count as u64);
    }

    pub fn record_reindex(&self, result: &str, duration_seconds: f64, document_count: usize) {
        self.reindex_duration_seconds
            .with_label_values(&[result])
            .observe(duration_seconds);
        if document_count > 0 {
            self.reindex_documents_total
                .with_label_values(&[result])
                .inc_by(document_count as u64);
        }
        if result == "success" {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs() as i64)
                .unwrap_or_default();
            self.reindex_last_success_timestamp_seconds.set(timestamp);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_search_metrics_render_expected_values() {
        let registry = Registry::new();
        let metrics = MessageSearchMetrics::new(&registry);
        metrics.record_index_operation("upsert", "success");
        metrics.record_query("relevance", "failure");
        metrics.record_query_duration("relevance", "success", 0.42);
        metrics.record_index_operation_duration("upsert", "success", 1.25);
        metrics.observe_candidates("relevance", 20);
        metrics.observe_results("relevance", 18);
        metrics.record_candidate_drop("stale_version", 2);
        metrics.record_index_documents("upsert", "success", 1);
        metrics.record_reindex("success", 3.5, 500);

        let rendered = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(rendered.contains(
            "message_search_index_operations_total{operation=\"upsert\",result=\"success\"} 1"
        ));
        assert!(rendered
            .contains("message_search_queries_total{result=\"failure\",sort=\"relevance\"} 1"));
        assert!(rendered.contains(
            "message_search_query_duration_seconds_sum{result=\"success\",sort=\"relevance\"} 0.42"
        ));
        assert!(rendered.contains(
            "message_search_index_operation_duration_seconds_sum{operation=\"upsert\",result=\"success\"} 1.25"
        ));
        assert!(rendered.contains("message_search_candidates_per_query_sum{sort=\"relevance\"} 20"));
        assert!(rendered.contains("message_search_results_per_query_sum{sort=\"relevance\"} 18"));
        assert!(rendered
            .contains("message_search_candidates_dropped_total{reason=\"stale_version\"} 2"));
        assert!(rendered.contains(
            "message_search_index_documents_total{operation=\"upsert\",result=\"success\"} 1"
        ));
        assert!(rendered
            .contains("message_search_reindex_duration_seconds_sum{result=\"success\"} 3.5"));
        assert!(rendered.contains("message_search_reindex_documents_total{result=\"success\"} 500"));
        assert!(rendered.contains("message_search_reindex_last_success_timestamp_seconds"));
    }
}
