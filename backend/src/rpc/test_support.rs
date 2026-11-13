//! Real service composition for RPC session tests. Every primary table is a
//! connection-local copy, so admitted transactions can commit normally without
//! modifying another test's fixtures. Provider replicas remain read-only.

use std::sync::Arc;

use diesel::{connection::SimpleConnection, prelude::*, r2d2::ConnectionManager};

use super::{RpcServiceHandles, RpcServices};
use crate::{config::AppConfig, metrics::Metrics, services, state::DbPool};

struct IsolatedTables(Arc<crate::metrics::queries::QueryMetrics>);

impl std::fmt::Debug for IsolatedTables {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IsolatedTables").finish_non_exhaustive()
    }
}

#[derive(QueryableByName)]
struct TableName {
    #[diesel(sql_type = diesel::sql_types::Text)]
    name: String,
}

impl diesel::r2d2::CustomizeConnection<PgConnection, diesel::r2d2::Error> for IsolatedTables {
    fn on_acquire(&self, connection: &mut PgConnection) -> Result<(), diesel::r2d2::Error> {
        crate::metrics::queries::attach_connection_metrics(connection, self.0.clone());
        let names = diesel::sql_query(
            "SELECT tablename::text AS name FROM pg_catalog.pg_tables \
             WHERE schemaname = 'public' AND tablename <> '__diesel_schema_migrations' \
             ORDER BY tablename",
        )
        .load::<TableName>(connection)
        .map_err(diesel::r2d2::Error::QueryError)?;
        for table in names {
            let name = table.name.replace('"', "\"\"");
            connection
                .batch_execute(&format!(
                    "CREATE TEMP TABLE \"{name}\" (LIKE public.\"{name}\" INCLUDING ALL); \
                 INSERT INTO pg_temp.\"{name}\" SELECT * FROM public.\"{name}\";",
                ))
                .map_err(diesel::r2d2::Error::QueryError)?;
        }
        Ok(())
    }
}

/// Requires the normally migrated and bootstrap-seeded isolated smoke DB.
/// The single retained connection keeps temporary tables consistent across
/// service calls; concurrency/admission tests use explicit operation barriers.
pub(crate) async fn services() -> Option<RpcServices> {
    let Ok(database_url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return None;
    };
    let mut config = AppConfig::from_env();
    config.database_url = database_url.clone();
    let config = Arc::new(config);
    let metrics = Arc::new(Metrics::new());
    let db = DbPool::builder()
        .max_size(1)
        .connection_customizer(Box::new(IsolatedTables(metrics.queries.clone())))
        .build(ConnectionManager::<PgConnection>::new(database_url))
        .expect("connect isolated RPC test tables");
    let ws_registry = Arc::new(services::ws_registry::ConnectionRegistry::new(
        metrics.ws.clone(),
    ));
    let unread_service = Arc::new(services::unread::UnreadService::new());
    let client_tracking = services::client_tracking::ClientTrackingService::start(
        db.clone(),
        metrics.client_tracking.clone(),
    );
    let presence_service = Arc::new(services::presence::PresenceSnapshotService::new(
        db.clone(),
        ws_registry.clone(),
        metrics.presence.clone(),
        client_tracking.last_seen.clone(),
    ));
    let media = crate::build_media_store(&config).await;
    let avatars = Arc::new(services::avatars::AvatarService::new(
        config.avatars.clone(),
        metrics.avatars.clone(),
    ));
    let link_previews = services::link_previews::LinkPreviewService::start(
        db.clone(),
        media.clone(),
        avatars.clone(),
        ws_registry.clone(),
    );
    Some(RpcServices::new(RpcServiceHandles {
        db: db.clone(),
        id_gen: Arc::new(crate::utils::ids::new_generator()),
        media,
        avatars,
        link_previews,
        authz_service: services::authz::AuthorizationService::start(),
        ws_registry: ws_registry.clone(),
        presence_service,
        push_service: services::push::PushService::start(
            db.clone(),
            ws_registry.clone(),
            metrics.push.clone(),
            unread_service.clone(),
        ),
        unread_service,
        client_tracking,
        background_service: services::background::BackgroundService::start(
            db,
            ws_registry,
            metrics.background.clone(),
            None,
        ),
        message_search: None,
        auth_token_service: Arc::new(services::auth_token::AuthTokenService::new(
            &config.auth.jwt_signing_key,
        )),
        token_generation: services::token_generation::TokenGenerationService::start(),
        metrics,
        config,
    }))
}
