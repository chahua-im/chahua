//! Resolution of Discuz user avatars.
//!
//! Avatars live on a filesystem tree that Discuz writes and a web server mirrors
//! at a public URL. Cache filesystem results, including placeholders, for 60
//! seconds while using the file mtime to build a cache-busting URL.

mod metrics;
pub use metrics::AvatarMetrics;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use moka::sync::Cache;

use crate::config::DiscuzAvatarConfig;

const AVATAR_CACHE_CAPACITY: u64 = 1_000;
const AVATAR_CACHE_TTL: Duration = Duration::from_secs(60);

pub struct AvatarService {
    /// `None` disables avatar resolution entirely; every lookup returns empty.
    config: Option<Arc<DiscuzAvatarConfig>>,
    metrics: Arc<AvatarMetrics>,
    cache: Cache<i32, String>,
}

impl AvatarService {
    pub fn new(config: Option<Arc<DiscuzAvatarConfig>>, metrics: Arc<AvatarMetrics>) -> Self {
        Self {
            config,
            metrics,
            cache: Cache::builder()
                .max_capacity(AVATAR_CACHE_CAPACITY)
                .time_to_live(AVATAR_CACHE_TTL)
                .build(),
        }
    }

    /// Maps each requested uid to its avatar URL. Returns an empty map when
    /// avatar resolution is not configured.
    pub fn lookup(&self, uids: &[i32]) -> HashMap<i32, Option<String>> {
        let Some(config) = self.config.as_ref() else {
            return HashMap::new();
        };

        let start = Instant::now();
        let mut fs_duration_seconds = 0.0;
        let mut map = HashMap::with_capacity(uids.len());
        for &uid in uids {
            let entry = self.cache.get_with(uid, || {
                let rel = avatar_relative_path(uid);
                let full_path = format!("{}/{}", config.path, rel);
                let fs_start = Instant::now();
                let metadata = std::fs::metadata(&full_path);
                fs_duration_seconds += fs_start.elapsed().as_secs_f64();
                metadata
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| format!("{}/{}?ts={}", config.public_url, rel, d.as_secs()))
                    .unwrap_or_else(|| format!("{}/noavatar.svg", config.public_url))
            });
            map.insert(uid, Some(entry));
        }
        self.metrics.record_lookup(
            uids.len(),
            start.elapsed().as_secs_f64(),
            fs_duration_seconds,
        );
        map
    }
}

/// Discuz shards avatars by zero-padded uid: `001/23/45/67_avatar_middle.jpg`.
fn avatar_relative_path(uid: i32) -> String {
    let padded = format!("{:0>9}", uid);
    format!(
        "{}/{}/{}/{}_avatar_middle.jpg",
        &padded[0..3],
        &padded[3..5],
        &padded[5..7],
        &padded[7..9]
    )
}

#[cfg(test)]
mod tests;
