DROP INDEX IF EXISTS idx_message_reactions_author_revision;

ALTER TABLE thread_user_states
    DROP COLUMN IF EXISTS last_reactions_read_revision;

ALTER TABLE group_membership
    DROP COLUMN IF EXISTS last_reactions_read_revision;

ALTER TABLE message_reactions
    DROP COLUMN IF EXISTS revision;

ALTER TABLE group_membership
    ADD COLUMN IF NOT EXISTS last_reactions_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE thread_user_states
    ADD COLUMN IF NOT EXISTS last_reactions_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_message_reactions_author_created
    ON message_reactions (message_author_uid, created_at);
