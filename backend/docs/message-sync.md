# Message sync, version 1

Both protocols on `/ws` can opt in. A ticket client adds `messageSync: 1` to
its `auth` frame and receives `messageSyncHello` with `{version: 1}` before any
other server frame. A JSON-RPC client adds `messageSync: 1` to its
`session.open` with a token, and enables sync only if the authenticated result
echoes `messageSync: 1`. Anonymous and development-session binds do not enable
sync. Non-negotiating clients keep legacy history and live message events.

IDs in this protocol are decimal Snowflake strings; page `requestId` is an
unsigned number. A cursor is an opaque checkpoint for one account and chat,
not a message ID, send acknowledgement or read receipt. Only retain a cursor
after applying the corresponding frame. Do not parse or modify it.

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
  threadRootId?}`. A batch may be empty. Apply all changes before installing
  `to`; replay brings each ID to its current viewer-specific state, not through
  every intervening revision.
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

Ticket events use `{type, payload}`; RPC uses `events.<type>` with the payload
as params. Other protocols for lists, pins, unread state, presence, and send
acknowledgements are unchanged. A delivery failure closes the connection;
resume from the last checkpoint actually applied.

## History pages

After resume completes, send `messageSyncPage` (`messageSync.page`) with
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
Log retention is controlled by `[message_sync].retention_hours` or the
`MESSAGE_SYNC_RETENTION_HOURS` environment override.
