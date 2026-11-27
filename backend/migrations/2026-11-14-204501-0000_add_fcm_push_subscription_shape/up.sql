-- Unify push_subscriptions onto (provider, scope, target) with a single
-- non-partial unique index and require client_id on every row.
DELETE FROM push_subscriptions
WHERE client_id IS NULL
   OR btrim(COALESCE(endpoint, device_token, '')) = '';

ALTER TABLE push_subscriptions
    ADD COLUMN scope TEXT NOT NULL DEFAULT '',
    ADD COLUMN target TEXT;

UPDATE push_subscriptions
SET
    scope = CASE
        WHEN provider = 'apns' THEN apns_environment::text
        ELSE ''
    END,
    target = CASE
        WHEN provider = 'web_push' THEN endpoint
        ELSE device_token
    END,
    provider_data = CASE
        WHEN provider = 'apns' THEN '{}'::jsonb
        ELSE provider_data
    END;

WITH ranked AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY provider, scope, target
            ORDER BY created_at DESC, id DESC
        ) AS row_num
    FROM push_subscriptions
)
DELETE FROM push_subscriptions
WHERE id IN (SELECT id FROM ranked WHERE row_num > 1);

ALTER TABLE push_subscriptions
    ALTER COLUMN client_id SET NOT NULL,
    ALTER COLUMN target SET NOT NULL;

ALTER TABLE push_subscriptions
    DROP CONSTRAINT IF EXISTS push_subscriptions_provider_shape_check;

DROP INDEX IF EXISTS idx_push_subscriptions_web_user_endpoint;
DROP INDEX IF EXISTS idx_push_subscriptions_apns_provider_token_environment;
DROP INDEX IF EXISTS idx_push_subscriptions_fcm_device_token;

ALTER TABLE push_subscriptions
    DROP COLUMN endpoint,
    DROP COLUMN device_token,
    DROP COLUMN apns_environment;

DROP TYPE IF EXISTS push_environment;

CREATE UNIQUE INDEX idx_push_subscriptions_provider_scope_target
    ON push_subscriptions(provider, scope, target);

ALTER TABLE push_subscriptions
    ADD CONSTRAINT push_subscriptions_provider_shape_check
    CHECK (
        btrim(target) <> ''
        AND (
            (
                provider = 'web_push'
                AND scope = ''
                AND provider_data ? 'p256dh'
                AND provider_data ? 'auth'
            )
            OR (
                provider = 'apns'
                AND scope IN ('sandbox', 'production')
            )
            OR (
                provider = 'fcm'
                AND scope = ''
            )
        )
    );
