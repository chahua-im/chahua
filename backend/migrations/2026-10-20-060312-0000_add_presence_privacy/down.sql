ALTER TABLE friendships
    DROP COLUMN uid2_shares_presence,
    DROP COLUMN uid1_shares_presence;

ALTER TABLE user_extra DROP COLUMN presence_visibility;

DROP TYPE presence_visibility;
