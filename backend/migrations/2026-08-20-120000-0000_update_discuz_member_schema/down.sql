DROP INDEX IF EXISTS discuz.idx_44357_loginname;

ALTER TABLE discuz.common_member
    DROP COLUMN IF EXISTS loginname;

ALTER TABLE discuz.common_member
    ALTER COLUMN username TYPE bpchar(15) USING substr(btrim(username), 1, 15);

ALTER TABLE discuz.common_member
    ADD COLUMN IF NOT EXISTS videophotostatus int2 DEFAULT '0'::smallint NOT NULL;

ALTER TABLE discuz.common_member_profile
    DROP COLUMN IF EXISTS fields;
