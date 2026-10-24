-- Include deleted roots: a recalled root may still have visible thread replies.
CREATE INDEX idx_messages_chat_thread_roots
    ON messages (chat_id, id DESC)
    WHERE reply_root_id IS NULL AND has_thread = TRUE AND is_published = TRUE;

-- Cover distinct participant UID seeks without visiting message bodies.
CREATE INDEX idx_messages_thread_participants
    ON messages (reply_root_id, sender_uid)
    WHERE deleted_at IS NULL AND is_published = TRUE;
