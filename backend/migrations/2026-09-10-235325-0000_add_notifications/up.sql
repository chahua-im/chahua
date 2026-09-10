-- Mentions and replies share one unread-notification pipeline. A row records
-- either an explicit @mention or a reply to one of the target's messages.
CREATE TYPE mention_kind AS ENUM ('mention', 'reply');

CREATE TABLE message_mentions (
    message_id     BIGINT NOT NULL REFERENCES messages(id),
    mentioned_uid  INTEGER NOT NULL,
    chat_id        BIGINT NOT NULL REFERENCES groups(id),
    thread_root_id BIGINT NULL,
    kind           mention_kind NOT NULL DEFAULT 'mention',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (message_id, mentioned_uid)
);

-- Supports unread mention counts and jump-to-mention in main and thread scopes.
CREATE INDEX message_mentions_unread_idx
    ON message_mentions (mentioned_uid, chat_id, thread_root_id, message_id);

-- Reactions have a timestamp cursor because message read pointers cannot record
-- when a user has seen a reaction. The default prevents pre-deploy reactions
-- from becoming unread notifications.
ALTER TABLE group_membership
    ADD COLUMN last_reactions_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE thread_user_states
    ADD COLUMN last_reactions_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Denormalize the target message author so unread reaction queries can filter
-- and range-scan the reactions table without scanning historical messages.
ALTER TABLE message_reactions
    ADD COLUMN message_author_uid INTEGER;

-- Legacy rows may outlive their soft-deleted target messages. They cannot
-- produce a notification and have no author to denormalize.
DELETE FROM message_reactions mr
WHERE NOT EXISTS (
    SELECT 1
    FROM messages m
    WHERE m.id = mr.message_id
);

UPDATE message_reactions mr
SET message_author_uid = m.sender_uid
FROM messages m
WHERE m.id = mr.message_id;

ALTER TABLE message_reactions
    ALTER COLUMN message_author_uid SET NOT NULL;

CREATE INDEX idx_message_reactions_author_created
    ON message_reactions (message_author_uid, created_at);
