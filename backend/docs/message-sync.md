# Message sync, version 1

Status: Implemented (v1).

Both protocols on `/ws` can opt in. A ticket client adds `messageSync: 1` to
its `auth` frame and receives `messageSyncHello` with `{version: 1}` before any
other server frame. A JSON-RPC client adds `messageSync: 1` to its
`session.open` with a token, and enables sync only if the authenticated result
echoes `messageSync: 1`. Anonymous and development-session binds do not enable
sync. Non-negotiating clients keep legacy history and live message events.

Message and chat IDs are decimal Snowflake strings. Page `requestId` is an
unsigned 64-bit JSON integer (`u64`). JavaScript clients must keep their
request IDs within the safe integer range.

```mermaid
sequenceDiagram
    participant S as Sender (old or new)
    participant DB as Backend + PostgreSQL
    participant A as Sync client
    participant L as Legacy client
    S->>DB: Existing send, same clientGeneratedId
    Note over DB: Trigger queues change; head allocated at commit
    DB-->>S: Existing send result
    Note over DB: Post-commit broadcast marks the chat dirty
    par Legacy delivery
        DB-->>L: Existing message frame
    and Sync delivery
        DB-->>A: Batch C → D
        Note over A: Apply, then keep D
    end
    A->>DB: Reconnect with D
    alt Retained and authorized
        DB-->>A: Missed changes, Ready; no history request
    else No continuous path
        DB-->>A: Reset; live tail starts now
        A->>DB: messageSyncPage for the visible chat only
    end
```

## Capture

PostgreSQL triggers capture every writer, including an older backend binary
after rollback. At commit, the triggers allocate one log position per changed
chat per transaction. The main timeline and threads share the chat's log.

The log retains changes for 72 hours by default. Set `[message_sync].retention_hours`
or override it with `MESSAGE_SYNC_RETENTION_HOURS`. Replay returns `tooLarge`
above 1,024 positions or 1,024 distinct message IDs in one chat.

After commit, the in-process connection registry marks the affected chat dirty
for all attached sync connections, even if the legacy recipients exclude them.
This wake path requires a single backend process.

## Client checkpoints

A cursor is an opaque checkpoint for one account and chat, not a message ID,
send acknowledgement or read receipt. Keep it only after applying the frame.
Do not parse or modify it.

Apple clients persist checkpoints with their local message cache. The Progressive
Web App (PWA) keeps checkpoints and recent windows in tab memory; a reload or new
tab loads history normally. A checkpoint alone does not prove that a local window
covers the requested position. Render eligible local rows while checking that proof.

## Resume and live changes

Send `messageSyncResume` (`messageSync.resume` in RPC) with
`{chats: [{chatId, cursor?}], last, priorityChatId?}`. Send at most 128 entries
per chunk and end with `last: true`, including for an empty manifest. Later
entries for a chat replace earlier ones. The cumulative manifest is bounded
by the RPC frame limit. A malformed manifest or a second resume after `last`
is a protocol error.

The server attaches the listed chats and the account's remaining memberships
before reading any chat head. It processes the priority chat first, then the
rest by ascending chat ID:

- `messageSyncBatch {chatId, from, to, changes}` advances a continuous cursor.
  `from` must equal the client's installed checkpoint. Each change is either
  `{kind: "upsert", appeared, message}` or `{kind: "delete", messageId,
  threadRootId}` (`threadRootId` is null for a main-timeline message). A batch
  may be empty. A continuous advance may emit multiple sequential
  `messageSyncBatch` frames chained by `from`/`to` cursors to fit within the
  RPC frame size limit (followed by one `messageSyncReady` on resume). Apply all
  changes in a frame before installing `to`; replay brings each ID to its current
  viewer-specific state, not through every intervening revision.
- `messageSyncReady {chatId, cursor}` follows a continuous resume, with or
  without a batch. It repeats the checkpoint. Subsequent live advances do not
  emit `Ready`.
- `messageSyncReset {chatId, cursor, reason}` replaces the checkpoint when
  continuous replay is unavailable. Reasons are `noBaseline`, `invalidCursor`,
  `epochChanged`, `visibilityChanged`, `expired`, and `tooLarge`. Obtain a fresh
  timeline window; requesting only newer messages cannot repair old deletions.
- `messageSyncRevoked {chatId}` means the account is no longer a member. Drop
  the checkpoint and locally retained data. During resume, only explicitly
  listed chats can be revoked.
- `messageSyncResumed {}` is ticket-only. It follows all per-chat frames for
  the final resume chunk, including an empty manifest. JSON-RPC sends the final
  call's `{}` result instead.

Ticket events use `{type, payload}`; RPC uses `events.<type>` with the payload
as params. Other protocols for lists, pins, unread state, presence, and send
acknowledgements are unchanged. A delivery failure closes the connection;
resume from the last checkpoint actually applied.

## History pages

After `messageSyncResumed` (or the final JSON-RPC resume result), send
`messageSyncPage` (`messageSync.page`) with
`{requestId, chatId, threadId?, before?, after?, around?, max?}`. This uses the
same window semantics as ordinary history, capped at a requested size of 100.
Any needed `Batch` or `Reset` comes first. Then `messageSyncPageResult
{requestId, chatId, at, page}` returns history from that same snapshot, with
`at` equal to the installed checkpoint. Both `at` and `page` are null for an
unattached or inaccessible chat. If the server discovers that a membership
was lost, `Revoked` precedes the null result. RPC controls return `{}` after
all events for the call have been enqueued.

## Native conversation list

Authenticated native clients use `GET /chats/difference?cursor=…` for one
account-level checkpoint over active and archived chats and subscribed threads.
The existing chat/thread lists, JSON-RPC calls, PWA behavior, and per-chat message
checkpoints are unchanged. Deploy the list-sync migration before clients use
the route.

Every response contains `cursor`, `complete`, `reset`, `chatSettings`,
`notificationSettings`, `chats`, `threads`, `latestMessages`, and `removed`.
Arrays are always present. A removal has a decimal-string `chatId` and, for a
thread only, a decimal-string `threadId`. Removing a chat also removes its cached
threads. Returned rows are current, viewer-specific projections, not a history
of intermediate changes.

With no cursor, the server returns `reset: "noBaseline"`, empty arrays, and a
baseline start token. **Follow that token**, rather than making another
cursorless request. Baseline pages traverse immutable `(chatId, threadRootId)`
keys, with root `0` for the main chat, regardless of archive state. Each page
contains at most 100 keys. The original starting head remains in every baseline
token. The last baseline page still has `complete: false`: follow its delta
token to repair changes made during enumeration. Only `complete: true` proves
that enumeration and catch-up have finished.

Delta pages coalesce changed keys and preserve whole commit positions. They
normally contain at most 100 keys. A first position with 101–1,000 keys is
returned intact; a first position above 1,000 keys returns `tooLarge` before
projection. A large backlog spread across small positions does not itself
require a reset. SQL key discovery transfers at most 1,001 candidates; this
does not bound every database index probe. An unchanged account can still
require probes when another account advances the shared head.

Each response uses one read-only, repeatable-read PostgreSQL snapshot. No
transaction or lock spans requests. Retrying an old cursor can return the same
keys again; it does not consume them. After installing a completed cursor,
an unchanged account receives empty arrays and `complete: true`.

`reset` is null or `noBaseline`, `invalidCursor`, `epochChanged`, `expired`,
`accountChanged`, or `tooLarge`. Each reset returns empty arrays,
`complete: false`, and a new baseline start token at the current head. A
membership-message preference or account mute-default change invalidates both
baseline and delta tokens. A change only to unread-count display does not.
Both settings objects are returned even when no rows change.

For a chat of the corresponding kind, compute mute state as:
`(mutedUntil > now) || (muteOverride ?? accountDefaultForKind)`.
A timed mute expiring is not a database write. Do not infer the inherited mute
state from `mutedUntil` alone.

`latestMessages` contains history-quality data for each returned chat's selected
visible latest-message ID, if any. It neither advances a message checkpoint nor
forms another message history protocol. Nested message-only changes, sticker
favorite status, provider display names, group tags, and user-avatar lookups do
not alone invalidate list rows. They refresh when a row is next projected or
the client requests a manual baseline.

Personal removal stamps are retained for 30 days by default. Set
`[list_sync].retention_days` or override it with `LIST_SYNC_RETENTION_DAYS`
(integer 1–365). The hourly worker prunes expired removals and atomically raises
a global retention floor. A removal pruned for another account can therefore
require an old client to rebuild. Live stamps and account invalidations remain;
shared stamps are removed by chat ID at group deletion. Historical thread
stamps in existing chats remain available to report disappearance. Cursor age
alone does not cause expiry; a token at the retention floor is still valid.

### Native client storage

- Run one in-flight pass per account. Apply a response only if its request
  cursor still matches. Keep accounts separate and respect live revocations.
- On reset, use an empty staging list. Apply each page, settings, and its next
  token atomically. Replace the installed list atomically only when catch-up
  first returns `complete: true`; do not merge a full baseline into an old list.
- Resume an interrupted scan only with its matching staging rows and token,
  or start again. Never pair an old list with a new cursor.
- For ordinary delta pages, atomically upsert rows by key, move archive buckets
  in place, clear absent latest pointers, apply removals, and save the cursor.
  A sidecar must not overwrite newer history just because its response arrives
  later.
- Coalesce connect, network restoration, and invalidation signals for 250 ms.
  Remember invalidations during a pass and run once more. Pull-to-refresh starts
  a new native baseline.
- Only an authenticated **404** means the route is unsupported. Fall back to
  the four legacy scans as best effort in that case. Authentication, server,
  and transport errors do not mean unsupported and must not install a cursor.

## Database restore

After restoring a database backup, run the following **before accepting clients**:

```sql
UPDATE message_sync_meta SET epoch = gen_random_uuid();
UPDATE list_sync_meta SET epoch = gen_random_uuid();
```

The epoch change prevents a pre-restore checkpoint from being accepted against
a different history. Rotating the JWT signing key also invalidates checkpoints.
