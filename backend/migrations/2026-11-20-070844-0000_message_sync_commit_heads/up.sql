CREATE TABLE message_sync_pending (
    txid BIGINT NOT NULL DEFAULT txid_current(),
    chat_id BIGINT NOT NULL,
    message_id BIGINT NOT NULL,
    created BOOLEAN NOT NULL
);
CREATE INDEX message_sync_pending_txid_idx ON message_sync_pending (txid);

CREATE OR REPLACE FUNCTION record_message_sync_changes() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    affected RECORD;
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

    INSERT INTO message_sync_pending (chat_id, message_id, created)
    SELECT chat_id, message_id, bool_or(created)
    FROM unnest(affected.chats, affected.ids, affected.roots, affected.creates)
        AS touched(chat_id, id, root, create_flag)
    CROSS JOIN LATERAL (VALUES (id, create_flag), (root, false)) AS expanded(message_id, created)
    WHERE message_id IS NOT NULL
    GROUP BY chat_id, message_id;
    RETURN NULL;
END;
$$;

CREATE FUNCTION flush_message_sync_pending() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    current_txid BIGINT := txid_current();
    chat BIGINT;
    next_seq BIGINT;
    recorded TIMESTAMPTZ;
BEGIN
    -- Only the first deferred invocation has rows to flush.
    IF NOT EXISTS (SELECT 1 FROM message_sync_pending WHERE txid = current_txid) THEN
        RETURN NULL;
    END IF;

    FOR chat IN
        SELECT DISTINCT chat_id
        FROM message_sync_pending
        WHERE txid = current_txid
        ORDER BY chat_id
    LOOP
        INSERT INTO message_sync_head (chat_id, head)
        VALUES (chat, 1)
        ON CONFLICT (chat_id) DO UPDATE SET head = message_sync_head.head + 1
        RETURNING head INTO next_seq;

        recorded := clock_timestamp();
        INSERT INTO message_sync_change (chat_id, seq, message_id, created, recorded_at)
        SELECT chat, next_seq, message_id, bool_or(created), recorded
        FROM message_sync_pending
        WHERE txid = current_txid AND chat_id = chat
        GROUP BY message_id;
    END LOOP;

    DELETE FROM message_sync_pending WHERE txid = current_txid;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER message_sync_flush
AFTER INSERT ON message_sync_pending
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION flush_message_sync_pending();
