CREATE INDEX idx_user_sticker_pack_subscriptions_pack_subscribed_at
    ON user_sticker_pack_subscriptions(pack_id, subscribed_at);
