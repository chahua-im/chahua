ALTER TABLE messages
    ADD COLUMN forwarded_from_message_id BIGINT NULL REFERENCES messages(id),
    ADD COLUMN forwarded_from_chat_id     BIGINT NULL,
    ADD COLUMN forwarded_from_sender_uid  INTEGER NULL;

CREATE INDEX idx_messages_forwarded_from
    ON messages (forwarded_from_message_id)
    WHERE forwarded_from_message_id IS NOT NULL;
