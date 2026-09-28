ALTER TYPE message_type ADD VALUE IF NOT EXISTS 'forwarded';

CREATE TABLE forwarded_bundles (
    id BIGINT PRIMARY KEY,
    created_by_uid INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    item_count INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND 100),
    payload JSONB NOT NULL,
    child_bundle_ids BIGINT[] NOT NULL DEFAULT '{}',
    preview JSONB NOT NULL
);

ALTER TABLE messages
ADD COLUMN forwarded_bundle_id BIGINT NULL REFERENCES forwarded_bundles(id);

ALTER TABLE saved_messages
ADD COLUMN forwarded_bundle_id BIGINT NULL REFERENCES forwarded_bundles(id);
