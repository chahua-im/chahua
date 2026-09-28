CREATE TABLE message_views (
    uid INTEGER NOT NULL,
    message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    viewed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (uid, message_id)
);
