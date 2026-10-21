CREATE TYPE read_receipt_visibility AS ENUM ('friends', 'nobody');

ALTER TABLE user_extra
    ADD COLUMN read_receipt_visibility read_receipt_visibility NOT NULL DEFAULT 'friends';

-- NULL means the current friend inherits the owner's global visibility setting.
ALTER TABLE friendships
    ADD COLUMN uid1_shares_read_receipts BOOLEAN,
    ADD COLUMN uid2_shares_read_receipts BOOLEAN;

-- These high-water markers deliberately remain independent from rewindable
-- unread cursors. Existing read state is the best known receipt on rollout.
ALTER TABLE group_membership
    ADD COLUMN last_read_receipt_message_id BIGINT;

UPDATE group_membership
SET last_read_receipt_message_id = last_read_message_id;

ALTER TABLE thread_user_states
    ADD COLUMN last_read_receipt_message_id BIGINT;

UPDATE thread_user_states
SET last_read_receipt_message_id = last_read_message_id;
