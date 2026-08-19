-- Friendships are mutual relationships stored as one canonical pair.
CREATE TABLE friendships (
    uid1 INTEGER NOT NULL,
    uid2 INTEGER NOT NULL,
    initiated_by INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (uid1, uid2),
    CONSTRAINT friendships_uid1_lt_uid2_chk CHECK (uid1 < uid2),
    CONSTRAINT friendships_initiated_by_chk CHECK (initiated_by = uid1 OR initiated_by = uid2)
);

-- The primary key covers uid1 lookups; this index supports the other side of
-- "WHERE uid1 = X OR uid2 = X" friend-list queries.
CREATE INDEX idx_friendships_uid2 ON friendships(uid2);

CREATE TYPE friend_request_status AS ENUM ('pending', 'accepted', 'rejected', 'cancelled');
CREATE TYPE friend_add_verification_mode AS ENUM ('direct', 'need_message', 'forbid', 'question');

CREATE TABLE friend_requests (
    id BIGINT PRIMARY KEY,
    from_uid INTEGER NOT NULL,
    to_uid INTEGER NOT NULL,
    status friend_request_status NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at TIMESTAMPTZ,
    message TEXT,
    question TEXT,
    CONSTRAINT friend_requests_from_ne_to_chk CHECK (from_uid <> to_uid),
    CONSTRAINT friend_requests_question_requires_answer_chk CHECK (question IS NULL OR message IS NOT NULL)
);

CREATE INDEX idx_friend_requests_from_status_created
    ON friend_requests(from_uid, status, created_at DESC);
CREATE INDEX idx_friend_requests_to_status_created
    ON friend_requests(to_uid, status, created_at DESC);

-- At most one pending request per unordered pair, regardless of direction.
CREATE UNIQUE INDEX uniq_friend_requests_pending_pair
    ON friend_requests(LEAST(from_uid, to_uid), GREATEST(from_uid, to_uid))
    WHERE status = 'pending';

-- Blocks are directional and independent from friendship/request state.
CREATE TABLE blocks (
    blocker_uid INTEGER NOT NULL,
    blocked_uid INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocker_uid, blocked_uid),
    CONSTRAINT blocks_blocker_ne_blocked_chk CHECK (blocker_uid <> blocked_uid)
);

CREATE INDEX idx_blocks_blocked_uid ON blocks(blocked_uid);

-- Friend-add verification settings live with the user's existing Chahua data.
ALTER TABLE user_extra
    ADD COLUMN verification_mode friend_add_verification_mode NOT NULL DEFAULT 'direct',
    ADD COLUMN verification_question TEXT;

ALTER TABLE user_extra
    ADD CONSTRAINT user_extra_friend_verification_chk CHECK (
        (verification_mode = 'question'
            AND verification_question IS NOT NULL
            AND btrim(verification_question) <> '')
        OR (verification_mode <> 'question' AND verification_question IS NULL)
    );

-- Distinguish regular group chats from direct messages and store each DM's
-- canonical participant pair for indexed find-or-create operations.
CREATE TYPE group_kind AS ENUM ('group', 'dm');

ALTER TABLE groups
    ADD COLUMN kind group_kind NOT NULL DEFAULT 'group',
    ADD COLUMN dm_uid1 INTEGER,
    ADD COLUMN dm_uid2 INTEGER;

CREATE UNIQUE INDEX uniq_groups_dm_pair
    ON groups(dm_uid1, dm_uid2)
    WHERE kind = 'dm';

ALTER TABLE groups
    ADD CONSTRAINT groups_dm_pair_consistent CHECK (
        (kind = 'dm' AND dm_uid1 IS NOT NULL AND dm_uid2 IS NOT NULL AND dm_uid1 < dm_uid2)
        OR
        (kind <> 'dm' AND dm_uid1 IS NULL AND dm_uid2 IS NULL)
    );
