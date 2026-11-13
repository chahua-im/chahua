-- Reuse the reply-root index; retain thread activity and existence metadata.
UPDATE thread_meta AS tm
SET reply_count = (
    SELECT COUNT(*) FROM messages AS m
    WHERE m.reply_root_id = tm.thread_root_id
      AND m.deleted_at IS NULL AND m.is_published
);
