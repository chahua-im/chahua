CREATE TABLE thread_read_state (
    chat_id BIGINT NOT NULL,
    thread_root_id BIGINT NOT NULL,
    uid INT NOT NULL,
    last_read_message_id BIGINT,
    PRIMARY KEY (chat_id, thread_root_id, uid)
);

-- Migrate existing read positions from thread_subscriptions
INSERT INTO thread_read_state (chat_id, thread_root_id, uid, last_read_message_id)
SELECT chat_id, thread_root_id, uid, last_read_message_id
FROM thread_subscriptions
WHERE last_read_message_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Drop the now-redundant column
ALTER TABLE thread_subscriptions DROP COLUMN last_read_message_id;
