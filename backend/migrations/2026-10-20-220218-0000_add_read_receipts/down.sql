ALTER TABLE thread_user_states DROP COLUMN last_read_receipt_message_id;

ALTER TABLE group_membership DROP COLUMN last_read_receipt_message_id;

ALTER TABLE friendships
    DROP COLUMN uid2_shares_read_receipts,
    DROP COLUMN uid1_shares_read_receipts;

ALTER TABLE user_extra DROP COLUMN read_receipt_visibility;

DROP TYPE read_receipt_visibility;
