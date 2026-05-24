-- Re-add the column (safe if it already exists from the original migration)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'thread_subscriptions' AND column_name = 'last_read_message_id'
    ) THEN
        ALTER TABLE thread_subscriptions ADD COLUMN last_read_message_id BIGINT;
    END IF;
END $$;

-- Restore data from thread_read_state
UPDATE thread_subscriptions ts
SET last_read_message_id = trs.last_read_message_id
FROM thread_read_state trs
WHERE ts.chat_id = trs.chat_id
  AND ts.thread_root_id = trs.thread_root_id
  AND ts.uid = trs.uid;

-- Drop the new table
DROP TABLE thread_read_state;
