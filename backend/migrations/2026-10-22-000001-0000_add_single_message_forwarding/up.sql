ALTER TABLE messages
ADD COLUMN forwarded_from_message_id BIGINT NULL REFERENCES messages(id);

-- Origin hydration looks up messages by their existing primary key. No reverse
-- lookup is needed, so an index on the referencing column is unnecessary.
