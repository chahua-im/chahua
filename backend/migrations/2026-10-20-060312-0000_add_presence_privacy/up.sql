CREATE TYPE presence_visibility AS ENUM ('everyone', 'friends', 'nobody');

ALTER TABLE user_extra
    ADD COLUMN presence_visibility presence_visibility NOT NULL DEFAULT 'everyone';

-- NULL means the current friend inherits the owner's global visibility setting.
ALTER TABLE friendships
    ADD COLUMN uid1_shares_presence BOOLEAN,
    ADD COLUMN uid2_shares_presence BOOLEAN;
