-- Your SQL goes here
ALTER TABLE push_subscriptions
    ADD COLUMN delivery_failure_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN last_delivery_error TEXT,
    ADD COLUMN last_delivery_error_at TIMESTAMPTZ;
