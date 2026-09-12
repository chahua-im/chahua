DROP INDEX IF EXISTS idx_message_reactions_author_revision;

ALTER TABLE thread_user_states
    DROP COLUMN IF EXISTS last_reactions_read_revision;

ALTER TABLE group_membership
    DROP COLUMN IF EXISTS last_reactions_read_revision;

ALTER TABLE message_reactions
    DROP COLUMN IF EXISTS revision;
