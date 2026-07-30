-- This file should undo anything in `up.sql`
ALTER TABLE messages
DROP COLUMN forwarded_messages_payload;

-- PostgreSQL does not support dropping enum values safely in-place.
