ALTER TABLE discuz.common_member
    ADD COLUMN IF NOT EXISTS loginname bpchar(50) DEFAULT ''::bpchar NOT NULL;

-- Discuz seeds loginname from username on upgrade; username is already unique,
-- so this backfill satisfies the unique index before the post-migration re-sync
-- replaces every row with authoritative upstream values.
UPDATE discuz.common_member SET loginname = username WHERE loginname = '';

ALTER TABLE discuz.common_member
    ALTER COLUMN username TYPE bpchar(50);

ALTER TABLE discuz.common_member
    DROP COLUMN IF EXISTS videophotostatus;

CREATE UNIQUE INDEX IF NOT EXISTS idx_44357_loginname
    ON discuz.common_member USING btree (loginname);

ALTER TABLE discuz.common_member_profile
    ADD COLUMN IF NOT EXISTS fields jsonb DEFAULT '{}'::jsonb NOT NULL;
