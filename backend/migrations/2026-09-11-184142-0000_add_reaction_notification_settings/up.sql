-- Per-user toggle for unread-reaction badges and directed reaction
-- notifications. Defaults to OFF.
ALTER TABLE user_extra
    ADD COLUMN reaction_notifications_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- The timestamp reaction cursors added by the previous (unreleased)
-- notification migration are superseded by the per-message view table.
ALTER TABLE group_membership
    DROP COLUMN IF EXISTS last_reactions_read_at;

ALTER TABLE thread_user_states
    DROP COLUMN IF EXISTS last_reactions_read_at;
