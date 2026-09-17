use chrono::NaiveDateTime;
use diesel::prelude::*;

use crate::models::{FriendAddVerificationMode, NewUserExtra, PresenceVisibility, UserExtra};
use crate::schema::user_extra;
use crate::services::activity_metrics::{ActivityMetricsService, DailyMetricDelta};

#[allow(dead_code)] // The coordinator begins using this API in the next implementation stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresenceObservationCause {
    ActiveCheckpoint,
    ExplicitInactive,
    Disconnect,
    Prune,
}

/// Persist a trusted foreground observation and its user-level daily metrics.
///
/// `observed_at` must be a UTC naive timestamp. The transaction locks the user's
/// row so delayed observations cannot move the stored last-seen value backwards
/// or duplicate daily-user accounting.
#[allow(dead_code)] // Wired into the WebSocket coordinator in the next implementation stage.
pub fn record_presence_observation(
    conn: &mut PgConnection,
    daily_metrics: &ActivityMetricsService,
    uid: i32,
    observed_at: NaiveDateTime,
    _cause: PresenceObservationCause,
) -> QueryResult<NaiveDateTime> {
    conn.transaction(|conn| {
        let skeleton = NewUserExtra {
            uid,
            first_seen_at: observed_at,
            last_seen_at: None,
            presence_visibility: PresenceVisibility::Everyone,
            sticker_pack_order: serde_json::json!([]),
            verification_mode: FriendAddVerificationMode::Direct,
            verification_question: None,
        };
        diesel::insert_into(user_extra::table)
            .values(&skeleton)
            .on_conflict(user_extra::uid)
            .do_nothing()
            .execute(conn)?;

        let existing = user_extra::table
            .find(uid)
            .select(UserExtra::as_select())
            .for_update()
            .first::<UserExtra>(conn)?;

        if let Some(stored) = existing.last_seen_at {
            if observed_at <= stored {
                return Ok(stored);
            }
        }

        let is_new_user = existing.last_seen_at.is_none();
        let active_users = i64::from(
            existing
                .last_seen_at
                .is_none_or(|stored| stored.date() != observed_at.date()),
        );
        let updated_last_seen_at = diesel::update(user_extra::table.find(uid))
            .set((
                user_extra::last_seen_at.eq(Some(observed_at)),
                user_extra::first_seen_at.eq(if is_new_user {
                    observed_at
                } else {
                    existing.first_seen_at
                }),
            ))
            .returning(user_extra::last_seen_at)
            .get_result::<Option<NaiveDateTime>>(conn)?
            .expect("presence observation always writes last_seen_at");

        daily_metrics.upsert(
            conn,
            DailyMetricDelta {
                day: observed_at.date(),
                active_users,
                new_users: i64::from(is_new_user),
                active_clients: 0,
                new_clients: 0,
                client_rebinds: 0,
                stale_clients_purged: 0,
                legacy_subscriptions_purged: 0,
            },
            observed_at,
        )?;
        Ok(updated_last_seen_at)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observation_causes_remain_distinct() {
        assert_ne!(
            PresenceObservationCause::ActiveCheckpoint,
            PresenceObservationCause::ExplicitInactive
        );
        assert_ne!(
            PresenceObservationCause::Disconnect,
            PresenceObservationCause::Prune
        );
    }
}
