use chrono::Utc;
use diesel::prelude::*;

use crate::{
    dto::users::StickerPackOrderItem,
    errors::AppError,
    models::{
        NewStickerPack, StickerPack, StickerPackVisibility, UpdateStickerPack,
        UserStickerPackSubscription,
    },
    schema::{sticker_pack_stickers, sticker_packs, user_sticker_pack_subscriptions},
    services::sticker_order,
};

pub struct OrderUpdate {
    pub uid: i32,
    pub order: Vec<StickerPackOrderItem>,
}

pub struct PackChange {
    pub pack: StickerPack,
    pub orders: Vec<OrderUpdate>,
}

pub fn visible_pack(
    conn: &mut PgConnection,
    uid: i32,
    pack_id: i64,
) -> Result<StickerPack, AppError> {
    sticker_packs::table
        .filter(sticker_packs::id.eq(pack_id))
        .filter(
            sticker_packs::visibility
                .eq(StickerPackVisibility::Public)
                .or(sticker_packs::owner_uid.eq(uid)),
        )
        .select(StickerPack::as_select())
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Sticker pack not found"))
}

pub fn subscribed_packs(conn: &mut PgConnection, uid: i32) -> Result<Vec<StickerPack>, AppError> {
    Ok(user_sticker_pack_subscriptions::table
        .inner_join(sticker_packs::table)
        .filter(user_sticker_pack_subscriptions::uid.eq(uid))
        .filter(
            sticker_packs::visibility
                .eq(StickerPackVisibility::Public)
                .or(sticker_packs::owner_uid.eq(uid)),
        )
        .order((
            user_sticker_pack_subscriptions::subscribed_at.desc(),
            sticker_packs::id.desc(),
        ))
        .select(StickerPack::as_select())
        .load(conn)?)
}

pub fn packs_for_sticker(
    conn: &mut PgConnection,
    uid: i32,
    sticker_id: i64,
) -> Result<Vec<StickerPack>, AppError> {
    Ok(sticker_pack_stickers::table
        .inner_join(sticker_packs::table)
        .filter(sticker_pack_stickers::sticker_id.eq(sticker_id))
        .filter(
            sticker_packs::visibility
                .eq(StickerPackVisibility::Public)
                .or(sticker_packs::owner_uid.eq(uid)),
        )
        .order((
            sticker_pack_stickers::added_at.asc(),
            sticker_packs::id.asc(),
        ))
        .select(StickerPack::as_select())
        .load(conn)?)
}

fn lock_pack(conn: &mut PgConnection, pack_id: i64) -> Result<StickerPack, AppError> {
    sticker_packs::table
        .find(pack_id)
        .select(StickerPack::as_select())
        .for_update()
        .first(conn)
        .optional()?
        .ok_or(AppError::NotFound("Sticker pack not found"))
}

fn check_owner(pack: &StickerPack, uid: i32) -> Result<(), AppError> {
    if pack.owner_uid != uid {
        return Err(AppError::Forbidden("Sticker pack owner required"));
    }
    Ok(())
}

fn add_order(
    conn: &mut PgConnection,
    uid: i32,
    pack_id: i64,
) -> Result<Vec<StickerPackOrderItem>, AppError> {
    let mut order = sticker_order::lock_user(conn, uid)?;
    let id = pack_id.to_string();
    let last_used_on = Utc::now().timestamp_millis();
    if let Some(item) = order.iter_mut().find(|item| item.sticker_pack_id == id) {
        item.last_used_on = last_used_on;
    } else {
        order.push(StickerPackOrderItem {
            sticker_pack_id: id,
            last_used_on,
        });
    }
    sticker_order::save(conn, uid, &order)?;
    Ok(order)
}

fn remove_order(
    conn: &mut PgConnection,
    uid: i32,
    pack_id: i64,
) -> Result<Vec<StickerPackOrderItem>, AppError> {
    let mut order = sticker_order::lock_user(conn, uid)?;
    let id = pack_id.to_string();
    order.retain(|item| item.sticker_pack_id != id);
    sticker_order::save(conn, uid, &order)?;
    Ok(order)
}

// All callers lock the pack before user rows. User rows are locked in UID order
// so concurrent changes to multiple packs cannot deadlock while revoking users.
fn revoke_subscriptions(
    conn: &mut PgConnection,
    pack: &StickerPack,
    include_owner: bool,
) -> Result<Vec<OrderUpdate>, AppError> {
    let mut query = user_sticker_pack_subscriptions::table
        .filter(user_sticker_pack_subscriptions::pack_id.eq(pack.id))
        .into_boxed();
    if !include_owner {
        query = query.filter(user_sticker_pack_subscriptions::uid.ne(pack.owner_uid));
    }
    let mut uids: Vec<i32> = query
        .select(user_sticker_pack_subscriptions::uid)
        .load(conn)?;
    if include_owner {
        uids.push(pack.owner_uid);
    }
    uids.sort_unstable();
    uids.dedup();
    let orders = sticker_order::remove_pack(conn, &uids, pack.id)?
        .into_iter()
        .map(|(uid, order)| OrderUpdate { uid, order })
        .collect();
    diesel::delete(
        user_sticker_pack_subscriptions::table
            .filter(user_sticker_pack_subscriptions::pack_id.eq(pack.id))
            .filter(user_sticker_pack_subscriptions::uid.eq_any(uids)),
    )
    .execute(conn)?;
    Ok(orders)
}

pub fn create_pack(
    conn: &mut PgConnection,
    new_pack: NewStickerPack,
) -> Result<PackChange, AppError> {
    conn.transaction(|conn| {
        let pack: StickerPack = diesel::insert_into(sticker_packs::table)
            .values(&new_pack)
            .returning(StickerPack::as_returning())
            .get_result(conn)?;
        diesel::insert_into(user_sticker_pack_subscriptions::table)
            .values(UserStickerPackSubscription {
                uid: pack.owner_uid,
                pack_id: pack.id,
                subscribed_at: pack.created_at,
            })
            .execute(conn)?;
        let order = add_order(conn, pack.owner_uid, pack.id)?;
        Ok(PackChange {
            orders: vec![OrderUpdate {
                uid: pack.owner_uid,
                order,
            }],
            pack,
        })
    })
}

pub fn update_pack(
    conn: &mut PgConnection,
    uid: i32,
    pack_id: i64,
    changes: UpdateStickerPack,
) -> Result<PackChange, AppError> {
    conn.transaction(|conn| {
        let pack = lock_pack(conn, pack_id)?;
        check_owner(&pack, uid)?;
        let orders = if changes.visibility == Some(StickerPackVisibility::Private) {
            revoke_subscriptions(conn, &pack, false)?
        } else {
            Vec::new()
        };
        let pack = diesel::update(sticker_packs::table.find(pack_id))
            .set(&changes)
            .returning(StickerPack::as_returning())
            .get_result(conn)?;
        Ok(PackChange { pack, orders })
    })
}

pub fn delete_pack(
    conn: &mut PgConnection,
    uid: i32,
    pack_id: i64,
) -> Result<Vec<OrderUpdate>, AppError> {
    conn.transaction(|conn| {
        let pack = lock_pack(conn, pack_id)?;
        check_owner(&pack, uid)?;
        let orders = revoke_subscriptions(conn, &pack, true)?;
        diesel::delete(sticker_packs::table.find(pack_id)).execute(conn)?;
        Ok(orders)
    })
}

pub fn subscribe(
    conn: &mut PgConnection,
    uid: i32,
    pack_id: i64,
) -> Result<Vec<StickerPackOrderItem>, AppError> {
    conn.transaction(|conn| {
        let pack = lock_pack(conn, pack_id)?;
        if pack.visibility == StickerPackVisibility::Private && pack.owner_uid != uid {
            return Err(AppError::NotFound("Sticker pack not found"));
        }
        diesel::insert_into(user_sticker_pack_subscriptions::table)
            .values(UserStickerPackSubscription {
                uid,
                pack_id,
                subscribed_at: Utc::now(),
            })
            .on_conflict_do_nothing()
            .execute(conn)?;
        add_order(conn, uid, pack_id)
    })
}

pub fn unsubscribe(
    conn: &mut PgConnection,
    uid: i32,
    pack_id: i64,
) -> Result<Vec<StickerPackOrderItem>, AppError> {
    conn.transaction(|conn| {
        let pack = lock_pack(conn, pack_id)?;
        if pack.owner_uid == uid {
            return Err(AppError::BadRequest("Pack owner cannot unsubscribe"));
        }
        diesel::delete(
            user_sticker_pack_subscriptions::table
                .filter(user_sticker_pack_subscriptions::uid.eq(uid))
                .filter(user_sticker_pack_subscriptions::pack_id.eq(pack_id)),
        )
        .execute(conn)?;
        remove_order(conn, uid, pack_id)
    })
}

#[cfg(test)]
mod tests;
