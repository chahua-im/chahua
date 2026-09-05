-- Track @mentions per message so "unread mentions" can be queried efficiently.
-- Mentions are parsed from message text (@[uid:N]) at send time; only chat members
-- are persisted (non-member mentions are meaningless and filtered at write time).
-- Rows are cleaned up in the message soft-delete transaction.
CREATE TABLE message_mentions (
    message_id     BIGINT NOT NULL REFERENCES messages(id),
    mentioned_uid  INTEGER NOT NULL,
    chat_id        BIGINT NOT NULL,
    thread_root_id BIGINT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (message_id, mentioned_uid)
);

-- Per-user unread-mention count / jump-to-mention:
--   main scope:   WHERE mentioned_uid = $1 AND chat_id = $2
--                   AND thread_root_id IS NULL AND message_id > $last_read
--   thread scope: WHERE mentioned_uid = $1 AND chat_id = $2
--                   AND thread_root_id = $3 AND message_id > $last_read
CREATE INDEX message_mentions_unread_idx
    ON message_mentions (mentioned_uid, chat_id, thread_root_id, message_id);

-- Cleanup on message delete (WHERE message_id = $1) is served by the primary
-- key, which leads with message_id — no dedicated index.
