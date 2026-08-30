-- Distinguishes why a message_mentions row exists: an explicit @mention in the
-- message body, or the message being a reply to one of the target's messages.
-- Reply rows let the unread-mention pipeline treat "someone replied to me" as
-- "someone mentioned me". The primary key stays (message_id, mentioned_uid) so
-- a message that both mentions and replies to the same user yields one row;
-- insert order gives the mention the row and reply inserts no-op on conflict.
CREATE TYPE mention_kind AS ENUM ('mention', 'reply');

ALTER TABLE message_mentions
    ADD COLUMN kind mention_kind NOT NULL DEFAULT 'mention';
