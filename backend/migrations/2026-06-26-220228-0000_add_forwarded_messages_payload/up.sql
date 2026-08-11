-- Your SQL goes here
ALTER TYPE message_type ADD VALUE IF NOT EXISTS 'forwarded';

ALTER TABLE messages
ADD COLUMN forwarded_messages_payload JSONB NULL;
