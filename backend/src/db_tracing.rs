use diesel::connection::{Instrumentation, InstrumentationEvent};
use std::time::Instant;

const SLOW_QUERY_THRESHOLD_MS: u128 = 10;

pub struct TracingInstrumentation {
    query_start: Option<Instant>,
}

impl TracingInstrumentation {
    fn new() -> Self {
        Self { query_start: None }
    }
}

impl Instrumentation for TracingInstrumentation {
    fn on_connection_event(&mut self, event: InstrumentationEvent<'_>) {
        match event {
            InstrumentationEvent::StartQuery { query, .. } => {
                self.query_start = Some(Instant::now());
                tracing::trace!(sql = %query, "db query");
            }
            InstrumentationEvent::FinishQuery {
                query,
                error: Some(err),
                ..
            } => {
                let elapsed_ms = self.query_start.take().map(|s| s.elapsed().as_millis());
                tracing::error!(sql = %query, error = %err, elapsed_ms = ?elapsed_ms, "db query failed");
            }
            InstrumentationEvent::FinishQuery { query, .. } => {
                if let Some(elapsed) = self.query_start.take().map(|s| s.elapsed()) {
                    let ms = elapsed.as_millis();
                    if ms >= SLOW_QUERY_THRESHOLD_MS {
                        tracing::warn!(sql = %query, elapsed_ms = ms, "slow query");
                    }
                }
            }
            _ => {}
        }
    }
}

/// Call once at startup. Only installs instrumentation in debug builds.
pub fn install() {
    {
        diesel::connection::set_default_instrumentation(|| {
            Some(Box::new(TracingInstrumentation::new()))
        })
        .expect("failed to set diesel instrumentation");
    }
}
