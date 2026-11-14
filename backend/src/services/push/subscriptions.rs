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

pub(crate) fn upsert(
    conn: &mut PgConnection,
    new_sub: &NewPushSubscription,
) -> Result<(), diesel::result::Error> {
    conn.transaction::<_, diesel::result::Error, _>(|conn| {
        let provider = new_sub.provider;
        let endpoint = new_sub.endpoint.clone();
        let device_token = new_sub.device_token.clone();
        let apns_environment = new_sub.apns_environment;
        let provider_data = new_sub.provider_data.clone();
        let created_at = new_sub.created_at;
        let current_client_id = new_sub.client_id.clone();

        let mut replace_scope = push_subscriptions::table
            .filter(push_subscriptions::dsl::user_id.eq(new_sub.user_id))
            .filter(push_subscriptions::dsl::client_id.eq(current_client_id.clone()))
            .filter(push_subscriptions::dsl::provider.eq(provider))
            .into_boxed();

        match provider {
            PushProvider::WebPush => {
                if let Some(endpoint) = &endpoint {
                    replace_scope = replace_scope
                        .filter(push_subscriptions::dsl::endpoint.ne(Some(endpoint.clone())));
                }
            }
            PushProvider::Apns => {
                if let Some(device_token) = &device_token {
                    replace_scope = replace_scope
                        .filter(push_subscriptions::dsl::apns_environment.eq(apns_environment))
                        .filter(
                            push_subscriptions::dsl::device_token.ne(Some(device_token.clone())),
                        );
                }
            }
            PushProvider::Fcm => {
                if let Some(device_token) = &device_token {
                    replace_scope = replace_scope.filter(
                        push_subscriptions::dsl::device_token.ne(Some(device_token.clone())),
                    );
                }
            }
        }

        let replace_ids = replace_scope
            .select(push_subscriptions::dsl::id)
            .load::<i64>(conn)?;
        if !replace_ids.is_empty() {
            diesel::delete(
                push_subscriptions::table.filter(push_subscriptions::dsl::id.eq_any(&replace_ids)),
            )
            .execute(conn)?;
        }

        // FCM tokens are unique per provider rather than per user, so a token
        // that already exists (e.g. after switching accounts on one device)
        // moves to the current user instead of being inserted again.
        let existing_id = match provider {
            PushProvider::WebPush => push_subscriptions::table
                .filter(push_subscriptions::dsl::user_id.eq(new_sub.user_id))
                .filter(push_subscriptions::dsl::provider.eq(provider))
                .filter(push_subscriptions::dsl::endpoint.eq(endpoint.clone()))
                .select(push_subscriptions::dsl::id)
                .first::<i64>(conn)
                .optional()?,
            PushProvider::Apns => None,
            PushProvider::Fcm => find_fcm_subscription(conn, device_token.as_deref())?,
        };

        if let Some(existing_id) = existing_id {
            diesel::update(push_subscriptions::table.find(existing_id))
                .set((
                    push_subscriptions::user_id.eq(new_sub.user_id),
                    push_subscriptions::client_id.eq(&current_client_id),
                    push_subscriptions::created_at.eq(created_at),
                    push_subscriptions::provider_data.eq(&provider_data),
                    push_subscriptions::delivery_failure_count.eq(0),
                    push_subscriptions::last_delivery_error.eq::<Option<String>>(None),
                    push_subscriptions::last_delivery_error_at
                        .eq::<Option<chrono::DateTime<chrono::Utc>>>(None),
                ))
                .execute(conn)?;
        } else {
            match provider {
                PushProvider::WebPush | PushProvider::Fcm => {
                    diesel::insert_into(push_subscriptions::table)
                        .values(new_sub)
                        .execute(conn)?;
                }
                PushProvider::Apns => {
                    diesel::insert_into(push_subscriptions::table)
                        .values(new_sub)
                        .on_conflict((
                            push_subscriptions::provider,
                            push_subscriptions::device_token,
                            push_subscriptions::apns_environment,
                        ))
                        .do_update()
                        .set((
                            push_subscriptions::user_id.eq(new_sub.user_id),
                            push_subscriptions::client_id.eq(&current_client_id),
                            push_subscriptions::created_at.eq(created_at),
                            push_subscriptions::provider_data.eq(&provider_data),
                            push_subscriptions::delivery_failure_count.eq(0),
                            push_subscriptions::last_delivery_error.eq::<Option<String>>(None),
                            push_subscriptions::last_delivery_error_at.eq::<Option<
                                chrono::DateTime<chrono::Utc>,
                            >>(
                                None
                            ),
                        ))
                        .execute(conn)?;
                }
            }
        }

        Ok(())
    })
}

/// Look up an FCM subscription by device token, regardless of its current owner.
fn find_fcm_subscription(
    conn: &mut PgConnection,
    device_token: Option<&str>,
) -> Result<Option<i64>, diesel::result::Error> {
    let Some(device_token) = device_token else {
        return Ok(None);
    };
    push_subscriptions::table
        .filter(push_subscriptions::dsl::provider.eq(PushProvider::Fcm))
        .filter(push_subscriptions::dsl::device_token.eq(Some(device_token)))
        .select(push_subscriptions::dsl::id)
        .first::<i64>(conn)
        .optional()
}

pub(crate) fn unsubscribe(
    conn: &mut PgConnection,
    uid: i32,
    client_id: &str,
    identity: &SubscriptionIdentity<'_>,
) -> Result<(), diesel::result::Error> {
    let provider = match identity {
        SubscriptionIdentity::WebPush(_) => PushProvider::WebPush,
        SubscriptionIdentity::Apns { .. } => PushProvider::Apns,
        SubscriptionIdentity::Fcm(_) => PushProvider::Fcm,
    };
    let mut query = push_subscriptions::table
        .filter(push_subscriptions::user_id.eq(uid))
        .filter(push_subscriptions::client_id.eq(Some(client_id)))
        .filter(push_subscriptions::provider.eq(provider))
        .into_boxed();
    query = match identity {
        SubscriptionIdentity::WebPush(endpoint) => {
            query.filter(push_subscriptions::endpoint.eq(Some(*endpoint)))
        }
        SubscriptionIdentity::Apns {
            device_token,
            environment,
        } => query
            .filter(push_subscriptions::device_token.eq(Some(*device_token)))
            .filter(push_subscriptions::apns_environment.eq(Some(*environment))),
        SubscriptionIdentity::Fcm(device_token) => {
            query.filter(push_subscriptions::device_token.eq(Some(*device_token)))
        }
    };
    let ids = query.select(push_subscriptions::id).load::<i64>(conn)?;
    if !ids.is_empty() {
        diesel::delete(push_subscriptions::table.filter(push_subscriptions::id.eq_any(&ids)))
            .execute(conn)?;
    }
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
            .filter(push_subscriptions::client_id.eq(Some(client_id)))
            .filter(push_subscriptions::provider.eq(provider)),
    ))
    .get_result(conn)?;
    let matching = if let Some(identity) = identity {
        let query = push_subscriptions::table
            .filter(push_subscriptions::user_id.eq(uid))
            .filter(push_subscriptions::client_id.eq(Some(client_id)))
            .filter(push_subscriptions::provider.eq(provider))
            .into_boxed();
        let query = match identity {
            SubscriptionIdentity::WebPush(endpoint) => {
                query.filter(push_subscriptions::endpoint.eq(Some(*endpoint)))
            }
            SubscriptionIdentity::Apns {
                device_token,
                environment,
            } => query
                .filter(push_subscriptions::device_token.eq(Some(*device_token)))
                .filter(push_subscriptions::apns_environment.eq(Some(*environment))),
            SubscriptionIdentity::Fcm(device_token) => {
                query.filter(push_subscriptions::device_token.eq(Some(*device_token)))
            }
        };
        Some(diesel::select(diesel::dsl::exists(query)).get_result(conn)?)
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
        identity: &str,
        environment: Option<PushEnvironment>,
    ) -> NewPushSubscription {
        NewPushSubscription {
            id,
            user_id: uid,
            provider,
            endpoint: matches!(provider, PushProvider::WebPush).then(|| identity.to_owned()),
            device_token: (!matches!(provider, PushProvider::WebPush)).then(|| identity.to_owned()),
            apns_environment: environment,
            provider_data: match provider {
                PushProvider::WebPush => serde_json::json!({
                    "fixture": id,
                    "p256dh": "local-key",
                    "auth": "local-auth",
                }),
                _ => serde_json::json!({"fixture": id}),
            },
            created_at: chrono::Utc::now().naive_utc(),
            client_id: Some(client.to_owned()),
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
        upsert(
            &mut conn,
            &fixture(13, 2, "two", PushProvider::WebPush, "web-new", None),
        )
        .unwrap();

        let fcm_identity = SubscriptionIdentity::Fcm("fcm-transfer");
        let apns_identity = SubscriptionIdentity::Apns {
            device_token: "apns-transfer",
            environment: PushEnvironment::Sandbox,
        };
        unsubscribe(&mut conn, 1, "one", &fcm_identity).unwrap();
        unsubscribe(&mut conn, 1, "one", &apns_identity).unwrap();
        let rows = push_subscriptions::table
            .order(push_subscriptions::id)
            .select(PushSubscription::as_select())
            .load::<PushSubscription>(&mut conn)
            .unwrap();
        assert_eq!(
            rows.iter().map(|row| row.id).collect::<Vec<_>>(),
            vec![1, 2, 4, 5, 6, 8, 9, 13]
        );
        for (row, expected) in [(&rows[0], &fcm), (&rows[1], &apns)] {
            assert_eq!(row.user_id, 2);
            assert_eq!(row.client_id.as_deref(), Some("two"));
            assert_eq!(row.provider_data, expected.provider_data);
            assert_eq!(row.created_at, expected.created_at);
            assert_eq!(row.delivery_failure_count, 0);
            assert_eq!(row.last_delivery_error, None);
            assert_eq!(row.last_delivery_error_at, None);
        }
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
        let web = SubscriptionIdentity::WebPush("web-new");
        assert_eq!(
            status(&mut conn, 2, "two", PushProvider::WebPush, Some(&web)).unwrap(),
            (true, Some(true))
        );
        unsubscribe(&mut conn, 2, "two", &web).unwrap();
        assert_eq!(
            status(&mut conn, 2, "two", PushProvider::WebPush, Some(&web)).unwrap(),
            (false, Some(false))
        );
    }
}
