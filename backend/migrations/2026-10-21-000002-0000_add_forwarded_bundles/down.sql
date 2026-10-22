ALTER TABLE saved_messages DROP COLUMN forwarded_bundle_id;
ALTER TABLE messages DROP COLUMN forwarded_bundle_id;
DROP TABLE forwarded_bundles;

-- PostgreSQL cannot drop enum values in place. Retain the unused 'forwarded' value.
