CREATE INDEX idx_invites_active_targeted_lookup
ON invites(chat_id, target_uid, created_at DESC, id DESC)
WHERE invite_type = 'targeted'
    AND target_uid IS NOT NULL
    AND revoked_at IS NULL
    AND used_at IS NULL;
