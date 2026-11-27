DELETE FROM push_subscriptions
WHERE provider = 'fcm';

ALTER TABLE push_subscriptions
    DROP CONSTRAINT IF EXISTS push_subscriptions_provider_shape_check;

DROP INDEX IF EXISTS idx_push_subscriptions_provider_scope_target;

CREATE TYPE push_environment AS ENUM ('sandbox', 'production');

ALTER TABLE push_subscriptions
    ADD COLUMN endpoint TEXT,
    ADD COLUMN device_token TEXT,
    ADD COLUMN apns_environment push_environment,
    ALTER COLUMN client_id DROP NOT NULL;

UPDATE push_subscriptions
SET
    endpoint = CASE
        WHEN provider = 'web_push' THEN target
        ELSE NULL
    END,
    device_token = CASE
        WHEN provider = 'apns' THEN target
        ELSE NULL
    END,
    apns_environment = CASE
        WHEN provider = 'apns' THEN scope::push_environment
        ELSE NULL
    END,
    provider_data = CASE
        WHEN provider = 'apns' THEN jsonb_build_object('environment', scope)
        ELSE provider_data
    END;

ALTER TABLE push_subscriptions
    DROP COLUMN scope,
    DROP COLUMN target;

CREATE UNIQUE INDEX idx_push_subscriptions_web_user_endpoint
    ON push_subscriptions(user_id, endpoint)
    WHERE provider = 'web_push';

CREATE UNIQUE INDEX idx_push_subscriptions_apns_provider_token_environment
    ON push_subscriptions(provider, device_token, apns_environment);

ALTER TABLE push_subscriptions
    ADD CONSTRAINT push_subscriptions_provider_shape_check
    CHECK (
        (
            provider = 'web_push'
            AND endpoint IS NOT NULL
            AND device_token IS NULL
            AND apns_environment IS NULL
            AND provider_data ? 'p256dh'
            AND provider_data ? 'auth'
        )
        OR (
            provider = 'apns'
            AND endpoint IS NULL
            AND device_token IS NOT NULL
            AND apns_environment IS NOT NULL
        )
    );
