ALTER TABLE user_extra
    ALTER COLUMN mute_group_chats_by_default SET DEFAULT TRUE;

UPDATE user_extra
SET mute_group_chats_by_default = TRUE,
    mute_direct_chats_by_default = FALSE
WHERE mute_group_chats_by_default IS DISTINCT FROM TRUE
   OR mute_direct_chats_by_default IS DISTINCT FROM FALSE;

-- This is a one-time reset of membership preferences, not a message-history scan.
-- Every group membership inherits the new default, regardless of its old setting.
UPDATE group_membership gm
SET muted_until = NULL,
    mute_override = NULL
FROM groups g
WHERE g.id = gm.chat_id
  AND g.kind = 'group'
  AND (gm.muted_until IS NOT NULL OR gm.mute_override IS NOT NULL);

-- Legacy archiving also wrote the permanent sentinel. Treat that ambiguous
-- state as archive-owned: archive remains set, but unarchiving can notify again.
UPDATE group_membership gm
SET muted_until = NULL,
    mute_override = NULL
FROM groups g
WHERE g.id = gm.chat_id
  AND g.kind = 'dm'
  AND gm.archived = TRUE
  AND gm.muted_until = TIMESTAMPTZ '9999-12-31 23:59:59+00';

-- Keep the legacy timestamp until clients consume explicit overrides as well.
UPDATE group_membership gm
SET mute_override = TRUE
FROM groups g
WHERE g.id = gm.chat_id
  AND g.kind = 'dm'
  AND gm.archived = FALSE
  AND gm.muted_until = TIMESTAMPTZ '9999-12-31 23:59:59+00'
  AND gm.mute_override IS DISTINCT FROM TRUE;
