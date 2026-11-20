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
  may be empty. Apply all changes before installing `to`; replay brings each ID
  to its current viewer-specific state, not through every intervening revision.
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

## Database restore

After restoring a database backup, run the following **before accepting clients**:

```sql
UPDATE message_sync_meta SET epoch = gen_random_uuid();
```

The epoch change prevents a pre-restore checkpoint from being accepted against
a different history. Rotating the JWT signing key also invalidates checkpoints.
