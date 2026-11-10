use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use diesel::prelude::*;
use diesel::PgConnection;

use crate::errors::AppError;
use crate::models::{FriendAddVerificationMode, PresenceVisibility};
use crate::schema::user_extra;
use crate::state::DbPool;

/// Local revocations update the cache immediately. Writes outside this process
/// are observed within this TTL; see docs/auth-provider/README.md#hot-path-generation-check.
const CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const PRUNE_THRESHOLD: usize = 4096;
const PRUNE_MAX_AGE: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Copy)]
struct CachedGeneration {
    generation: i32,
    cached_at: Instant,
}

/// Per-user session generation with a short-TTL in-process cache, read on every
/// authenticated request before a handler acquires its own DB connection.
#[derive(Default)]
pub struct TokenGenerationService {
    cache: DashMap<i32, CachedGeneration>,
}

impl TokenGenerationService {
    pub fn start() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn required_for(&self, pool: &DbPool, uid: i32) -> Result<i32, AppError> {
        if let Some(entry) = self.cache.get(&uid) {
            if entry.cached_at.elapsed() < CACHE_TTL {
                return Ok(entry.generation);
            }
        }

        let mut conn = pool.get()?;
        let generation = load(&mut conn, uid)?;
        Ok(self.store(uid, generation))
    }

    pub fn stored(&self, conn: &mut PgConnection, uid: i32) -> Result<i32, AppError> {
        let generation = load(conn, uid)?;
        Ok(self.store(uid, generation))
    }

    /// Call without an enclosing transaction so publication follows the commit.
    pub fn bump(&self, conn: &mut PgConnection, uid: i32) -> Result<i32, AppError> {
        let now = chrono::Utc::now().naive_utc();
        let generation = diesel::insert_into(user_extra::table)
            .values((
                user_extra::uid.eq(uid),
                user_extra::first_seen_at.eq(now),
                user_extra::last_seen_at.eq(now),
                user_extra::sticker_pack_order.eq(serde_json::json!([])),
                user_extra::verification_mode.eq(FriendAddVerificationMode::Direct),
                user_extra::token_gen.eq(1),
                user_extra::presence_visibility.eq(PresenceVisibility::Everyone),
            ))
            .on_conflict(user_extra::uid)
            .do_update()
            .set(user_extra::token_gen.eq(user_extra::token_gen + 1))
            .returning(user_extra::token_gen)
            .get_result::<i32>(conn)?;
        Ok(self.store(uid, generation))
    }

    fn store(&self, uid: i32, generation: i32) -> i32 {
        let observed = CachedGeneration {
            generation,
            cached_at: Instant::now(),
        };
        let current = {
            let mut entry = self.cache.entry(uid).or_insert(observed);
            // A lookup started before revocation can finish after it. Neither
            // its caller nor the cache may use that older generation.
            if generation >= entry.generation {
                *entry = observed;
            }
            entry.generation
        };
        self.prune_stale();
        current
    }

    fn prune_stale(&self) {
        if self.cache.len() < PRUNE_THRESHOLD {
            return;
        }

        self.cache
            .retain(|_, entry| entry.cached_at.elapsed() <= PRUNE_MAX_AGE);
    }
}

fn load(conn: &mut PgConnection, uid: i32) -> Result<i32, AppError> {
    Ok(user_extra::table
        .find(uid)
        .select(user_extra::token_gen)
        .first::<i32>(conn)
        .optional()?
        .unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::auth_token::{TokenVersion, VerifiedSession};
    use crate::services::authentication::{
        check_session_generation_cause, SessionGenerationFailure,
    };

    #[test]
    fn stale_refresh_cannot_reauthorize_a_revoked_session() {
        let service = TokenGenerationService::default();
        let pool = DbPool::builder()
            .max_size(1)
            .min_idle(Some(0))
            .build_unchecked(diesel::r2d2::ConnectionManager::<PgConnection>::new(
                "unused_generation_cache_test",
            ));
        service.store(17, 2);
        // A read started before revocation finishes after the newer generation.
        service.store(17, 1);
        let mut session = VerifiedSession {
            uid: 17,
            client_id: "generation-race".into(),
            generation: 1,
            version: TokenVersion::V2,
        };
        assert!(matches!(
            check_session_generation_cause(&session, &service, &pool),
            Err(SessionGenerationFailure::Revoked)
        ));
        session.generation = 2;
        assert!(check_session_generation_cause(&session, &service, &pool).is_ok());
    }

    #[test]
    fn stale_database_read_returns_the_newer_cached_generation() {
        use diesel::connection::SimpleConnection;
        use std::sync::atomic::{AtomicI32, Ordering};

        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        static NEXT_UID: AtomicI32 = AtomicI32::new(-938_512);
        let uid = NEXT_UID.fetch_sub(1, Ordering::Relaxed);
        let mut writer = PgConnection::establish(&url).unwrap();
        let mut reader = PgConnection::establish(&url).unwrap();
        let service = TokenGenerationService::default();
        let initial = service.bump(&mut writer, uid).unwrap();
        reader
            .batch_execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .unwrap();
        let snapshot = service.stored(&mut reader, uid).unwrap();
        let revoked = service.bump(&mut writer, uid).unwrap();
        let stale_result = service.stored(&mut reader, uid).unwrap();
        reader.batch_execute("ROLLBACK").unwrap();
        diesel::delete(user_extra::table.find(uid))
            .execute(&mut writer)
            .unwrap();

        assert_eq!(snapshot, initial);
        assert_eq!(revoked, initial + 1);
        assert_eq!(stale_result, revoked);
    }
}
