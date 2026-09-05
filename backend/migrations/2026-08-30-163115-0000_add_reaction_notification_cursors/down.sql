DROP INDEX IF EXISTS idx_message_reactions_author_created;

ALTER TABLE message_reactions DROP COLUMN message_author_uid;

ALTER TABLE thread_user_states DROP COLUMN last_reactions_read_at;

ALTER TABLE group_membership DROP COLUMN last_reactions_read_at;
