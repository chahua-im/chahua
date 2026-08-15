ALTER TABLE attachments ADD COLUMN uploader_uid INTEGER;

UPDATE attachments AS a
SET uploader_uid = m.sender_uid
FROM messages AS m
WHERE a.message_id = m.id
  AND a.uploader_uid IS NULL;
