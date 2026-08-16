ALTER TABLE pinned_messages
    ADD COLUMN thread_root_id BIGINT NULL REFERENCES messages(id);

-- Replace the plain UNIQUE (chat_id, message_id) with per-scope partial unique
-- indexes. A single UNIQUE (chat_id, thread_root_id, message_id) would not work:
-- Postgres treats NULLs as distinct, so chat-level pins would stop being deduped.
ALTER TABLE pinned_messages
    DROP CONSTRAINT IF EXISTS pinned_messages_chat_id_message_id_key;

CREATE UNIQUE INDEX idx_pinned_messages_chat_scope_unique
    ON pinned_messages (chat_id, message_id)
    WHERE thread_root_id IS NULL;

CREATE UNIQUE INDEX idx_pinned_messages_thread_scope_unique
    ON pinned_messages (chat_id, thread_root_id, message_id)
    WHERE thread_root_id IS NOT NULL;

CREATE INDEX idx_pinned_messages_thread
    ON pinned_messages (chat_id, thread_root_id, pinned_at DESC)
    WHERE thread_root_id IS NOT NULL;
