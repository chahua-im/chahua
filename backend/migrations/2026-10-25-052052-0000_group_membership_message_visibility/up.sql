CREATE TYPE membership_message_visibility AS ENUM ('members', 'admins', 'nobody');
ALTER TABLE groups
    ADD COLUMN membership_message_visibility membership_message_visibility NOT NULL DEFAULT 'members';
