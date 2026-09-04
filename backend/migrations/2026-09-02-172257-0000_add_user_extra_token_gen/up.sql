-- Per-user session generation. A session JWT is only accepted when its `gen`
-- claim equals this value, so incrementing it revokes every outstanding token.
ALTER TABLE user_extra ADD COLUMN token_gen INTEGER NOT NULL DEFAULT 0;
