-- Include deleted roots: surviving replies still make their threads discoverable.
-- Rebuild on retry to recover an interrupted concurrent index build.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_thread_root_date;
-- statement-break
CREATE INDEX CONCURRENTLY idx_messages_thread_root_date
ON messages (chat_id, created_at DESC, id DESC) INCLUDE (sender_uid)
WHERE reply_root_id IS NULL AND has_thread = TRUE AND is_published = TRUE;
