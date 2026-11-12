use ferroid::{
    define_snowflake_id,
    futures::SnowflakeGeneratorAsyncTokioExt,
    generator::LockSnowflakeGenerator,
    time::{MonotonicClock, UNIX_EPOCH},
};

define_snowflake_id!(
    ChahuaId,
    u64,
    reserved: 1,
    timestamp: 47,
    machine_id: 4,
    sequence: 12
);

pub type IdGen = LockSnowflakeGenerator<ChahuaId, MonotonicClock>;

/// Create a shared snowflake ID generator for the configured node.
pub fn new_generator(node_id: u64) -> IdGen {
    LockSnowflakeGenerator::new(node_id, MonotonicClock::with_epoch(UNIX_EPOCH))
}

/// Generate next snowflake id as i64 (for gid, message id, attachment_id).
pub async fn next_id(gen: &IdGen) -> Result<i64, ferroid::generator::Error> {
    let id: ChahuaId = gen.try_next_id_async().await?;
    Ok(id.to_raw() as i64)
}

/// Generate next gid (group/chat id).
pub async fn next_gid(gen: &IdGen) -> Result<i64, ferroid::generator::Error> {
    next_id(gen).await
}

/// Generate next message id.
pub async fn next_message_id(gen: &IdGen) -> Result<i64, ferroid::generator::Error> {
    next_id(gen).await
}
