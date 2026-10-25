CREATE TYPE system_message_kind AS ENUM (
    'member_joined', 'member_left', 'member_added', 'member_removed',
    'message_pinned', 'message_unpinned',
    'thread_message_pinned', 'thread_message_unpinned',
    'friend_request_accepted', 'unknown'
);

ALTER TABLE messages ADD COLUMN system_kind system_message_kind;

-- This decoder exists only during backfill. New writes specify their event kind.
CREATE FUNCTION pg_temp.legacy_system_kind(body text) RETURNS system_message_kind
LANGUAGE plpgsql AS $$
DECLARE
    phrase text := body;
    stored jsonb;
BEGIN
    IF left(ltrim(body), 1) = '{' THEN
        BEGIN
            stored := body::jsonb;
            IF jsonb_typeof(stored->'text') = 'string'
               AND jsonb_typeof(stored->'links') = 'object' THEN
                phrase := stored->>'text';
            END IF;
        EXCEPTION WHEN invalid_text_representation THEN
            -- Unrecognized legacy bodies remain visible as unknown events.
        END;
    END IF;
    RETURN CASE
        WHEN phrase = 'joined the chat' THEN 'member_joined'
        WHEN phrase = 'left the chat' THEN 'member_left'
        WHEN starts_with(phrase, 'added ') THEN 'member_added'
        WHEN starts_with(phrase, 'removed ') THEN 'member_removed'
        WHEN phrase = 'pinned a message' THEN 'message_pinned'
        WHEN phrase = 'unpinned a message' THEN 'message_unpinned'
        WHEN phrase = 'pinned a message in this thread' THEN 'thread_message_pinned'
        WHEN phrase = 'unpinned a message in this thread' THEN 'thread_message_unpinned'
        WHEN phrase LIKE 'accepted %''s friend request' THEN 'friend_request_accepted'
        ELSE 'unknown'
    END::system_message_kind;
END;
$$;

UPDATE messages SET system_kind = pg_temp.legacy_system_kind(message)
WHERE message_type = 'system';
DROP FUNCTION pg_temp.legacy_system_kind(text);

ALTER TABLE messages ADD CONSTRAINT messages_system_kind_matches_type CHECK (
    (message_type = 'system' AND system_kind IS NOT NULL)
    OR (message_type <> 'system' AND system_kind IS NULL)
);

CREATE INDEX idx_messages_non_membership_top_level
ON messages(chat_id, id DESC)
WHERE is_published = true AND reply_root_id IS NULL
  AND (deleted_at IS NULL OR has_thread = true)
  AND (system_kind IS NULL OR system_kind NOT IN ('member_joined', 'member_left', 'member_added', 'member_removed'));
