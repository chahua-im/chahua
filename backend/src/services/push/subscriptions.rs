use diesel::prelude::*;
use diesel::PgConnection;

use super::delivery::DeliveryFailure;
use crate::models::{NewPushSubscription, PushEnvironment, PushProvider, PushSubscription};
use crate::schema::push_subscriptions;

pub(crate) enum SubscriptionIdentity<'a> {
    WebPush(&'a str),
    Apns {
        device_token: &'a str,
        environment: PushEnvironment,
    },
    Fcm(&'a str),
}

impl SubscriptionIdentity<'_> {
    fn provider(&self) -> PushProvider {
        match self {
            Self::WebPush(_) => PushProvider::WebPush,
            Self::Apns { .. } => PushProvider::Apns,
            Self::Fcm(_) => PushProvider::Fcm,
        }
    }

    fn scope(&self) -> &'static str {
        match self {
            Self::WebPush(_) | Self::Fcm(_) => "",
            Self::Apns { environment, .. } => environment.as_scope(),
        }
    }

    fn target(&self) -> &str {
        match self {
            Self::WebPush(endpoint) => endpoint,
            Self::Apns { device_token, .. } => device_token,
            Self::Fcm(device_token) => device_token,
        }
    }
}

#[derive(AsChangeset)]
#[diesel(table_name = push_subscriptions, treat_none_as_null = true)]
struct SubscriptionUpsertUpdate<'a> {
    user_id: i32,
    client_id: &'a str,
    created_at: chrono::NaiveDateTime,
    provider_data: &'a serde_json::Value,
    delivery_failure_count: i32,
    last_delivery_error: Option<&'a str>,
    last_delivery_error_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl<'a> SubscriptionUpsertUpdate<'a> {
    fn from_new(new_sub: &'a NewPushSubscription) -> Self {
        Self {
            user_id: new_sub.user_id,
            client_id: &new_sub.client_id,
            created_at: new_sub.created_at,
            provider_data: &new_sub.provider_data,
            delivery_failure_count: 0,
            last_delivery_error: None,
            last_delivery_error_at: None,
        }
    }
}

fn delete_replaced_subscriptions(
    conn: &mut PgConnection,
    new_sub: &NewPushSubscription,
) -> Result<(), diesel::result::Error> {
    diesel::delete(
        push_subscriptions::table
            .filter(push_subscriptions::user_id.eq(new_sub.user_id))
            .filter(push_subscriptions::client_id.eq(&new_sub.client_id))
            .filter(push_subscriptions::provider.eq(new_sub.provider))
            .filter(push_subscriptions::scope.eq(&new_sub.scope))
            .filter(push_subscriptions::target.ne(&new_sub.target)),
    )
    .execute(conn)?;
    Ok(())
}

pub(crate) fn upsert(
    conn: &mut PgConnection,
    new_sub: &NewPushSubscription,
) -> Result<(), diesel::result::Error> {
    conn.transaction::<_, diesel::result::Error, _>(|conn| {
        delete_replaced_subscriptions(conn, new_sub)?;

        // `(provider, scope, target)` uniquely identifies one physical push
        // destination; re-registering it (e.g. after switching accounts on the
        // same device or browser) transfers ownership to the new user/client.
        let update = SubscriptionUpsertUpdate::from_new(new_sub);
        diesel::insert_into(push_subscriptions::table)
            .values(new_sub)
            .on_conflict((
                push_subscriptions::provider,
                push_subscriptions::scope,
                push_subscriptions::target,
            ))
            .do_update()
            .set(&update)
            .execute(conn)?;

        Ok(())
    })
}

pub(crate) fn unsubscribe(
    conn: &mut PgConnection,
    uid: i32,
    client_id: &str,
    identity: &SubscriptionIdentity<'_>,
) -> Result<(), diesel::result::Error> {
    diesel::delete(
        push_subscriptions::table
            .filter(push_subscriptions::user_id.eq(uid))
            .filter(push_subscriptions::client_id.eq(client_id))
            .filter(push_subscriptions::provider.eq(identity.provider()))
            .filter(push_subscriptions::scope.eq(identity.scope()))
            .filter(push_subscriptions::target.eq(identity.target())),
    )
    .execute(conn)?;
    Ok(())
}

pub(crate) fn status(
    conn: &mut PgConnection,
    uid: i32,
    client_id: &str,
    provider: PushProvider,
    identity: Option<&SubscriptionIdentity<'_>>,
) -> Result<(bool, Option<bool>), diesel::result::Error> {
    let active = diesel::select(diesel::dsl::exists(
        push_subscriptions::table
            .filter(push_subscriptions::user_id.eq(uid))
            .filter(push_subscriptions::client_id.eq(client_id))
            .filter(push_subscriptions::provider.eq(provider)),
    ))
    .get_result(conn)?;
    let matching = if let Some(identity) = identity {
        Some(
            diesel::select(diesel::dsl::exists(
                push_subscriptions::table
                    .filter(push_subscriptions::user_id.eq(uid))
                    .filter(push_subscriptions::client_id.eq(client_id))
                    .filter(push_subscriptions::provider.eq(identity.provider()))
                    .filter(push_subscriptions::scope.eq(identity.scope()))
                    .filter(push_subscriptions::target.eq(identity.target())),
            ))
            .get_result(conn)?,
        )
    } else {
        None
    };
    Ok((active, matching))
}

pub(super) fn load_for_users(
    conn: &mut PgConnection,
    uids: &[i32],
) -> Result<Vec<PushSubscription>, diesel::result::Error> {
    push_subscriptions::table
        .filter(push_subscriptions::user_id.eq_any(uids))
        .select(PushSubscription::as_select())
        .load(conn)
}

pub(super) struct DeliveryChanges {
    pub(super) reset_ids: Vec<i64>,
    pub(super) prune_ids: Vec<i64>,
    pub(super) counted_failures: Vec<(DeliveryFailure, i32)>,
}

impl DeliveryChanges {
    pub(super) fn is_empty(&self) -> bool {
        self.reset_ids.is_empty() && self.prune_ids.is_empty() && self.counted_failures.is_empty()
    }
}

pub(super) fn apply_delivery_changes(
    conn: &mut PgConnection,
    changes: DeliveryChanges,
) -> Result<(), String> {
    let DeliveryChanges {
        reset_ids,
        prune_ids,
        counted_failures,
    } = changes;
    let now = chrono::Utc::now();
    if !reset_ids.is_empty() {
        diesel::update(
            push_subscriptions::table.filter(push_subscriptions::dsl::id.eq_any(&reset_ids)),
        )
        .set((
            push_subscriptions::dsl::delivery_failure_count.eq(0),
            push_subscriptions::dsl::last_delivery_error.eq::<Option<String>>(None),
            push_subscriptions::dsl::last_delivery_error_at
                .eq::<Option<chrono::DateTime<chrono::Utc>>>(None),
        ))
        .execute(conn)
        .map_err(|e| format!("Failed to reset push delivery failure state: {:?}", e))?;
    }

    for (failure, next_failure_count) in counted_failures {
        diesel::update(push_subscriptions::table.find(failure.subscription_id))
            .set((
                push_subscriptions::dsl::delivery_failure_count.eq(next_failure_count),
                push_subscriptions::dsl::last_delivery_error.eq(Some(failure.reason)),
                push_subscriptions::dsl::last_delivery_error_at.eq(Some(now)),
            ))
            .execute(conn)
            .map_err(|e| format!("Failed to update push delivery failure state: {:?}", e))?;
    }

    if !prune_ids.is_empty() {
        diesel::delete(
            push_subscriptions::table.filter(push_subscriptions::dsl::id.eq_any(&prune_ids)),
        )
        .execute(conn)
        .map_err(|e| format!("Failed to prune push subscriptions: {:?}", e))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::connection::SimpleConnection;

    fn fixture(
        id: i64,
        uid: i32,
        client: &str,
        provider: PushProvider,
        target: &str,
        environment: Option<PushEnvironment>,
    ) -> NewPushSubscription {
        NewPushSubscription {
            id,
            user_id: uid,
            provider,
            scope: environment
                .map(|env| env.as_scope().to_owned())
                .unwrap_or_default(),
            target: target.to_owned(),
            provider_data: match provider {
                PushProvider::WebPush => serde_json::json!({
                    "fixture": id,
                    "p256dh": "local-key",
                    "auth": "local-auth",
                }),
                _ => serde_json::json!({"fixture": id}),
            },
            created_at: chrono::Utc::now().naive_utc(),
            client_id: client.to_owned(),
            delivery_failure_count: 2,
            last_delivery_error: Some("old failure".into()),
            last_delivery_error_at: Some(chrono::Utc::now()),
        }
    }

    #[test]
    fn database_subscription_ownership_replacement_and_status() {
        let Ok(url) = std::env::var("WETTY_TEST_DATABASE_URL") else {
            eprintln!("skipping (WETTY_TEST_DATABASE_URL unset)");
            return;
        };
        let mut conn = PgConnection::establish(&url).unwrap();
        conn.begin_test_transaction().unwrap();
        conn.batch_execute(
            "CREATE TEMP TABLE push_subscriptions (LIKE public.push_subscriptions INCLUDING ALL)",
        )
        .unwrap();

        let sandbox = Some(PushEnvironment::Sandbox);
        let production = Some(PushEnvironment::Production);
        for sub in [
            fixture(0, 1, "one", PushProvider::WebPush, "web-transfer", None),
            fixture(1, 1, "one", PushProvider::Fcm, "fcm-transfer", None),
            fixture(2, 1, "one", PushProvider::Apns, "apns-transfer", sandbox),
            fixture(3, 2, "two", PushProvider::Apns, "apns-old", sandbox),
            fixture(
                4,
                2,
                "two",
                PushProvider::Apns,
                "apns-production",
                production,
            ),
            fixture(
                5,
                2,
                "other",
                PushProvider::Apns,
                "apns-other-client",
                sandbox,
            ),
            fixture(6, 3, "two", PushProvider::Apns, "apns-other-user", sandbox),
            fixture(7, 2, "two", PushProvider::WebPush, "web-old", None),
            fixture(
                8,
                2,
                "other",
                PushProvider::WebPush,
                "web-other-client",
                None,
            ),
            fixture(9, 3, "two", PushProvider::WebPush, "web-other-user", None),
            fixture(10, 2, "two", PushProvider::Fcm, "fcm-old", None),
        ] {
            diesel::insert_into(push_subscriptions::table)
                .values(&sub)
                .execute(&mut conn)
                .unwrap();
        }

        let mut fcm = fixture(11, 2, "two", PushProvider::Fcm, "fcm-transfer", None);
        fcm.provider_data = serde_json::json!({"updated": "fcm"});
        fcm.created_at = chrono::DateTime::from_timestamp(1_700_000_000, 0)
            .unwrap()
            .naive_utc();
        upsert(&mut conn, &fcm).unwrap();
        let mut apns = fixture(12, 2, "two", PushProvider::Apns, "apns-transfer", sandbox);
        apns.provider_data = serde_json::json!({"updated": "apns"});
        apns.created_at = fcm.created_at;
        upsert(&mut conn, &apns).unwrap();
        let mut web_updated = fixture(13, 2, "two", PushProvider::WebPush, "web-transfer", None);
        web_updated.provider_data = serde_json::json!({
            "updated": "web",
            "p256dh": "updated-key",
            "auth": "updated-auth",
        });
        web_updated.created_at = fcm.created_at;
        upsert(&mut conn, &web_updated).unwrap();

        let web_identity = SubscriptionIdentity::WebPush("web-transfer");
        let fcm_identity = SubscriptionIdentity::Fcm("fcm-transfer");
        let apns_identity = SubscriptionIdentity::Apns {
            device_token: "apns-transfer",
            environment: PushEnvironment::Sandbox,
        };
        unsubscribe(&mut conn, 1, "one", &web_identity).unwrap();
        unsubscribe(&mut conn, 1, "one", &fcm_identity).unwrap();
        unsubscribe(&mut conn, 1, "one", &apns_identity).unwrap();
        let rows = push_subscriptions::table
            .order(push_subscriptions::id)
            .select(PushSubscription::as_select())
            .load::<PushSubscription>(&mut conn)
            .unwrap();
        assert_eq!(
            rows.iter().map(|row| row.id).collect::<Vec<_>>(),
            vec![0, 1, 2, 4, 5, 6, 8, 9]
        );
        for (row, expected) in [
            (&rows[0], &web_updated),
            (&rows[1], &fcm),
            (&rows[2], &apns),
        ] {
            assert_eq!(row.user_id, 2);
            assert_eq!(row.client_id, "two");
            assert_eq!(row.provider_data, expected.provider_data);
            assert_eq!(row.created_at, expected.created_at);
            assert_eq!(row.delivery_failure_count, 0);
            assert_eq!(row.last_delivery_error, None);
            assert_eq!(row.last_delivery_error_at, None);
        }
        assert_eq!(
            status(
                &mut conn,
                1,
                "one",
                PushProvider::WebPush,
                Some(&web_identity)
            )
            .unwrap(),
            (false, Some(false))
        );
        assert_eq!(
            status(&mut conn, 2, "two", PushProvider::Fcm, None).unwrap(),
            (true, None)
        );
        assert_eq!(
            status(&mut conn, 2, "two", PushProvider::Fcm, Some(&fcm_identity)).unwrap(),
            (true, Some(true))
        );
        assert_eq!(
            status(&mut conn, 1, "one", PushProvider::Fcm, Some(&fcm_identity)).unwrap(),
            (false, Some(false))
        );
        assert_eq!(
            status(
                &mut conn,
                2,
                "two",
                PushProvider::Apns,
                Some(&apns_identity)
            )
            .unwrap(),
            (true, Some(true))
        );
        let wrong_environment = SubscriptionIdentity::Apns {
            device_token: "apns-transfer",
            environment: PushEnvironment::Production,
        };
        assert_eq!(
            status(
                &mut conn,
                2,
                "two",
                PushProvider::Apns,
                Some(&wrong_environment)
            )
            .unwrap(),
            (true, Some(false))
        );
        assert_eq!(
            status(
                &mut conn,
                2,
                "two",
                PushProvider::WebPush,
                Some(&web_identity)
            )
            .unwrap(),
            (true, Some(true))
        );
        unsubscribe(&mut conn, 2, "two", &web_identity).unwrap();
        assert_eq!(
            status(
                &mut conn,
                2,
                "two",
                PushProvider::WebPush,
                Some(&web_identity)
            )
            .unwrap(),
            (false, Some(false))
        );
    }
}
