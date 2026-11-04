DROP TRIGGER messages_unread_revision_update ON messages;
DROP TRIGGER messages_unread_revision_delete ON messages;
DROP TRIGGER messages_unread_revision_insert ON messages;
DROP FUNCTION advance_chat_unread_revisions();
DROP TABLE chat_unread_revisions;
