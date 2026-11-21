CREATE TABLE list_sync_meta (
    singleton BOOLEAN PRIMARY KEY CHECK (singleton),
    epoch UUID NOT NULL DEFAULT gen_random_uuid(),
    head BIGINT NOT NULL DEFAULT 0,
    retained_after BIGINT NOT NULL DEFAULT 0
);
INSERT INTO list_sync_meta (singleton) VALUES (true);

CREATE TABLE list_sync_shared (
    chat_id BIGINT NOT NULL,
    thread_root_id BIGINT NOT NULL DEFAULT 0,
    seq BIGINT NOT NULL,
    identity_seq BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, thread_root_id)
);
CREATE TABLE list_sync_personal (
    uid INT NOT NULL,
    chat_id BIGINT NOT NULL,
    thread_root_id BIGINT NOT NULL DEFAULT 0,
    seq BIGINT NOT NULL,
    removed BOOLEAN NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (uid, chat_id, thread_root_id)
);
CREATE INDEX list_sync_personal_uid_seq_idx ON list_sync_personal (uid, seq);
CREATE INDEX list_sync_personal_removal_idx ON list_sync_personal (recorded_at) WHERE removed;
CREATE TABLE list_sync_account (uid INT PRIMARY KEY, seq BIGINT NOT NULL);
CREATE TABLE list_sync_pending (
    txid BIGINT NOT NULL DEFAULT txid_current(),
    uid INT,
    chat_id BIGINT,
    thread_root_id BIGINT NOT NULL DEFAULT 0,
    identity BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX list_sync_membership_uid_chat_idx ON group_membership (uid, chat_id);
CREATE INDEX list_sync_dm_uid2_idx ON groups (dm_uid2) WHERE kind = 'dm';
CREATE INDEX list_sync_pending_txid_idx ON list_sync_pending (txid);
CREATE INDEX list_sync_subscribed_uid_chat_root_idx
    ON thread_user_states (uid, chat_id, thread_root_id) WHERE subscribed;

CREATE FUNCTION flush_sync_pending() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    current_txid BIGINT := txid_current();
    position BIGINT;
    chat BIGINT;
    next_seq BIGINT;
    recorded TIMESTAMPTZ;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM list_sync_pending WHERE txid = current_txid)
       AND NOT EXISTS (SELECT 1 FROM message_sync_pending WHERE txid = current_txid) THEN
        RETURN NULL;
    END IF;
    UPDATE list_sync_meta SET head = head + 1 WHERE singleton
        RETURNING head INTO position;
    recorded := clock_timestamp();

    -- Fold message keys directly into the shared upsert; flushing must not
    -- enqueue more deferred triggers, especially under SET CONSTRAINTS.
    WITH shared_keys AS (
        SELECT p.chat_id, p.thread_root_id, p.identity
        FROM list_sync_pending p
        WHERE p.txid = current_txid AND p.uid IS NULL AND p.chat_id IS NOT NULL
        UNION ALL
        SELECT p.chat_id, COALESCE(m.reply_root_id, 0), false
        FROM message_sync_pending p JOIN messages m ON m.id = p.message_id AND m.chat_id = p.chat_id
        WHERE p.txid = current_txid AND m.is_published
        UNION ALL
        SELECT p.chat_id, m.id, false
        FROM message_sync_pending p JOIN messages m ON m.id = p.message_id AND m.chat_id = p.chat_id
        WHERE p.txid = current_txid AND m.is_published AND m.reply_root_id IS NULL AND m.has_thread
    )
    INSERT INTO list_sync_shared (chat_id, thread_root_id, seq, identity_seq)
    SELECT p.chat_id, p.thread_root_id, position,
           CASE WHEN bool_or(p.identity) THEN position ELSE 0 END
    FROM shared_keys p JOIN groups g ON g.id = p.chat_id
    GROUP BY p.chat_id, p.thread_root_id
    ON CONFLICT (chat_id, thread_root_id) DO UPDATE
    SET seq = EXCLUDED.seq,
        identity_seq = GREATEST(list_sync_shared.identity_seq, EXCLUDED.identity_seq);

    INSERT INTO list_sync_personal (uid, chat_id, thread_root_id, seq, removed, recorded_at)
    SELECT p.uid, p.chat_id, p.thread_root_id, position,
           NOT EXISTS (SELECT 1 FROM group_membership gm
                       WHERE gm.uid = p.uid AND gm.chat_id = p.chat_id)
           OR (p.thread_root_id <> 0 AND NOT EXISTS (
               SELECT 1 FROM thread_user_states ts
               WHERE ts.uid = p.uid AND ts.chat_id = p.chat_id
                 AND ts.thread_root_id = p.thread_root_id AND ts.subscribed)),
           recorded
    FROM list_sync_pending p
    WHERE p.txid = current_txid AND p.uid IS NOT NULL AND p.chat_id IS NOT NULL
    GROUP BY p.uid, p.chat_id, p.thread_root_id
    ON CONFLICT (uid, chat_id, thread_root_id) DO UPDATE
    SET seq = EXCLUDED.seq, removed = EXCLUDED.removed, recorded_at = EXCLUDED.recorded_at;

    INSERT INTO list_sync_account (uid, seq)
    SELECT DISTINCT uid, position FROM list_sync_pending
    WHERE txid = current_txid AND uid IS NOT NULL AND chat_id IS NULL
    ON CONFLICT (uid) DO UPDATE SET seq = EXCLUDED.seq;

    DELETE FROM list_sync_shared s USING list_sync_pending p
    WHERE p.txid = current_txid AND p.chat_id = s.chat_id
      AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = s.chat_id);

    FOR chat IN SELECT DISTINCT chat_id FROM message_sync_pending
                WHERE txid = current_txid ORDER BY chat_id
    LOOP
        -- A physical group deletion also cascades its message history.
        IF EXISTS (SELECT 1 FROM groups WHERE id = chat) THEN
            INSERT INTO message_sync_head (chat_id, head) VALUES (chat, 1)
            ON CONFLICT (chat_id) DO UPDATE SET head = message_sync_head.head + 1
            RETURNING head INTO next_seq;
            INSERT INTO message_sync_change (chat_id, seq, message_id, created, recorded_at)
            SELECT chat, next_seq, message_id, bool_or(created), recorded
            FROM message_sync_pending
            WHERE txid = current_txid AND chat_id = chat GROUP BY message_id;
        END IF;
    END LOOP;
    DELETE FROM message_sync_pending WHERE txid = current_txid;
    DELETE FROM list_sync_pending WHERE txid = current_txid;
    RETURN NULL;
END;
$$;
DROP TRIGGER message_sync_flush ON message_sync_pending;
CREATE CONSTRAINT TRIGGER message_sync_flush AFTER INSERT ON message_sync_pending
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION flush_sync_pending();
CREATE CONSTRAINT TRIGGER list_sync_flush AFTER INSERT ON list_sync_pending
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION flush_sync_pending();

-- Each trigger exposes statement transition tables under the same names.
-- Missing sides are empty typed relations, allowing one set-based capture path.
CREATE FUNCTION capture_list_sync_changes() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    old_sql TEXT;
    new_sql TEXT;
    body TEXT;
BEGIN
    old_sql := CASE WHEN TG_OP = 'INSERT' THEN format('SELECT * FROM %I WHERE false', TG_TABLE_NAME)
                    ELSE 'SELECT * FROM old_rows' END;
    new_sql := CASE WHEN TG_OP = 'DELETE' THEN format('SELECT * FROM %I WHERE false', TG_TABLE_NAME)
                    ELSE 'SELECT * FROM new_rows' END;
    CASE TG_TABLE_NAME
    WHEN 'messages' THEN
        -- Preserve the old root eligibility even if no row survives until flush.
        body := $q$
            WITH changed AS (
                SELECT o.id FROM o LEFT JOIN n USING (id)
                WHERE n.id IS NULL OR
                    ROW(o.chat_id,o.reply_root_id,o.is_published,o.message,o.metadata,o.deleted_at,o.updated_at,
                        o.has_attachments,o.sticker_id,o.system_kind,o.transcode_status,o.has_thread)
                    IS DISTINCT FROM
                    ROW(n.chat_id,n.reply_root_id,n.is_published,n.message,n.metadata,n.deleted_at,n.updated_at,
                        n.has_attachments,n.sticker_id,n.system_kind,n.transcode_status,n.has_thread)
            )
            INSERT INTO list_sync_pending (chat_id, thread_root_id)
            SELECT DISTINCT x.chat_id, x.root FROM (
                SELECT o.chat_id, COALESCE(o.reply_root_id, 0) AS root
                  FROM o JOIN changed USING (id) WHERE o.is_published
                UNION ALL
                SELECT o.chat_id, o.id FROM o JOIN changed USING (id)
                  WHERE o.is_published AND o.reply_root_id IS NULL AND o.has_thread
                UNION ALL
                SELECT n.chat_id, COALESCE(n.reply_root_id, 0) FROM n JOIN changed USING (id) WHERE n.is_published
                UNION ALL
                SELECT n.chat_id, n.id FROM n JOIN changed USING (id)
                  WHERE n.is_published AND n.reply_root_id IS NULL AND n.has_thread
            ) x$q$;
    WHEN 'groups' THEN
        body := $q$
            INSERT INTO list_sync_pending (chat_id, identity)
            SELECT COALESCE(o.id,n.id),
                   o.id IS NULL OR n.id IS NULL OR
                   ROW(o.name,o.avatar_image_id) IS DISTINCT FROM ROW(n.name,n.avatar_image_id)
            FROM o FULL JOIN n USING (id)
            WHERE o.id IS NULL OR n.id IS NULL OR
                  ROW(o.name,o.avatar_image_id,o.membership_message_visibility,o.last_message_id)
                  IS DISTINCT FROM
                  ROW(n.name,n.avatar_image_id,n.membership_message_visibility,n.last_message_id)$q$;
    WHEN 'media' THEN
        body := $q$
            INSERT INTO list_sync_pending (chat_id, identity)
            SELECT DISTINCT g.id, true FROM o JOIN n USING (id)
            JOIN groups g ON g.avatar_image_id = n.id
            WHERE ROW(o.deleted_at,o.storage_key) IS DISTINCT FROM ROW(n.deleted_at,n.storage_key)$q$;
    WHEN 'group_membership' THEN
        body := $q$
            WITH changed AS (
                SELECT COALESCE(o.uid,n.uid) uid, COALESCE(o.chat_id,n.chat_id) chat_id,
                       o.uid IS NULL OR n.uid IS NULL membership_changed,
                       o.last_read_receipt_message_id IS DISTINCT FROM n.last_read_receipt_message_id receipt_changed
                FROM o FULL JOIN n USING (uid,chat_id)
                WHERE o.uid IS NULL OR n.uid IS NULL OR
                    ROW(o.role,o.last_read_message_id,o.archived,o.muted_until,o.mute_override,
                        o.last_reactions_read_at,o.last_read_receipt_message_id)
                    IS DISTINCT FROM
                    ROW(n.role,n.last_read_message_id,n.archived,n.muted_until,n.mute_override,
                        n.last_reactions_read_at,n.last_read_receipt_message_id)
            )
            INSERT INTO list_sync_pending (uid,chat_id,thread_root_id)
            SELECT uid,chat_id,0 FROM changed
            UNION ALL
            SELECT c.uid,c.chat_id,t.thread_root_id FROM changed c
              JOIN thread_user_states t ON t.uid=c.uid AND t.chat_id=c.chat_id AND t.subscribed
              WHERE c.membership_changed
            UNION ALL
            SELECT NULL,c.chat_id,0 FROM changed c JOIN groups g ON g.id=c.chat_id
              WHERE c.receipt_changed AND g.kind='dm'$q$;
    WHEN 'thread_user_states' THEN
        body := $q$
            WITH changed AS (
                SELECT COALESCE(o.uid,n.uid) uid, COALESCE(o.chat_id,n.chat_id) chat_id,
                       COALESCE(o.thread_root_id,n.thread_root_id) root,
                       o.last_read_receipt_message_id IS DISTINCT FROM n.last_read_receipt_message_id receipt_changed
                FROM o FULL JOIN n USING (uid,chat_id,thread_root_id)
                WHERE o.uid IS NULL OR n.uid IS NULL OR
                    ROW(o.subscribed,o.subscribed_at,o.archived,o.last_read_message_id,
                        o.last_reactions_read_at,o.last_read_receipt_message_id)
                    IS DISTINCT FROM
                    ROW(n.subscribed,n.subscribed_at,n.archived,n.last_read_message_id,
                        n.last_reactions_read_at,n.last_read_receipt_message_id)
            )
            INSERT INTO list_sync_pending (uid,chat_id,thread_root_id)
            SELECT uid,chat_id,root FROM changed
            UNION ALL
            SELECT NULL,c.chat_id,c.root FROM changed c JOIN groups g ON g.id=c.chat_id
              WHERE c.receipt_changed AND g.kind='dm'$q$;
    WHEN 'thread_meta' THEN
        body := $q$
            INSERT INTO list_sync_pending (chat_id,thread_root_id)
            SELECT COALESCE(o.chat_id,n.chat_id),COALESCE(o.thread_root_id,n.thread_root_id)
            FROM o FULL JOIN n USING (chat_id,thread_root_id)
            WHERE o.chat_id IS NULL OR n.chat_id IS NULL OR
                  ROW(o.reply_count,o.last_reply_at) IS DISTINCT FROM ROW(n.reply_count,n.last_reply_at)$q$;
    WHEN 'user_extra' THEN
        body := $q$
            WITH changed AS (
                SELECT COALESCE(o.uid,n.uid) uid,
                    ROW(COALESCE(o.show_membership_messages,true),COALESCE(o.mute_group_chats_by_default,false),
                        COALESCE(o.mute_direct_chats_by_default,false))
                    IS DISTINCT FROM
                    ROW(COALESCE(n.show_membership_messages,true),COALESCE(n.mute_group_chats_by_default,false),
                        COALESCE(n.mute_direct_chats_by_default,false)) account_changed,
                    COALESCE(o.read_receipt_visibility,'friends'::read_receipt_visibility)
                    IS DISTINCT FROM COALESCE(n.read_receipt_visibility,'friends'::read_receipt_visibility) receipt_changed
                FROM o FULL JOIN n USING (uid)
            )
            INSERT INTO list_sync_pending (uid,chat_id,identity)
            SELECT uid,NULL,false FROM changed WHERE account_changed
            UNION ALL
            SELECT NULL,g.id,true FROM changed c JOIN groups g
                ON g.kind='dm' AND (g.dm_uid1=c.uid OR g.dm_uid2=c.uid)
                WHERE c.receipt_changed$q$;
    WHEN 'friendships' THEN
        body := $q$
            WITH changed AS (
                SELECT COALESCE(o.uid1,n.uid1) uid1,COALESCE(o.uid2,n.uid2) uid2
                FROM o FULL JOIN n USING (uid1,uid2)
                WHERE o.uid1 IS NULL OR n.uid1 IS NULL OR
                    ROW(o.uid1_shares_read_receipts,o.uid2_shares_read_receipts)
                    IS DISTINCT FROM ROW(n.uid1_shares_read_receipts,n.uid2_shares_read_receipts)
            )
            INSERT INTO list_sync_pending (chat_id,identity)
            SELECT DISTINCT g.id,true FROM changed c JOIN groups g
              ON g.kind='dm' AND ((g.dm_uid1=c.uid1 AND g.dm_uid2=c.uid2)
                               OR (g.dm_uid1=c.uid2 AND g.dm_uid2=c.uid1))$q$;
    WHEN 'blocks' THEN
        body := $q$
            INSERT INTO list_sync_pending (chat_id,identity)
            SELECT DISTINCT g.id,true FROM (SELECT blocker_uid,blocked_uid FROM o UNION SELECT blocker_uid,blocked_uid FROM n) c
            JOIN groups g ON g.kind='dm' AND ((g.dm_uid1=c.blocker_uid AND g.dm_uid2=c.blocked_uid)
                                            OR (g.dm_uid1=c.blocked_uid AND g.dm_uid2=c.blocker_uid))$q$;
    WHEN 'message_mentions' THEN
        body := $q$
            WITH changed AS (
                SELECT o.chat_id old_chat,o.thread_root_id old_root,
                       n.chat_id new_chat,n.thread_root_id new_root
                FROM o FULL JOIN n USING (message_id,mentioned_uid)
                WHERE o.message_id IS NULL OR n.message_id IS NULL OR
                      ROW(o.chat_id,o.thread_root_id) IS DISTINCT FROM ROW(n.chat_id,n.thread_root_id)
            )
            INSERT INTO list_sync_pending (chat_id,thread_root_id)
            SELECT old_chat,COALESCE(old_root,0) FROM changed WHERE old_chat IS NOT NULL
            UNION
            SELECT new_chat,COALESCE(new_root,0) FROM changed WHERE new_chat IS NOT NULL$q$;
    WHEN 'attachments' THEN
        body := $q$
            WITH changed AS (
                SELECT o.message_id old_id,n.message_id new_id
                FROM o FULL JOIN n USING (id)
                WHERE o.id IS NULL OR n.id IS NULL OR
                    ROW(o.message_id,o."order",o.kind,o.deleted_at)
                    IS DISTINCT FROM ROW(n.message_id,n."order",n.kind,n.deleted_at)
            ), affected AS (
                SELECT old_id id FROM changed UNION SELECT new_id FROM changed
            )
            INSERT INTO list_sync_pending (chat_id,thread_root_id)
            SELECT DISTINCT m.chat_id,COALESCE(m.reply_root_id,0) FROM affected a JOIN messages m ON m.id=a.id
              WHERE m.is_published
            UNION
            SELECT DISTINCT m.chat_id,m.id FROM affected a JOIN messages m ON m.id=a.id
              WHERE m.is_published AND m.reply_root_id IS NULL AND m.has_thread$q$;
    WHEN 'stickers' THEN
        body := $q$
            WITH changed AS (SELECT n.id FROM o JOIN n USING (id) WHERE o.emoji IS DISTINCT FROM n.emoji)
            INSERT INTO list_sync_pending (chat_id,thread_root_id)
            SELECT DISTINCT m.chat_id,COALESCE(m.reply_root_id,0) FROM changed c JOIN messages m ON m.sticker_id=c.id
              WHERE m.is_published
            UNION
            SELECT DISTINCT m.chat_id,m.id FROM changed c JOIN messages m ON m.sticker_id=c.id
              WHERE m.is_published AND m.reply_root_id IS NULL AND m.has_thread$q$;
    ELSE
        RAISE EXCEPTION 'unexpected list sync source %', TG_TABLE_NAME;
    END CASE;
    body := btrim(body, E' \n\r\t');
    IF left(body, 5) = 'WITH ' THEN
        EXECUTE format('WITH o AS (%s), n AS (%s), %s', old_sql, new_sql, substr(body, 6));
    ELSE
        EXECUTE format('WITH o AS (%s), n AS (%s) %s', old_sql, new_sql, body);
    END IF;
    RETURN NULL;
END;
$$;

DO $$
DECLARE
    source TEXT;
    operation TEXT;
    events TEXT[];
    transition TEXT;
BEGIN
    FOREACH source IN ARRAY ARRAY['messages','groups','media','group_membership',
        'thread_user_states','thread_meta','user_extra','friendships','blocks',
        'message_mentions','attachments','stickers']
    LOOP
        events := CASE source
            WHEN 'messages' THEN ARRAY['UPDATE','DELETE']
            WHEN 'media' THEN ARRAY['UPDATE']
            WHEN 'stickers' THEN ARRAY['UPDATE']
            ELSE ARRAY['INSERT','UPDATE','DELETE'] END;
        FOREACH operation IN ARRAY events LOOP
            transition := CASE operation
                WHEN 'INSERT' THEN 'NEW TABLE AS new_rows'
                WHEN 'DELETE' THEN 'OLD TABLE AS old_rows'
                ELSE 'OLD TABLE AS old_rows NEW TABLE AS new_rows' END;
            EXECUTE format('CREATE TRIGGER %I AFTER %s ON %I REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION capture_list_sync_changes()',
                           'list_sync_' || source || '_' || lower(operation), operation, source, transition);
        END LOOP;
    END LOOP;
END;
$$;
