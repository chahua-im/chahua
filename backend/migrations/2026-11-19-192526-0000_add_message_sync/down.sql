DROP TRIGGER message_reactions_sync_delete ON message_reactions;
DROP TRIGGER message_reactions_sync_insert ON message_reactions;
DROP TRIGGER messages_sync_update ON messages;
DROP TRIGGER messages_sync_insert ON messages;
DROP FUNCTION record_message_sync_changes();
DROP TABLE message_sync_change;
DROP TABLE message_sync_head;
DROP TABLE message_sync_meta;
