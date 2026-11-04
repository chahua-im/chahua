CREATE SEQUENCE chat_unread_revision_sequence AS BIGINT;

CREATE TABLE chat_unread_revisions (
    chat_id BIGINT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    revision BIGINT NOT NULL DEFAULT 0
);

ALTER SEQUENCE chat_unread_revision_sequence OWNED BY chat_unread_revisions.revision;

INSERT INTO chat_unread_revisions (chat_id)
SELECT id FROM groups;

-- Transition tables bump each affected chat once, including bulk mutations.
-- Body edits, reactions and thread-only changes do not invalidate main counts.
CREATE FUNCTION advance_chat_unread_revisions() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    affected_chat_ids BIGINT[];
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT array_agg(DISTINCT chat_id) INTO affected_chat_ids
        FROM inserted_messages
        WHERE reply_root_id IS NULL AND is_published AND deleted_at IS NULL;
    ELSIF TG_OP = 'DELETE' THEN
        SELECT array_agg(DISTINCT chat_id) INTO affected_chat_ids
        FROM deleted_messages
        WHERE reply_root_id IS NULL AND is_published AND deleted_at IS NULL;
    ELSE
        WITH changed AS (
            SELECT previous.chat_id AS old_chat_id, following.chat_id AS new_chat_id
            FROM old_messages previous FULL JOIN new_messages following USING (id)
            WHERE (
                (previous.reply_root_id IS NULL AND previous.is_published AND previous.deleted_at IS NULL)
                OR (following.reply_root_id IS NULL AND following.is_published AND following.deleted_at IS NULL)
            )
            AND ROW(previous.id, previous.chat_id, previous.reply_root_id, previous.is_published,
                    previous.deleted_at, previous.system_kind)
                IS DISTINCT FROM
                ROW(following.id, following.chat_id, following.reply_root_id, following.is_published,
                    following.deleted_at, following.system_kind)
        )
        SELECT array_agg(DISTINCT ids.chat_id) INTO affected_chat_ids
        FROM changed
        CROSS JOIN LATERAL (VALUES (old_chat_id), (new_chat_id)) AS ids(chat_id)
        WHERE ids.chat_id IS NOT NULL;
    END IF;

    IF affected_chat_ids IS NOT NULL THEN
        INSERT INTO chat_unread_revisions (chat_id, revision)
        SELECT g.id, nextval('chat_unread_revision_sequence')
        FROM groups g
        WHERE g.id = ANY(affected_chat_ids)
        ORDER BY g.id
        ON CONFLICT (chat_id) DO UPDATE
            SET revision = nextval('chat_unread_revision_sequence');
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER messages_unread_revision_insert
AFTER INSERT ON messages
REFERENCING NEW TABLE AS inserted_messages
FOR EACH STATEMENT EXECUTE FUNCTION advance_chat_unread_revisions();

CREATE TRIGGER messages_unread_revision_delete
AFTER DELETE ON messages
REFERENCING OLD TABLE AS deleted_messages
FOR EACH STATEMENT EXECUTE FUNCTION advance_chat_unread_revisions();

CREATE TRIGGER messages_unread_revision_update
AFTER UPDATE ON messages
REFERENCING OLD TABLE AS old_messages NEW TABLE AS new_messages
FOR EACH STATEMENT EXECUTE FUNCTION advance_chat_unread_revisions();
