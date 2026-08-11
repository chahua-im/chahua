-- This file should undo anything in `up.sql`
ALTER TABLE forwarded_bundles
DROP COLUMN child_bundle_ids;
