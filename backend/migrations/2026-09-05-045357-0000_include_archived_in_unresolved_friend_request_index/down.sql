DROP INDEX uniq_friend_requests_pending_pair;

UPDATE friend_requests
SET status = 'pending'
WHERE status = 'archived';

CREATE UNIQUE INDEX uniq_friend_requests_pending_pair
    ON friend_requests(LEAST(from_uid, to_uid), GREATEST(from_uid, to_uid))
    WHERE status = 'pending';
