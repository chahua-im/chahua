-- Chat-level reaction read state: the new PWA marks a conversation's
-- reactions read on entry. Existing cursors may lag behind because older
-- clients never acknowledged reaction badges, so reset both scopes to NOW()
-- once. This intentionally clears the accumulated pre-deploy backlog and
-- guarantees nobody receives a pile of historical reaction badges on deploy.
--
-- The columns come from the base notification migration. The IF NOT EXISTS
-- guards also heal a database that previously ran an alternative reaction
-- migration which dropped them.
ALTER TABLE group_membership
    ADD COLUMN IF NOT EXISTS last_reactions_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE thread_user_states
    ADD COLUMN IF NOT EXISTS last_reactions_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE group_membership
    ALTER COLUMN last_reactions_read_at SET DEFAULT NOW();

ALTER TABLE thread_user_states
    ALTER COLUMN last_reactions_read_at SET DEFAULT NOW();

UPDATE group_membership
SET last_reactions_read_at = NOW();

UPDATE thread_user_states
SET last_reactions_read_at = NOW();
