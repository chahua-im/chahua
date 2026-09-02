use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel::PgConnection;
use serde::Deserialize;
use std::collections::{BTreeSet, HashMap};
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::dto::service_tokens::{
    CreateServiceTokenRequest, CreateServiceTokenResponse, ListServiceTokensResponse,
    RotateServiceTokenResponse, ServiceTokenResponse,
};
use crate::errors::AppError;
use crate::extractors::DbConn;
use crate::models::{NewPolicyAssignment, NewServiceToken, PolicySubjectType, ServiceToken};
use crate::schema::{policies, policy_assignments, service_tokens};
use crate::services::authz::{Action as AuthzAction, Resource as AuthzResource};
use crate::services::service_tokens as service_token_service;
use crate::utils::{auth::CurrentUid, ids};
use crate::AppState;

const MAX_SERVICE_TOKEN_NAME_LEN: usize = 120;

#[derive(Debug, Deserialize, utoipa::IntoParams)]
struct ServiceTokenPath {
    #[serde(deserialize_with = "crate::serde_i64_string::deserialize")]
    #[param(value_type = String)]
    id: i64,
}

#[utoipa::path(
    post,
    path = "/",
    tag = "service-tokens",
    request_body = CreateServiceTokenRequest,
    responses(
        (status = 201, description = "Service token created", body = CreateServiceTokenResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn post_service_token(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
    Json(body): Json<CreateServiceTokenRequest>,
) -> Result<(StatusCode, Json<CreateServiceTokenResponse>), AppError> {
    let conn = &mut *conn;
    require_manage_permission(conn, &state, uid)?;

    let name = normalize_name(&body.name)?;
    let policy_ids = parse_policy_ids(&body.policy_ids)?;
    ensure_policies_exist(conn, &policy_ids)?;

    let service_token_id = ids::next_id(state.id_gen.as_ref()).await.map_err(|e| {
        tracing::error!("next_id for service token: {:?}", e);
        AppError::Internal("ID generation failed")
    })?;
    let assignment_ids =
        next_ids(&state, policy_ids.len(), "service token policy assignment").await?;
    let credential =
        service_token_service::generate_credential(&state.config.auth.service_token_hash_key)?;

    let now = Utc::now();
    let new_token = NewServiceToken {
        id: service_token_id,
        token: credential.token.clone(),
        secret_hash: credential.secret_hash,
        name,
        created_by_uid: uid,
        revoked_at: None,
        last_used_at: None,
        metadata: serde_json::json!({}),
        created_at: now,
        updated_at: now,
    };

    conn.transaction::<(), AppError, _>(|conn| {
        diesel::insert_into(service_tokens::table)
            .values(&new_token)
            .execute(conn)?;

        insert_policy_assignments(conn, service_token_id, &policy_ids, &assignment_ids, now)?;
        Ok(())
    })?;

    let row = service_tokens::table
        .filter(service_tokens::id.eq(service_token_id))
        .select(ServiceToken::as_select())
        .first::<ServiceToken>(conn)?;

    tracing::info!(
        service_token_id,
        created_by_uid = uid,
        "service token created"
    );

    Ok((
        StatusCode::CREATED,
        Json(CreateServiceTokenResponse {
            service_token: service_token_to_response(row, policy_ids_to_strings(policy_ids)),
            credential: credential.credential,
        }),
    ))
}

#[utoipa::path(
    get,
    path = "/",
    tag = "service-tokens",
    responses(
        (status = 200, description = "Service tokens", body = ListServiceTokensResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn get_service_tokens(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    mut conn: DbConn,
) -> Result<Json<ListServiceTokensResponse>, AppError> {
    let conn = &mut *conn;
    require_manage_permission(conn, &state, uid)?;

    let rows = service_tokens::table
        .order((service_tokens::created_at.desc(), service_tokens::id.desc()))
        .select(ServiceToken::as_select())
        .load::<ServiceToken>(conn)?;
    let token_ids: Vec<i64> = rows.iter().map(|row| row.id).collect();
    let policy_ids = load_policy_ids(conn, &token_ids)?;

    Ok(Json(ListServiceTokensResponse {
        service_tokens: rows
            .into_iter()
            .map(|row| {
                let policy_ids = policy_ids.get(&row.id).cloned().unwrap_or_default();
                service_token_to_response(row, policy_ids)
            })
            .collect(),
    }))
}

#[utoipa::path(
    delete,
    path = "/{id}",
    tag = "service-tokens",
    params(ServiceTokenPath),
    responses(
        (status = 204, description = "Service token revoked")
    ),
    security(("bearer_jwt" = []))
)]
async fn delete_service_token(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ServiceTokenPath { id }): Path<ServiceTokenPath>,
    mut conn: DbConn,
) -> Result<StatusCode, AppError> {
    let conn = &mut *conn;
    require_manage_permission(conn, &state, uid)?;

    let now = Utc::now();
    let affected = diesel::update(service_tokens::table.filter(service_tokens::id.eq(id)))
        .set((
            service_tokens::revoked_at.eq(Some(now)),
            service_tokens::updated_at.eq(now),
        ))
        .execute(conn)?;

    if affected == 0 {
        return Err(AppError::NotFound("Service token not found"));
    }

    tracing::info!(
        service_token_id = id,
        revoked_by_uid = uid,
        "service token revoked"
    );

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/{id}/rotate",
    tag = "service-tokens",
    params(ServiceTokenPath),
    responses(
        (status = 200, description = "Service token rotated", body = RotateServiceTokenResponse)
    ),
    security(("bearer_jwt" = []))
)]
async fn post_rotate_service_token(
    CurrentUid(uid): CurrentUid,
    State(state): State<AppState>,
    Path(ServiceTokenPath { id }): Path<ServiceTokenPath>,
    mut conn: DbConn,
) -> Result<Json<RotateServiceTokenResponse>, AppError> {
    let conn = &mut *conn;
    require_manage_permission(conn, &state, uid)?;

    let row = service_tokens::table
        .filter(service_tokens::id.eq(id))
        .select(ServiceToken::as_select())
        .first::<ServiceToken>(conn)
        .optional()?
        .ok_or(AppError::NotFound("Service token not found"))?;

    if row.revoked_at.is_some() {
        return Err(AppError::Gone("Service token revoked"));
    }

    let secret = service_token_service::generate_secret();
    let secret_hash = service_token_service::hash_secret(
        &state.config.auth.service_token_hash_key,
        &row.token,
        &secret,
    )?;
    let credential = format!(
        "{}{}_{}",
        service_token_service::TOKEN_PREFIX,
        row.token,
        secret
    );
    let now = Utc::now();

    let updated = diesel::update(service_tokens::table.filter(service_tokens::id.eq(id)))
        .set((
            service_tokens::secret_hash.eq(secret_hash),
            service_tokens::updated_at.eq(now),
        ))
        .returning(ServiceToken::as_returning())
        .get_result::<ServiceToken>(conn)?;
    let policy_ids = load_policy_ids(conn, &[id])?
        .remove(&id)
        .unwrap_or_default();

    tracing::info!(
        service_token_id = id,
        rotated_by_uid = uid,
        "service token rotated"
    );

    Ok(Json(RotateServiceTokenResponse {
        service_token: service_token_to_response(updated, policy_ids),
        credential,
    }))
}

pub fn router() -> OpenApiRouter<crate::AppState> {
    OpenApiRouter::new()
        .routes(routes!(post_service_token, get_service_tokens))
        .routes(routes!(delete_service_token, post_rotate_service_token))
}

fn require_manage_permission(
    conn: &mut PgConnection,
    state: &AppState,
    uid: i32,
) -> Result<(), AppError> {
    let can_manage = state.authz_service.has_permission(
        conn,
        uid,
        AuthzAction::ServiceTokenManage,
        AuthzResource::Global,
    )? || state.authz_service.has_permission(
        conn,
        uid,
        AuthzAction::PermissionAll,
        AuthzResource::Global,
    )?;

    if can_manage {
        Ok(())
    } else {
        Err(AppError::Forbidden("Permission required"))
    }
}

fn normalize_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("Name is required"));
    }
    if name.len() > MAX_SERVICE_TOKEN_NAME_LEN {
        return Err(AppError::BadRequest("Name is too long"));
    }
    Ok(name.to_string())
}

fn parse_policy_ids(raw_policy_ids: &[String]) -> Result<Vec<i64>, AppError> {
    let mut policy_ids = BTreeSet::new();
    for raw in raw_policy_ids {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err(AppError::BadRequest("Policy id is required"));
        }
        let policy_id = raw
            .parse::<i64>()
            .map_err(|_| AppError::BadRequest("Policy id is invalid"))?;
        policy_ids.insert(policy_id);
    }
    Ok(policy_ids.into_iter().collect())
}

fn ensure_policies_exist(conn: &mut PgConnection, policy_ids: &[i64]) -> Result<(), AppError> {
    if policy_ids.is_empty() {
        return Ok(());
    }

    let existing_count = policies::table
        .filter(policies::id.eq_any(policy_ids))
        .count()
        .get_result::<i64>(conn)?;

    if existing_count != policy_ids.len() as i64 {
        return Err(AppError::BadRequest("Policy id is invalid"));
    }

    Ok(())
}

async fn next_ids(
    state: &AppState,
    count: usize,
    label: &'static str,
) -> Result<Vec<i64>, AppError> {
    let mut ids_out = Vec::with_capacity(count);
    for _ in 0..count {
        let id = ids::next_id(state.id_gen.as_ref()).await.map_err(|e| {
            tracing::error!("next_id for {}: {:?}", label, e);
            AppError::Internal("ID generation failed")
        })?;
        ids_out.push(id);
    }
    Ok(ids_out)
}

fn insert_policy_assignments(
    conn: &mut PgConnection,
    service_token_id: i64,
    policy_ids: &[i64],
    assignment_ids: &[i64],
    now: DateTime<Utc>,
) -> Result<(), AppError> {
    if policy_ids.is_empty() {
        return Ok(());
    }

    let assignments: Vec<NewPolicyAssignment> = policy_ids
        .iter()
        .zip(assignment_ids)
        .map(|(policy_id, assignment_id)| NewPolicyAssignment {
            id: *assignment_id,
            subject_type: PolicySubjectType::ServiceToken,
            subject_id: service_token_id,
            policy_id: *policy_id,
            created_at: now,
            updated_at: now,
        })
        .collect();

    diesel::insert_into(policy_assignments::table)
        .values(&assignments)
        .execute(conn)?;

    Ok(())
}

fn load_policy_ids(
    conn: &mut PgConnection,
    service_token_ids: &[i64],
) -> Result<HashMap<i64, Vec<String>>, AppError> {
    if service_token_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let rows: Vec<(i64, i64)> = policy_assignments::table
        .filter(
            policy_assignments::subject_type
                .eq(PolicySubjectType::ServiceToken)
                .and(policy_assignments::subject_id.eq_any(service_token_ids)),
        )
        .select((
            policy_assignments::subject_id,
            policy_assignments::policy_id,
        ))
        .load(conn)?;

    let mut result: HashMap<i64, Vec<String>> = HashMap::new();
    for (service_token_id, policy_id) in rows {
        result
            .entry(service_token_id)
            .or_default()
            .push(policy_id.to_string());
    }
    for values in result.values_mut() {
        values.sort();
    }

    Ok(result)
}

fn policy_ids_to_strings(policy_ids: Vec<i64>) -> Vec<String> {
    policy_ids
        .into_iter()
        .map(|policy_id| policy_id.to_string())
        .collect()
}

fn service_token_to_response(row: ServiceToken, policy_ids: Vec<String>) -> ServiceTokenResponse {
    ServiceTokenResponse {
        id: row.id,
        token: row.token,
        name: row.name,
        created_by_uid: row.created_by_uid,
        revoked_at: row.revoked_at,
        last_used_at: row.last_used_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        policy_ids,
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_name, parse_policy_ids};
    use crate::errors::AppError;

    #[test]
    fn parse_policy_ids_deduplicates_and_sorts() {
        let ids = parse_policy_ids(&["9".to_string(), "3".to_string(), "9".to_string()]).unwrap();
        assert_eq!(ids, vec![3, 9]);
    }

    #[test]
    fn normalize_name_rejects_blank() {
        let result = normalize_name("   ");
        assert!(matches!(
            result,
            Err(AppError::BadRequest("Name is required"))
        ));
    }
}
