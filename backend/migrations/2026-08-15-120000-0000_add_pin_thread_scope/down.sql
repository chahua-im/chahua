DROP INDEX idx_pinned_messages_thread;
DROP INDEX idx_pinned_messages_thread_scope_unique;
DROP INDEX idx_pinned_messages_chat_scope_unique;

-- Thread pins have no representation once the scope column is gone: drop them.
-- This must run BEFORE the UNIQUE(chat_id, message_id) constraint is restored,
-- otherwise a message pinned both chat-wide and in a thread collapses into a
-- duplicate row and the ADD CONSTRAINT below fails.
DELETE FROM pinned_messages WHERE thread_root_id IS NOT NULL;

ALTER TABLE pinned_messages DROP COLUMN thread_root_id;

ALTER TABLE pinned_messages
    ADD CONSTRAINT pinned_messages_chat_id_message_id_key UNIQUE (chat_id, message_id);
