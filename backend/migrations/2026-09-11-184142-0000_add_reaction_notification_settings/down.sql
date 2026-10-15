ALTER TABLE user_extra
    DROP COLUMN IF EXISTS reaction_notifications_enabled;

ALTER TABLE group_membership
    ADD COLUMN IF NOT EXISTS last_reactions_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE thread_user_states
    ADD COLUMN IF NOT EXISTS last_reactions_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
