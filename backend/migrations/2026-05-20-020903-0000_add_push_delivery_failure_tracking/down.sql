-- This file should undo anything in `up.sql`
ALTER TABLE push_subscriptions
    DROP COLUMN last_delivery_error_at,
    DROP COLUMN last_delivery_error,
    DROP COLUMN delivery_failure_count;
