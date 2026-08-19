ALTER TABLE groups DROP CONSTRAINT groups_dm_pair_consistent;
DROP INDEX uniq_groups_dm_pair;
ALTER TABLE groups
    DROP COLUMN dm_uid2,
    DROP COLUMN dm_uid1,
    DROP COLUMN kind;
DROP TYPE group_kind;

ALTER TABLE user_extra
    DROP CONSTRAINT user_extra_friend_verification_chk,
    DROP COLUMN verification_question,
    DROP COLUMN verification_mode;

DROP TABLE blocks;
DROP TABLE friend_requests;
DROP TABLE friendships;

DROP TYPE friend_add_verification_mode;
DROP TYPE friend_request_status;
