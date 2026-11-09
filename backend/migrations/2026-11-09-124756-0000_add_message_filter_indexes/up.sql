-- Main/thread history seeks and sender-based thread discovery.
-- Existing ID-ordered history/participant indexes remain in use by their original APIs.
-- The app migration runner executes each marked statement separately.
-- Dropping first also recovers invalid indexes left by an interrupted concurrent build.
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_filter_chat_date;
-- statement-break
CREATE INDEX CONCURRENTLY idx_messages_filter_chat_date ON messages(chat_id, created_at DESC, id DESC)
WHERE deleted_at IS NULL AND is_published = TRUE AND message_type <> 'system' AND reply_root_id IS NULL;
-- statement-break
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_filter_sender_date;
-- statement-break
CREATE INDEX CONCURRENTLY idx_messages_filter_sender_date ON messages(chat_id, sender_uid, created_at DESC, id DESC)
WHERE deleted_at IS NULL AND is_published = TRUE AND message_type <> 'system' AND reply_root_id IS NULL;
-- statement-break
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_filter_thread_date;
-- statement-break
CREATE INDEX CONCURRENTLY idx_messages_filter_thread_date ON messages(reply_root_id, created_at DESC, id DESC)
WHERE deleted_at IS NULL AND is_published = TRUE AND message_type <> 'system' AND reply_root_id IS NOT NULL;
-- statement-break
DROP INDEX CONCURRENTLY IF EXISTS idx_messages_sender_participation;
-- statement-break
CREATE INDEX CONCURRENTLY idx_messages_sender_participation ON messages(chat_id, sender_uid, created_at, id) INCLUDE (reply_root_id)
WHERE is_published = TRUE AND ((reply_root_id IS NOT NULL AND deleted_at IS NULL) OR (reply_root_id IS NULL AND has_thread = TRUE));
