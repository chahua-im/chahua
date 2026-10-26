use std::cmp::Reverse;
use std::collections::HashSet;

use diesel::prelude::*;

use crate::dto::users::{StickerPackOrderItem, UpdateStickerPackOrderItem};
use crate::errors::AppError;
use crate::models::{NewUserExtra, StickerPackVisibility};
use crate::schema::{sticker_packs, user_extra, user_sticker_pack_subscriptions};

/// Call inside a transaction, after locking any packs involved in the operation.
/// The row also serializes an account's changes to different packs.
pub fn lock_user(conn: &mut PgConnection, uid: i32) -> Result<Vec<StickerPackOrderItem>, AppError> {
    diesel::insert_into(user_extra::table)
        .values(NewUserExtra::new(uid, chrono::Utc::now().naive_utc()))
        .on_conflict(user_extra::uid)
        .do_nothing()
        .execute(conn)?;

    let order: serde_json::Value = user_extra::table
        .filter(user_extra::uid.eq(uid))
        .select(user_extra::sticker_pack_order)
        .for_update()
        .first(conn)?;

    serde_json::from_value(order).map_err(|_| AppError::Internal("Invalid sticker pack order"))
}

/// The caller must hold the user row lock until its transaction commits.
pub fn save(
    conn: &mut PgConnection,
    uid: i32,
    order: &[StickerPackOrderItem],
) -> Result<(), AppError> {
    let value = serde_json::to_value(order)
        .map_err(|_| AppError::Internal("Failed to serialize sticker pack order"))?;
    diesel::update(user_extra::table.filter(user_extra::uid.eq(uid)))
        .set(user_extra::sticker_pack_order.eq(value))
        .execute(conn)?;
    Ok(())
}

/// Revoke a pack from many accounts inside the caller's pack-locked transaction.
/// All row locks are acquired in UID order before any order is replaced.
pub fn remove_pack(
    conn: &mut PgConnection,
    uids: &[i32],
    pack_id: i64,
) -> Result<Vec<(i32, Vec<StickerPackOrderItem>)>, AppError> {
    const BATCH_SIZE: usize = 1000;
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    let mut uids = uids.to_vec();
    uids.sort_unstable();
    uids.dedup();
    let now = chrono::Utc::now().naive_utc();
    for batch in uids.chunks(BATCH_SIZE) {
        let users: Vec<_> = batch
            .iter()
            .map(|uid| NewUserExtra::new(*uid, now))
            .collect();
        diesel::insert_into(user_extra::table)
            .values(&users)
            .on_conflict(user_extra::uid)
            .do_nothing()
            .execute(conn)?;
    }

    let rows: Vec<(i32, serde_json::Value)> = user_extra::table
        .filter(user_extra::uid.eq_any(&uids))
        .order(user_extra::uid.asc())
        .select((user_extra::uid, user_extra::sticker_pack_order))
        .for_update()
        .load(conn)?;
    let pack_id = pack_id.to_string();
    let mut updates = Vec::with_capacity(rows.len());
    for (uid, value) in rows {
        let mut order: Vec<StickerPackOrderItem> = serde_json::from_value(value)
            .map_err(|_| AppError::Internal("Invalid sticker pack order"))?;
        order.retain(|item| item.sticker_pack_id != pack_id);
        updates.push((uid, order));
    }
    for batch in updates.chunks(BATCH_SIZE) {
        let users = batch
            .iter()
            .map(|(uid, order)| {
                Ok::<_, AppError>(NewUserExtra {
                    sticker_pack_order: serde_json::to_value(order).map_err(|_| {
                        AppError::Internal("Failed to serialize sticker pack order")
                    })?,
                    ..NewUserExtra::new(*uid, now)
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        diesel::insert_into(user_extra::table)
            .values(&users)
            .on_conflict(user_extra::uid)
            .do_update()
            .set(
                user_extra::sticker_pack_order
                    .eq(diesel::upsert::excluded(user_extra::sticker_pack_order)),
            )
            .execute(conn)?;
    }
    Ok(updates)
}

pub fn update_order(
    conn: &mut PgConnection,
    uid: i32,
    requested: Vec<UpdateStickerPackOrderItem>,
) -> Result<Vec<StickerPackOrderItem>, AppError> {
    conn.transaction(|conn| {
        let requested_ids: Vec<i64> = requested
            .iter()
            .filter_map(|item| item.sticker_pack_id.parse().ok())
            .collect();

        // Every writer takes pack locks before user locks. Sharing these locks
        // permits independent users to reorder while blocking revocation.
        let _: Vec<i64> = sticker_packs::table
            .filter(sticker_packs::id.eq_any(&requested_ids))
            .order(sticker_packs::id.asc())
            .select(sticker_packs::id)
            .for_share()
            .load(conn)?;

        let mut current = lock_user(conn, uid)?;
        let ids: Vec<i64> = current
            .iter()
            .filter_map(|item| item.sticker_pack_id.parse().ok())
            .chain(requested_ids)
            .collect();
        let accessible = accessible_pack_ids(conn, uid, &ids)?;
        current.retain(|item| {
            item.sticker_pack_id
                .parse()
                .is_ok_and(|id| accessible.contains(&id))
        });
        merge_order(&mut current, requested, &accessible);
        save(conn, uid, &current)?;
        Ok(current)
    })
}

fn accessible_pack_ids(
    conn: &mut PgConnection,
    uid: i32,
    ids: &[i64],
) -> Result<HashSet<i64>, AppError> {
    let subscribed = user_sticker_pack_subscriptions::table
        .filter(user_sticker_pack_subscriptions::uid.eq(uid))
        .select(user_sticker_pack_subscriptions::pack_id);
    let ids: Vec<i64> = sticker_packs::table
        .filter(sticker_packs::id.eq_any(ids))
        .filter(
            sticker_packs::owner_uid
                .eq(uid)
                .or(sticker_packs::visibility
                    .eq(StickerPackVisibility::Public)
                    .and(sticker_packs::id.eq_any(subscribed))),
        )
        .select(sticker_packs::id)
        .load(conn)?;
    Ok(ids.into_iter().collect())
}

fn merge_order(
    current: &mut Vec<StickerPackOrderItem>,
    requested: Vec<UpdateStickerPackOrderItem>,
    accessible: &HashSet<i64>,
) {
    let mut sorted = current.clone();
    sorted.sort_by_key(|item| Reverse(item.last_used_on));

    for incoming in requested {
        let Ok(id) = incoming.sticker_pack_id.parse::<i64>() else {
            continue;
        };
        if !accessible.contains(&id) {
            continue;
        }
        let pack_id = id.to_string();
        if incoming.is_auto_sort.unwrap_or(false) {
            let Some(position) = sorted
                .iter()
                .position(|item| item.sticker_pack_id == pack_id)
            else {
                continue;
            };
            if position >= crate::MAX_AUTO_SORT_LIMIT {
                continue;
            }
        }
        if let Some(existing) = current
            .iter_mut()
            .find(|item| item.sticker_pack_id == pack_id)
        {
            existing.last_used_on = incoming.last_used_on;
        } else {
            current.push(StickerPackOrderItem {
                sticker_pack_id: pack_id,
                last_used_on: incoming.last_used_on,
            });
        }
        sorted.clone_from(current);
        sorted.sort_by_key(|item| Reverse(item.last_used_on));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str, time: i64, auto: bool) -> UpdateStickerPackOrderItem {
        UpdateStickerPackOrderItem {
            sticker_pack_id: id.to_owned(),
            last_used_on: time,
            is_auto_sort: Some(auto),
        }
    }

    #[test]
    fn auto_sort_respects_limit_and_does_not_insert_missing_packs() {
        let mut current: Vec<_> = (0..=crate::MAX_AUTO_SORT_LIMIT)
            .map(|id| StickerPackOrderItem {
                sticker_pack_id: id.to_string(),
                last_used_on: -(id as i64),
            })
            .collect();
        let accessible = (0..100).collect();
        let outside = crate::MAX_AUTO_SORT_LIMIT.to_string();
        merge_order(
            &mut current,
            vec![
                request("0", 10, true),
                request(&outside, 99, true),
                request("99", 99, true),
            ],
            &accessible,
        );
        assert_eq!(current[0].last_used_on, 10);
        assert_eq!(
            current.last().unwrap().last_used_on,
            -(crate::MAX_AUTO_SORT_LIMIT as i64)
        );
        assert_eq!(current.len(), crate::MAX_AUTO_SORT_LIMIT + 1);
    }

    #[test]
    fn manual_order_preserves_other_items_and_ignores_inaccessible_ids() {
        let mut current = vec![StickerPackOrderItem {
            sticker_pack_id: "1".to_owned(),
            last_used_on: i64::MIN,
        }];
        merge_order(
            &mut current,
            vec![
                request("2", 12, false),
                request("3", 20, false),
                request("bad", 22, false),
            ],
            &HashSet::from([1, 2]),
        );
        assert_eq!(current.len(), 2);
        assert_eq!(current[0].last_used_on, i64::MIN);
        assert_eq!(current[1].sticker_pack_id, "2");
        assert_eq!(current[1].last_used_on, 12);
    }
}
