ALTER TABLE messages
ADD COLUMN forwarded_from_message_id BIGINT NULL REFERENCES messages (id);
