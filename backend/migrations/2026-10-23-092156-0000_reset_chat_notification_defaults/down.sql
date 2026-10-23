-- The requested reset deliberately discards old group preferences. A down
-- migration cannot reconstruct them or distinguish later user changes.
DO $$ BEGIN
    RAISE EXCEPTION 'The notification preference reset is irreversible; restore a pre-migration backup to recover old preferences';
END $$;
