ALTER TABLE group_membership DROP COLUMN mute_override;

ALTER TABLE user_extra
    DROP COLUMN mute_direct_chats_by_default,
    DROP COLUMN mute_group_chats_by_default;
