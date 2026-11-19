CREATE TABLE message_sync_meta (
    singleton BOOLEAN PRIMARY KEY CHECK (singleton),
    epoch UUID NOT NULL DEFAULT gen_random_uuid()
);
INSERT INTO message_sync_meta (singleton) VALUES (true);

CREATE TABLE message_sync_head (
    chat_id BIGINT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
    head BIGINT NOT NULL DEFAULT 0,
    retained_after BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE message_sync_change (
    chat_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    seq BIGINT NOT NULL,
    message_id BIGINT NOT NULL,
    created BOOLEAN NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (chat_id, seq, message_id)
);
CREATE INDEX message_sync_change_recorded_at_idx ON message_sync_change (recorded_at);

CREATE FUNCTION record_message_sync_changes() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    affected RECORD;
    chat RECORD;
    next_seq BIGINT;
    recorded TIMESTAMPTZ;
BEGIN
    IF TG_TABLE_NAME = 'messages' AND TG_OP = 'INSERT' THEN
        SELECT array_agg(chat_id) AS chats, array_agg(id) AS ids,
               array_agg(reply_root_id) AS roots, array_agg(true) AS creates
        INTO affected
        FROM inserted_messages
        WHERE is_published;
    ELSIF TG_TABLE_NAME = 'messages' THEN
        SELECT array_agg(n.chat_id) AS chats, array_agg(n.id) AS ids,
               array_agg(n.reply_root_id) AS roots,
               array_agg(NOT o.is_published AND n.is_published) AS creates
        INTO affected
        FROM old_messages o JOIN new_messages n USING (id)
        WHERE (o.is_published OR n.is_published)
          AND ROW(o.is_published, o.message, o.metadata, o.deleted_at, o.updated_at,
                  o.has_attachments, o.sticker_id, o.system_kind, o.transcode_status, o.has_thread)
              IS DISTINCT FROM
              ROW(n.is_published, n.message, n.metadata, n.deleted_at, n.updated_at,
                  n.has_attachments, n.sticker_id, n.system_kind, n.transcode_status, n.has_thread);
    ELSE
        SELECT array_agg(m.chat_id) AS chats, array_agg(m.id) AS ids,
               NULL::BIGINT[] AS roots, array_agg(false) AS creates
        INTO affected
        FROM changed_reactions r JOIN messages m ON m.id = r.message_id
        WHERE m.is_published;
    END IF;

    FOR chat IN
        SELECT chat_id, array_agg(message_id) AS ids, array_agg(created) AS creates
        FROM (
            SELECT chat_id, message_id, bool_or(created) AS created
            FROM unnest(affected.chats, affected.ids, affected.roots, affected.creates)
                AS touched(chat_id, id, root, create_flag)
            CROSS JOIN LATERAL (VALUES (id, create_flag), (root, false)) AS expanded(message_id, created)
            WHERE message_id IS NOT NULL
            GROUP BY chat_id, message_id
        ) deduplicated
        GROUP BY chat_id
        ORDER BY chat_id
    LOOP
        INSERT INTO message_sync_head (chat_id, head)
        VALUES (chat.chat_id, 1)
        ON CONFLICT (chat_id) DO UPDATE SET head = message_sync_head.head + 1
        RETURNING head INTO next_seq;

        recorded := clock_timestamp();
        INSERT INTO message_sync_change (chat_id, seq, message_id, created, recorded_at)
        SELECT chat.chat_id, next_seq, message_id, created, recorded
        FROM unnest(chat.ids, chat.creates) AS change(message_id, created);
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE TRIGGER messages_sync_insert
AFTER INSERT ON messages
REFERENCING NEW TABLE AS inserted_messages
FOR EACH STATEMENT EXECUTE FUNCTION record_message_sync_changes();

CREATE TRIGGER messages_sync_update
AFTER UPDATE ON messages
REFERENCING OLD TABLE AS old_messages NEW TABLE AS new_messages
FOR EACH STATEMENT EXECUTE FUNCTION record_message_sync_changes();

CREATE TRIGGER message_reactions_sync_insert
AFTER INSERT ON message_reactions
REFERENCING NEW TABLE AS changed_reactions
FOR EACH STATEMENT EXECUTE FUNCTION record_message_sync_changes();

CREATE TRIGGER message_reactions_sync_delete
AFTER DELETE ON message_reactions
REFERENCING OLD TABLE AS changed_reactions
FOR EACH STATEMENT EXECUTE FUNCTION record_message_sync_changes();
