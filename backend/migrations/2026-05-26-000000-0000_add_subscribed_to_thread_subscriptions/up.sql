-- Add the subscribed column to distinguish active subscriptions from read-only tracking rows,
-- then rename the table to reflect that it now stores more than just subscription info.
ALTER TABLE thread_subscriptions ADD COLUMN subscribed BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE thread_subscriptions RENAME TO thread_user_states;
