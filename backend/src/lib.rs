//! Backend application and protocol implementation.

mod bootstrap;
mod config;
mod constants;
mod db_tracing;
mod dto;
mod errors;
mod extractors;
mod handlers;
mod metrics;
mod models;
mod openapi;
mod rpc;
mod schema;
mod serde_i64_string;
mod services;
mod state;
mod utils;

pub use bootstrap::run;
pub(crate) use state::AppState;
