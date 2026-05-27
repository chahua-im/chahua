ALTER TABLE thread_user_states RENAME TO thread_subscriptions;
ALTER TABLE thread_subscriptions DROP COLUMN subscribed;
