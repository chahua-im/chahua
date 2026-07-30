-- Your SQL goes here
ALTER TABLE forwarded_bundles
ADD COLUMN child_bundle_ids BIGINT[] NOT NULL DEFAULT '{}';
