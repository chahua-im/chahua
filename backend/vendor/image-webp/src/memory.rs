use std::{
    mem::size_of,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

use crate::decoder::DecodingError;

/// Shared cumulative allocation allowance for one decode. Keeping reservations
/// until the decode ends is deliberately stricter than peak live memory and
/// prevents malformed bitstreams from growing intermediate entropy structures.
#[derive(Clone, Debug)]
pub(crate) struct MemoryBudget(Arc<AtomicUsize>);

impl MemoryBudget {
    pub(crate) fn unlimited() -> Self {
        Self(Arc::new(AtomicUsize::new(usize::MAX)))
    }
    pub(crate) fn reset(&self, bytes: usize) {
        self.0.store(bytes, Ordering::Relaxed);
    }
    pub(crate) fn reserve<T>(&self, count: usize) -> Result<(), DecodingError> {
        let bytes = count
            .checked_mul(size_of::<T>())
            .ok_or(DecodingError::MemoryLimitExceeded)?;
        self.0
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |left| {
                left.checked_sub(bytes)
            })
            .map(|_| ())
            .map_err(|_| DecodingError::MemoryLimitExceeded)
    }
    pub(crate) fn remaining(&self) -> usize {
        self.0.load(Ordering::Relaxed)
    }
}
