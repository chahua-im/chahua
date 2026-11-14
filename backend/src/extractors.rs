use std::future::Future;

use axum::extract::{FromRef, FromRequestParts};
use diesel::r2d2::{ConnectionManager, PooledConnection};
use diesel::PgConnection;

use crate::errors::AppError;
use crate::state::DbPool;

/// Request-scoped access to the synchronous database through a blocking worker.
/// Extraction does not acquire a connection; decoding the request body therefore
/// cannot hold a pool connection. Connections are only exposed inside `run`.
pub struct DbConn(DbPool);

impl DbConn {
    /// Runs the complete application operation, including transaction and
    /// post-commit work, off the async executor. Existing application operations
    /// may await other services while retaining their synchronous connection.
    pub async fn run<T, F, Fut>(self, operation: F) -> Result<T, AppError>
    where
        F: FnOnce(PooledConnection<ConnectionManager<PgConnection>>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, AppError>>,
        T: Send + 'static,
    {
        tokio::task::spawn_blocking(move || {
            let conn = self.0.get()?;
            futures::executor::block_on(operation(conn))
        })
        .await
        .map_err(|error| {
            tracing::error!(?error, "database operation worker failed");
            AppError::Internal("Database operation worker failed")
        })?
    }
}

impl<S> FromRequestParts<S> for DbConn
where
    DbPool: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(
        _parts: &mut axum::http::request::Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        Ok(Self(DbPool::from_ref(state)))
    }
}
