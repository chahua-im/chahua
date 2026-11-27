//! Real service composition for RPC session tests. Every primary table is a
//! connection-local copy, so admitted transactions can commit normally without
//! modifying another test's fixtures. Provider replicas remain read-only.

use std::sync::Arc;

use diesel::{connection::SimpleConnection, prelude::*, r2d2::ConnectionManager};

use crate::{
    config::AppConfig,
    metrics::Metrics,
    services,
    state::{AppServices, DbPool},
    AppState,
};

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
    #[diesel(sql_type = diesel::sql_types::Text)]
    qualified_name: String,
}

#[derive(QueryableByName)]
struct TriggerDefinition {
    #[diesel(sql_type = diesel::sql_types::Text)]
    name: String,
}

impl diesel::r2d2::CustomizeConnection<PgConnection, diesel::r2d2::Error> for IsolatedTables {
    fn on_acquire(&self, connection: &mut PgConnection) -> Result<(), diesel::r2d2::Error> {
        crate::metrics::queries::attach_connection_metrics(connection, self.0.clone());
        let names = diesel::sql_query(
            "SELECT tablename::text AS name, format('%I.%I', schemaname, tablename) AS qualified_name \
             FROM pg_catalog.pg_tables \
             WHERE schemaname = current_schema() AND tablename <> '__diesel_schema_migrations' \
             ORDER BY tablename",
        )
        .load::<TableName>(connection)
        .map_err(diesel::r2d2::Error::QueryError)?;
        for table in names {
            let name = table.name.replace('"', "\"\"");
            connection
                .batch_execute(&format!(
                    "CREATE TEMP TABLE \"{name}\" (LIKE {source} INCLUDING ALL); \
                     INSERT INTO pg_temp.\"{name}\" SELECT * FROM {source};",
                    source = table.qualified_name,
                ))
                .map_err(diesel::r2d2::Error::QueryError)?;
        }
        // LIKE does not copy triggers. Point the production definitions at the
        // isolated tables, with the same transition tables and capture function.
        let triggers = diesel::sql_query(
            "SELECT regexp_replace(pg_get_triggerdef(t.oid), ' ON \\S+', \
                    format(' ON pg_temp.%I', c.relname)) AS name \
             FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = current_schema() AND \
                   (t.tgname LIKE 'list_sync_%' OR t.tgname IN \
                    ('messages_sync_insert', 'messages_sync_update', \
                     'message_reactions_sync_insert', 'message_reactions_sync_delete', 'message_sync_flush'))",
        )
        .load::<TriggerDefinition>(connection)
        .map_err(diesel::r2d2::Error::QueryError)?;
        for trigger in triggers {
            connection
                .batch_execute(&trigger.name)
                .map_err(diesel::r2d2::Error::QueryError)?;
        }
        Ok(())
    }
}

/// Requires the normally migrated and bootstrap-seeded isolated smoke DB.
/// The single retained connection keeps temporary tables consistent across
/// service calls; concurrency/admission tests use explicit operation barriers.
pub(crate) async fn services() -> Option<AppState> {
    let Ok(database_url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
        eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
        return None;
    };
    let mut config = AppConfig::from_env(crate::config::ConfigFile::from_env());
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
    let media = crate::bootstrap::build_media_store(&config).await;
    let avatars = Arc::new(services::avatars::AvatarService::new(
        config.avatars.clone(),
        metrics.avatars.clone(),
    ));
    let link_previews = services::link_previews::LinkPreviewService::start(
        db.clone(),
        media.clone(),
        avatars.clone(),
        ws_registry.clone(),
        config.link_previews.clone(),
    );
    let id_gen = Arc::new(crate::utils::ids::new_generator(config.node_id));
    let authz_service = services::authz::AuthorizationService::start();
    let push_service = services::push::PushService::start(
        db.clone(),
        ws_registry.clone(),
        metrics.push.clone(),
        unread_service.clone(),
        config
            .push
            .clone()
            .expect("push configuration for RPC services"),
    );
    let background_service = services::background::BackgroundService::start(
        db.clone(),
        ws_registry.clone(),
        metrics.background.clone(),
        None,
    );
    let auth_token_service = Arc::new(services::auth_token::AuthTokenService::new(
        &config.auth.jwt_signing_key,
    ));
    let token_generation = services::token_generation::TokenGenerationService::start();
    let restricted_user_group_ids: Arc<[i32]> = config.restricted_user_group_ids.as_slice().into();
    let message_writer = Arc::new(services::messages::MessageWriter {
        id_gen: id_gen.clone(),
        media: media.clone(),
        avatars: avatars.clone(),
        metrics: metrics.clone(),
    });
    let social = Arc::new(services::social::SocialService {
        message_writer: message_writer.clone(),
        ws_registry: ws_registry.clone(),
        presence_service: presence_service.clone(),
        push_service: push_service.clone(),
    });
    Some(AppState::new(AppServices {
        messages: Arc::new(services::api::chats::messages::MessagesService {
            restricted_user_group_ids: restricted_user_group_ids.clone(),
            message_writer: message_writer.clone(),
            authz_service: authz_service.clone(),
            ws_registry: ws_registry.clone(),
            push_service: push_service.clone(),
            message_search: None,
            link_previews: link_previews.clone(),
        }),
        friends: Arc::new(services::api::friends::FriendsService {
            authz_service: authz_service.clone(),
            avatars: avatars.clone(),
            ws_registry: ws_registry.clone(),
            social,
        }),
        invites: Arc::new(services::api::invites::InvitesService {
            restricted_user_group_ids: restricted_user_group_ids.clone(),
            writer: message_writer.clone(),
            ws_registry: ws_registry.clone(),
            push_service: push_service.clone(),
        }),
        members: Arc::new(services::api::members::MembersService {
            writer: message_writer.clone(),
            ws_registry: ws_registry.clone(),
            push_service: push_service.clone(),
            background_service: background_service.clone(),
        }),
        pins: Arc::new(services::api::pins::PinsService {
            writer: message_writer,
            ws_registry: ws_registry.clone(),
            push_service: push_service.clone(),
        }),
        reactions: Arc::new(services::api::chats::reactions::ReactionsService {
            restricted_user_group_ids,
            avatars: avatars.clone(),
            registry: ws_registry.clone(),
        }),
        dev_sessions: Arc::new(services::api::auth::DevSessionsService {
            config: config.clone(),
            auth_token_service: auth_token_service.clone(),
            token_generation: token_generation.clone(),
            db: db.clone(),
        }),
        db,
        id_gen,
        media,
        avatars,
        link_previews,
        authz_service,
        ws_registry,
        presence_service,
        push_service,
        unread_service,
        client_tracking,
        background_service,
        message_search: None,
        auth_token_service,
        token_generation,
        metrics,
        config,
    }))
}
