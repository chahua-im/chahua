CREATE INDEX CONCURRENTLY idx_messages_unread_visible
    ON messages (chat_id, id DESC)
    WHERE deleted_at IS NULL
      AND is_published = true
      AND reply_root_id IS NULL;
