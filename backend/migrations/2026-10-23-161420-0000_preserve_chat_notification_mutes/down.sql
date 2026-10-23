-- Backfilled overrides cannot be distinguished from pre-existing or later
-- explicit overrides. Clearing them would discard user preferences.
DO $$ BEGIN
    RAISE EXCEPTION 'The permanent mute exception backfill is irreversible; restore a pre-migration backup to recover previous overrides';
END $$;
