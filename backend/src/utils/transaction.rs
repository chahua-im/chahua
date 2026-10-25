use diesel::connection::{AnsiTransactionManager, TransactionManager};
use diesel::PgConnection;

use crate::errors::AppError;

/// A Diesel-managed transaction that can span async work. Dropping the guard
/// rolls back, including when the enclosing request future is cancelled.
pub(crate) struct AsyncTransaction<'a> {
    conn: &'a mut PgConnection,
    finished: bool,
}

impl<'a> AsyncTransaction<'a> {
    pub(crate) fn begin(conn: &'a mut PgConnection) -> Result<Self, AppError> {
        AnsiTransactionManager::begin_transaction(conn)?;
        Ok(Self {
            conn,
            finished: false,
        })
    }

    pub(crate) fn connection(&mut self) -> &mut PgConnection {
        self.conn
    }

    pub(crate) fn finish<T>(mut self, result: Result<T, AppError>) -> Result<T, AppError> {
        match result {
            Ok(value) => {
                // Diesel handles commit failures and tracks broken/open transaction
                // state so r2d2 cannot reuse a connection whose cleanup failed.
                let committed = AnsiTransactionManager::commit_transaction(self.conn);
                self.finished = true;
                committed?;
                Ok(value)
            }
            Err(error) => match self.rollback() {
                Ok(()) | Err(diesel::result::Error::BrokenTransactionManager) => Err(error),
                Err(rollback_error) => Err(rollback_error.into()),
            },
        }
    }

    fn rollback(&mut self) -> diesel::QueryResult<()> {
        self.finished = true;
        let result = AnsiTransactionManager::rollback_transaction(self.conn);
        if let Err(error) = &result {
            tracing::error!(?error, "failed to roll back async database transaction");
        }
        result
    }
}

impl Drop for AsyncTransaction<'_> {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.rollback();
        }
    }
}

#[cfg(test)]
mod tests;
