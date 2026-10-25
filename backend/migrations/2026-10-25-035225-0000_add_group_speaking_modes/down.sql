ALTER TABLE group_membership
    DROP CONSTRAINT admin_speaking_mode_unrestricted,
    DROP COLUMN speaking_mode;
ALTER TABLE groups
    DROP CONSTRAINT dm_speaking_mode_unrestricted,
    DROP COLUMN speaking_mode;
DROP TYPE speaking_mode;
