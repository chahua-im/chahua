DROP INDEX idx_messages_non_membership_top_level;

ALTER TABLE messages DROP CONSTRAINT messages_system_kind_matches_type;
ALTER TABLE messages DROP COLUMN system_kind;
DROP TYPE system_message_kind;
