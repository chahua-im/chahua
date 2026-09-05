DROP INDEX uniq_friend_requests_pending_pair;

CREATE UNIQUE INDEX uniq_friend_requests_pending_pair
    ON friend_requests(LEAST(from_uid, to_uid), GREATEST(from_uid, to_uid))
    WHERE status IN ('pending', 'archived');
