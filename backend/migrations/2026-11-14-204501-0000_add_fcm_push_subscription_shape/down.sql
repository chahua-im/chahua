DROP INDEX IF EXISTS idx_push_subscriptions_fcm_device_token;

DELETE FROM push_subscriptions
WHERE provider = 'fcm';

ALTER TABLE push_subscriptions
    DROP CONSTRAINT IF EXISTS push_subscriptions_provider_shape_check;

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
