DO $$
DECLARE
    trigger_row RECORD;
BEGIN
    FOR trigger_row IN
        SELECT t.tgname, c.relname
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND t.tgname LIKE 'list_sync_%' AND NOT t.tgisinternal
    LOOP
        EXECUTE format('DROP TRIGGER %I ON %I', trigger_row.tgname, trigger_row.relname);
    END LOOP;
END;
$$;
DROP TRIGGER message_sync_flush ON message_sync_pending;
CREATE CONSTRAINT TRIGGER message_sync_flush
AFTER INSERT ON message_sync_pending
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION flush_message_sync_pending();
DROP FUNCTION flush_sync_pending();
DROP FUNCTION capture_list_sync_changes();
DROP INDEX IF EXISTS list_sync_membership_uid_chat_idx;
DROP INDEX IF EXISTS list_sync_dm_uid2_idx;
DROP INDEX list_sync_subscribed_uid_chat_root_idx;
DROP TABLE list_sync_pending;
DROP TABLE list_sync_account;
DROP TABLE list_sync_personal;
DROP TABLE list_sync_shared;
DROP TABLE list_sync_meta;
