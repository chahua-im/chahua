-- Unread-reaction notifications: a per-user timestamp cursor marks which
-- reactions have been seen. Reactions are NOT messages, so the existing
-- message-id read pointers cannot express "I saw this reaction"; the cursor
-- is compared against message_reactions.created_at instead. DEFAULT NOW()
-- backfills existing rows with the migration instant, so everything before
-- deploy counts as read (no retroactive badge explosion).
ALTER TABLE group_membership
    ADD COLUMN last_reactions_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE thread_user_states
    ADD COLUMN last_reactions_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Unread-reaction counts are driven from the reaction rows ("reactions on my
-- messages newer than my cursor"), so the reaction row needs its target
-- message's author denormalized: no index on message_reactions can otherwise
-- serve a user-wide "reactions on my messages" filter, and driving from
-- messages(sender_uid) would scan every historical message. Backfill from the
-- messages table, then enforce NOT NULL.
ALTER TABLE message_reactions
    ADD COLUMN message_author_uid INTEGER;

UPDATE message_reactions mr
SET message_author_uid = m.sender_uid
FROM messages m
WHERE m.id = mr.message_id;

ALTER TABLE message_reactions
    ALTER COLUMN message_author_uid SET NOT NULL;

-- Serves the unread-reaction count/list queries: leading column selects the
-- reactions targeted at one user, created_at applies the read cursor range.
CREATE INDEX idx_message_reactions_author_created
    ON message_reactions (message_author_uid, created_at);
