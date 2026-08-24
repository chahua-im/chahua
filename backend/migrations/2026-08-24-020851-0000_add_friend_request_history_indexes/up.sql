-- Directional request-history lookups are newest-first across every status.
CREATE INDEX idx_friend_requests_from_created_id
    ON friend_requests(from_uid, created_at DESC, id DESC);
CREATE INDEX idx_friend_requests_to_created_id
    ON friend_requests(to_uid, created_at DESC, id DESC);
