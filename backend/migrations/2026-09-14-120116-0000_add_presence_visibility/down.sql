-- This file should undo anything in `up.sql`
UPDATE user_extra
SET last_seen_at = first_seen_at
WHERE last_seen_at IS NULL;

ALTER TABLE user_extra
    ALTER COLUMN last_seen_at SET NOT NULL,
    DROP COLUMN presence_visibility;

DROP TYPE presence_visibility;
