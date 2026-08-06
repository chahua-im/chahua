use prometheus::{
    register_histogram_vec_with_registry, register_int_counter_vec_with_registry, HistogramVec,
    IntCounterVec, Registry,
};

pub(crate) struct AudioTranscodeMetrics {
    source_total: IntCounterVec,
    jobs_total: IntCounterVec,
    job_duration_seconds: HistogramVec,
}

impl AudioTranscodeMetrics {
    pub(crate) fn new(registry: &Registry) -> Self {
        let source_total = register_int_counter_vec_with_registry!(
            "audio_transcode_source_total",
            "Total number of audio transcode jobs by normalized source media type",
            &["content_type"],
            registry
        )
        .expect("audio_transcode_source_total registration should succeed");
        let jobs_total = register_int_counter_vec_with_registry!(
            "audio_transcode_jobs_total",
            "Total number of audio transcode jobs processed",
            &["result"],
            registry
        )
        .expect("audio_transcode_jobs_total registration should succeed");
        let job_duration_seconds = register_histogram_vec_with_registry!(
            "audio_transcode_job_duration_seconds",
            "Audio transcode job runtime in seconds",
            &["result"],
            vec![0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0],
            registry
        )
        .expect("audio_transcode_job_duration_seconds registration should succeed");
        jobs_total.with_label_values(&["success"]);
        jobs_total.with_label_values(&["failure"]);
        job_duration_seconds.with_label_values(&["success"]);
        job_duration_seconds.with_label_values(&["failure"]);

        Self {
            source_total,
            jobs_total,
            job_duration_seconds,
        }
    }

    pub(crate) fn record_source(&self, content_type: &str) {
        let normalized = normalize_metric_content_type(content_type);
        self.source_total
            .with_label_values(&[normalized.as_str()])
            .inc();
    }

    pub(crate) fn record_job(&self, result: &str, duration_seconds: f64) {
        self.jobs_total.with_label_values(&[result]).inc();
        self.job_duration_seconds
            .with_label_values(&[result])
            .observe(duration_seconds);
    }
}

fn normalize_metric_content_type(content_type: &str) -> String {
    let normalized = content_type
        .split(';')
        .next()
        .unwrap_or("unknown")
        .trim()
        .to_ascii_lowercase();

    match normalized.as_str() {
        "" => "unknown".to_string(),
        "audio/ogg" => "audio/ogg".to_string(),
        "audio/mp4" => "audio/mp4".to_string(),
        "audio/mpeg" => "audio/mpeg".to_string(),
        "audio/webm" => "audio/webm".to_string(),
        "audio/wav" | "audio/x-wav" => "audio/wav".to_string(),
        "audio/aac" | "audio/aacp" => "audio/aac".to_string(),
        "audio/flac" => "audio/flac".to_string(),
        value if value.starts_with("audio/") => "other".to_string(),
        _ => "unknown".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_transcode_metrics_render_expected_values() {
        let registry = Registry::new();
        let metrics = AudioTranscodeMetrics::new(&registry);
        metrics.record_source("audio/ogg");
        metrics.record_job("failure", 1.5);

        let rendered = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(rendered.contains("audio_transcode_source_total{content_type=\"audio/ogg\"} 1"));
        assert!(rendered.contains("audio_transcode_jobs_total{result=\"failure\"} 1"));
        assert!(
            rendered.contains("audio_transcode_job_duration_seconds_sum{result=\"failure\"} 1.5")
        );
    }

    #[test]
    fn audio_transcode_source_metric_normalizes_content_type() {
        let registry = Registry::new();
        let metrics = AudioTranscodeMetrics::new(&registry);

        metrics.record_source("Audio/Ogg;codecs=opus");
        metrics.record_source("audio/x-custom-thing");

        let rendered = crate::metrics::encode(&registry).expect("metrics should render");
        assert!(rendered.contains("audio_transcode_source_total{content_type=\"audio/ogg\"} 1"));
        assert!(rendered.contains("audio_transcode_source_total{content_type=\"other\"} 1"));
    }
}
