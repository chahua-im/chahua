//! Resolution of Discuz user avatars.
//!
//! Avatars live on a filesystem tree that Discuz writes and a web server mirrors
//! at a public URL. We stat each file to build a cache-busting URL from its
//! mtime, falling back to the shared placeholder when a user has no avatar.

mod metrics;
pub(crate) use metrics::AvatarMetrics;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Instant, UNIX_EPOCH};

use crate::config::DiscuzAvatarConfig;

pub(crate) struct AvatarService {
    /// `None` disables avatar resolution entirely; every lookup returns empty.
    config: Option<Arc<DiscuzAvatarConfig>>,
    metrics: Arc<AvatarMetrics>,
}

impl AvatarService {
    pub(crate) fn new(
        config: Option<Arc<DiscuzAvatarConfig>>,
        metrics: Arc<AvatarMetrics>,
    ) -> Self {
        Self { config, metrics }
    }

    /// Maps each requested uid to its avatar URL. Returns an empty map when
    /// avatar resolution is not configured.
    pub(crate) fn lookup(&self, uids: &[i32]) -> HashMap<i32, Option<String>> {
        let Some(config) = self.config.as_ref() else {
            return HashMap::new();
        };

        let start = Instant::now();
        let mut fs_duration_seconds = 0.0;
        let mut map = HashMap::with_capacity(uids.len());
        for &uid in uids {
            let rel = avatar_relative_path(uid);
            let full_path = format!("{}/{}", config.path, rel);
            let fs_start = Instant::now();
            let entry = std::fs::metadata(&full_path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| format!("{}/{}?ts={}", config.public_url, rel, d.as_secs()))
                .unwrap_or_else(|| format!("{}/noavatar.svg", config.public_url));
            fs_duration_seconds += fs_start.elapsed().as_secs_f64();
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
mod tests {
    use super::avatar_relative_path;

    #[test]
    fn shards_uid_into_discuz_directory_layout() {
        assert_eq!(
            avatar_relative_path(123_456_789),
            "123/45/67/89_avatar_middle.jpg"
        );
    }

    #[test]
    fn pads_short_uids_to_nine_digits() {
        assert_eq!(avatar_relative_path(42), "000/00/00/42_avatar_middle.jpg");
    }
}
