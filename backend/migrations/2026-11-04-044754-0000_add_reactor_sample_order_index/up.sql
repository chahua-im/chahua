CREATE INDEX idx_message_reactions_sample
    ON message_reactions (message_id, emoji, created_at, user_uid);
