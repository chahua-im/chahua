ALTER TABLE user_extra
    ADD COLUMN mute_group_chats_by_default BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN mute_direct_chats_by_default BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE group_membership
    ADD COLUMN mute_override BOOLEAN;

-- Keep existing expiry/sentinel values, including archived memberships. Archive
-- decoupling must be delivered together with clients that preserve preferences.
-- Reads and writes use the existing uid and (chat_id, uid) membership indexes.
