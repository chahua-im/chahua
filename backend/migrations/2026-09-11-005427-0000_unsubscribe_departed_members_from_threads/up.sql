-- Older removals deleted group membership without ending thread subscriptions,
-- which left departed users with inaccessible threads in their thread list.
-- group_membership's primary key on (chat_id, uid) supports the anti-join.
UPDATE thread_user_states AS ts
SET subscribed = FALSE
WHERE ts.subscribed = TRUE
  AND NOT EXISTS (
      SELECT 1
      FROM group_membership AS gm
      WHERE gm.chat_id = ts.chat_id
        AND gm.uid = ts.uid
  );
