-- Supports bulk shifting of `thread_user_states.last_read_message_id` anchored
-- on deleted thread replies. `thread_user_states`' primary key leads with
-- `chat_id`, so `WHERE thread_root_id = $1 AND last_read_message_id = ANY($2)`
-- cannot use the PK prefix. Since `thread_root_id` is a globally unique message
-- id, this index scopes the update without chat_id.
CREATE INDEX IF NOT EXISTS idx_thread_user_states_root_read_pointer
ON thread_user_states (thread_root_id, last_read_message_id)
WHERE last_read_message_id IS NOT NULL;
