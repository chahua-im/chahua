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
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::thread;

    struct Fixture {
        root: PathBuf,
        service: AvatarService,
    }

    impl Fixture {
        fn new(capacity: u64, ttl: Duration) -> Self {
            let root = std::env::temp_dir().join(format!("avatar-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let config = DiscuzAvatarConfig {
                public_url: "https://example.test/avatar".to_owned(),
                path: root.to_str().unwrap().to_owned(),
            };
            let mut service = AvatarService::new(
                Some(Arc::new(config)),
                Arc::new(AvatarMetrics::new(&prometheus::Registry::new())),
            );
            service.cache = Cache::builder()
                .max_capacity(capacity)
                .time_to_live(ttl)
                .build();
            Self { root, service }
        }

        fn path(&self, uid: i32) -> PathBuf {
            self.root.join(avatar_relative_path(uid))
        }

        fn create_avatar(&self, uid: i32) {
            let path = self.path(uid);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"avatar").unwrap();
        }

        fn lookup(&self, uid: i32) -> String {
            self.service.lookup(&[uid]).remove(&uid).unwrap().unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }

    fn wait_for_change(fixture: &Fixture, uid: i32, old: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let value = fixture.lookup(uid);
            if value != old {
                return value;
            }
            assert!(Instant::now() < deadline, "cache entry did not expire");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn cached_results_stay_stable_when_files_change() {
        let fixture = Fixture::new(10, Duration::from_secs(60));
        let placeholder = fixture.lookup(1);
        fixture.create_avatar(1);
        assert_eq!(fixture.lookup(1), placeholder);

        fixture.create_avatar(2);
        let avatar = fixture.lookup(2);
        assert!(avatar.contains("?ts="));
        std::fs::remove_file(fixture.path(2)).unwrap();
        assert_eq!(fixture.lookup(2), avatar);
    }

    #[test]
    fn placeholders_and_avatars_expire_even_with_repeated_hits() {
        let fixture = Fixture::new(10, Duration::from_millis(150));
        let placeholder = fixture.lookup(1);
        fixture.create_avatar(1);
        assert!(wait_for_change(&fixture, 1, &placeholder).contains("?ts="));

        fixture.create_avatar(2);
        let avatar = fixture.lookup(2);
        std::fs::remove_file(fixture.path(2)).unwrap();
        assert_eq!(
            wait_for_change(&fixture, 2, &avatar),
            "https://example.test/avatar/noavatar.svg"
        );
    }

    #[test]
    fn capacity_pressure_reloads_an_evicted_or_rejected_entry() {
        let fixture = Fixture::new(1, Duration::from_secs(60));
        for uid in 1..=3 {
            fixture.lookup(uid);
            fixture.service.cache.run_pending_tasks();
        }
        assert!(fixture.service.cache.entry_count() <= 1);
        let absent = (1..=3)
            .find(|uid| !fixture.service.cache.contains_key(uid))
            .unwrap();
        fixture.create_avatar(absent);
        assert!(fixture.lookup(absent).contains("?ts="));
    }

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
