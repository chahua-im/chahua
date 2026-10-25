CREATE TYPE speaking_mode AS ENUM ('unrestricted', 'threads_only', 'replies_only', 'read_only');

ALTER TABLE groups
    ADD COLUMN speaking_mode speaking_mode NOT NULL DEFAULT 'unrestricted',
    ADD CONSTRAINT dm_speaking_mode_unrestricted
        CHECK (kind <> 'dm' OR speaking_mode = 'unrestricted');

ALTER TABLE group_membership
    ADD COLUMN speaking_mode speaking_mode NOT NULL DEFAULT 'unrestricted',
    ADD CONSTRAINT admin_speaking_mode_unrestricted
        CHECK (role <> 'admin' OR speaking_mode = 'unrestricted');
