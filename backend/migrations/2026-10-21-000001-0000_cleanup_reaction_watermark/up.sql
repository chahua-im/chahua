-- The product no longer needs to roll back to the SysMsg revision-watermark
-- implementation. Drop the abandoned cursor columns and their index so the
-- reaction read state is exactly the minimal chat/thread timestamp cursor.
--
-- Every statement is idempotent: on a database that only ever ran the main
-- notification migration this migration is a no-op.
DROP INDEX IF EXISTS idx_message_reactions_author_revision;

ALTER TABLE message_reactions
    DROP COLUMN IF EXISTS revision;

ALTER TABLE group_membership
    DROP COLUMN IF EXISTS last_reactions_read_revision;

ALTER TABLE thread_user_states
    DROP COLUMN IF EXISTS last_reactions_read_revision;

-- Also remove the abandoned per-message-view / opt-in experiment from the
-- parallel MentionBackend design. The current chat-level design has no use for
-- either object; both statements are no-ops on the main schema.
DROP TABLE IF EXISTS message_views;

ALTER TABLE user_extra
    DROP COLUMN IF EXISTS reaction_notifications_enabled;
