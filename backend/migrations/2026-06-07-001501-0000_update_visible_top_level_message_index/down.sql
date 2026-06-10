DROP INDEX IF EXISTS idx_messages_visible_top_level_last;

CREATE INDEX idx_messages_visible_top_level_last
    ON messages(chat_id, id DESC)
    WHERE deleted_at IS NULL
      AND is_published = true
      AND reply_root_id IS NULL;

CREATE INDEX idx_messages_unread_count
    ON messages(chat_id, id DESC)
    WHERE deleted_at IS NULL
      AND is_published = true
      AND reply_root_id IS NULL;

CREATE INDEX idx_messages_chat_sender_active
    ON messages(chat_id, sender_uid, created_at DESC)
    WHERE deleted_at IS NULL
      AND is_published = true;
