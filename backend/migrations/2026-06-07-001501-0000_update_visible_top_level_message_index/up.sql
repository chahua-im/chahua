DROP INDEX IF EXISTS idx_messages_visible_top_level_last;

CREATE INDEX idx_messages_visible_top_level_last
    ON messages(chat_id, id DESC)
    WHERE is_published = true
      AND reply_root_id IS NULL
      AND (deleted_at IS NULL OR has_thread = true);

DROP INDEX IF EXISTS idx_messages_unread_count;

DROP INDEX IF EXISTS idx_messages_chat_sender_active;
