-- Preserve legacy permanent mutes as explicit exceptions for both chat kinds,
-- including archived chats. Keep the timestamp for legacy clients and leave
-- temporary mutes, existing overrides, and archive state otherwise unchanged.
-- This one-time backfill scans memberships, never message history.
UPDATE group_membership
SET mute_override = TRUE
WHERE muted_until = TIMESTAMPTZ '9999-12-31 23:59:59+00'
  AND mute_override IS DISTINCT FROM TRUE;
