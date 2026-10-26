CREATE TYPE sticker_pack_visibility AS ENUM ('public', 'private');

-- Both existing and newly created packs are public unless explicitly private.
ALTER TABLE sticker_packs
    ADD COLUMN visibility sticker_pack_visibility NOT NULL DEFAULT 'public';
