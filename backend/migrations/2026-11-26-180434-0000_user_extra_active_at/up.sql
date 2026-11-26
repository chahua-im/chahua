ALTER TABLE user_extra ADD COLUMN last_active_at TIMESTAMP NULL;
UPDATE user_extra SET last_active_at = last_seen_at;
