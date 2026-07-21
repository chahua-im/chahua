CREATE TABLE forwarded_bundles (
    id BIGINT PRIMARY KEY,
    created_by_uid INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    item_count INTEGER NOT NULL,
    payload JSONB NOT NULL
);

ALTER TABLE messages
ADD COLUMN forwarded_bundle_id BIGINT NULL REFERENCES forwarded_bundles(id);
