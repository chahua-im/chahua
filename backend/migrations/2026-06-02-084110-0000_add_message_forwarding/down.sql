DROP INDEX IF EXISTS idx_messages_forwarded_from;

ALTER TABLE messages
    DROP COLUMN IF EXISTS forwarded_from_message_id,
    DROP COLUMN IF EXISTS forwarded_from_chat_id,
    DROP COLUMN IF EXISTS forwarded_from_sender_uid;
