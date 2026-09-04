use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use diesel::prelude::*;
use diesel::PgConnection;

use crate::errors::AppError;
use crate::models::FriendAddVerificationMode;
use crate::schema::user_extra;
use crate::state::DbPool;

/// Revocation lag: a generation bump on one instance is honoured by every other
/// instance within this window. See docs/auth-provider/README.md#hot-path-generation-check.
const CACHE_TTL: Duration = Duration::from_secs(30);
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
        self.store(uid, generation);
        Ok(generation)
    }

    pub fn stored(&self, conn: &mut PgConnection, uid: i32) -> Result<i32, AppError> {
        let generation = load(conn, uid)?;
        self.store(uid, generation);
        Ok(generation)
    }

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
            ))
            .on_conflict(user_extra::uid)
            .do_update()
            .set(user_extra::token_gen.eq(user_extra::token_gen + 1))
            .returning(user_extra::token_gen)
            .get_result::<i32>(conn)?;
        self.store(uid, generation);
        Ok(generation)
    }

    fn store(&self, uid: i32, generation: i32) {
        self.cache.insert(
            uid,
            CachedGeneration {
                generation,
                cached_at: Instant::now(),
            },
        );
        self.prune_stale();
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
