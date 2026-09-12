-- Unread-reaction cursors move to a monotonic per-row revision instead of
-- wall-clock timestamps. The reaction cursor must cover exactly the reactions a
-- snapshot listed: `created_at` cannot order concurrent inserts reliably (same
-- transaction timestamp, clock steps), so an identity revision allocated under
-- a per-chat advisory lock (see put_reaction / reactions read endpoints) gives
-- the watermark a strict commit-order meaning: ack(revision W) clears exactly
-- the reactions with revision <= W, all of which the snapshot listed.

ALTER TABLE message_reactions
    ADD COLUMN revision BIGINT GENERATED ALWAYS AS IDENTITY;

-- Cursor columns in identity-allocation order. Backfilled to the current max
-- revision so reactions that predate this migration stay read (matching the
-- old last_reactions_read_at DEFAULT NOW() semantics).
ALTER TABLE group_membership
    ADD COLUMN last_reactions_read_revision BIGINT NOT NULL DEFAULT 0;

ALTER TABLE thread_user_states
    ADD COLUMN last_reactions_read_revision BIGINT NOT NULL DEFAULT 0;

UPDATE group_membership
SET last_reactions_read_revision = (SELECT COALESCE(MAX(revision), 0) FROM message_reactions);

UPDATE thread_user_states
SET last_reactions_read_revision = (SELECT COALESCE(MAX(revision), 0) FROM message_reactions);

-- The timestamp cursors are no longer read or written by the backend. Remove
-- them (and their old index) so every reaction write does not maintain dead
-- compatibility state indefinitely. This migration requires old writers to be
-- drained before rollout; they cannot update a dropped timestamp column.
DROP INDEX IF EXISTS idx_message_reactions_author_created;

ALTER TABLE group_membership
    DROP COLUMN IF EXISTS last_reactions_read_at;

ALTER TABLE thread_user_states
    DROP COLUMN IF EXISTS last_reactions_read_at;

-- Serves the scoped watermark lookup: first locate messages in the chat/thread,
-- then probe reactions by message and author without scanning other chats.
CREATE INDEX idx_message_reactions_author_revision
    ON message_reactions (message_id, message_author_uid, revision DESC);
