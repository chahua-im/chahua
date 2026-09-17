-- Your SQL goes here
CREATE TYPE presence_visibility AS ENUM ('everyone', 'friends', 'nobody');

ALTER TABLE user_extra
    ALTER COLUMN last_seen_at DROP NOT NULL,
    ADD COLUMN presence_visibility presence_visibility NOT NULL DEFAULT 'everyone';
