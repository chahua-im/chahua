# Group speaking restrictions

These settings control sending and editing content, independently of notification
mutes. They apply only to groups; direct messages retain their existing rules.

| API value | Main-chat message | Start a thread | Reply to a thread |
| --- | --- | --- | --- |
| `unrestricted` | Yes | Yes | Yes |
| `threadsOnly` | No | Yes | Yes |
| `repliesOnly` | No | No | Yes |
| `readOnly` | No | No | No |

The effective mode is the stricter of `groups.speaking_mode` and
`group_membership.speaking_mode`. Both default to `unrestricted`. Administrators
are exempt, and cannot receive personal restrictions. Promotion clears a personal
restriction atomically; demotion does not restore it. Leaving deletes the
membership and its personal restriction; rejoining starts unrestricted personally
but still observes the group's mode.

Thread creation keeps the existing model: sending the first thread message below
a published top-level text message with `has_thread = false` starts a thread.
`repliesOnly` requires `has_thread = true` at authorization time; the thread need
not predate the restriction. A quote/reply in the main chat remains a main-chat
message. A reply cannot itself be used as a new thread root.

Edits are checked against the original message's location. A root message remains
a main-chat message even if it has a thread. Existing ownership, publication and
editable-message-type checks still apply. Text, media, stickers, forwarding,
invite cards and delegated sends all obey the destination's mode. System lifecycle
messages bypass speaking restrictions. Reading, reactions, deleting one's own
messages, and thread subscriptions keep their existing rules.

## API

Only a current group administrator may call:

```http
PUT /group/{chat_id}/speaking-mode
PUT /group/{chat_id}/members/{uid}/speaking-mode
Content-Type: application/json

{"speakingMode":"repliesOnly"}
```

Both setters are idempotent. The personal setter requires a current ordinary
member, even when setting `unrestricted`. Missing members return 404; a non-admin
caller returns 403; DM settings and administrator targets return 400.

The group setter returns `{chatId, speakingMode}`. The member setter returns
`{chatId, uid, role, speakingMode, groupSpeakingMode, effectiveSpeakingMode}`.
Chat IDs are strings. Group details include `speakingMode`, `mySpeakingMode`, and
`effectiveSpeakingMode`; the latter two are null for nonmembers. These values do
not grant membership or bypass other authorization checks. Member responses include
their personal `speakingMode`.

Rejected sends/edits return HTTP 403 with:

```json
{"code":"speakingRestricted","effectiveSpeakingMode":"repliesOnly"}
```

After commit, `groupSpeakingModeChanged` broadcasts the current group state
to group members. `memberSpeakingModeChanged` sends the current member state
to the affected user and current administrators, including after a role change.
Each broadcast re-reads state and recipients under the chat's shared lock and
holds that lock until local WebSocket enqueue completes. Delayed broadcasts
therefore cannot publish an older state after a newer update; duplicate snapshots
are possible. If the affected member has left, the personal broadcast is skipped.
Clients can apply these payloads directly. Reconnect calibration uses group details
and the member list. The PWA shares these states across group details, member
management and message entry points; see [PWA data flow](../../pwa/docs/data-flow.md#群发言权限).

## Transactions and storage

Sending and editing take a transaction-scoped shared advisory lock for the chat
before reading permissions. Setting restrictions, changing roles, and removing
members take the matching exclusive lock before reading authorization state or
locking rows. Sends may proceed concurrently; a restriction change waits for
already-accepted writes and is observed by later writes. PostgreSQL coordinates
these locks across backend processes; permissions are not TTL-cached.

The acceptance boundary is the send transaction, including for audio. Audio
accepted before a restriction changes may finish transcoding and publish later;
new sends must pass the current policy. Duplicate send retries also undergo current
authorization and never create another message.

The migration adds two non-null enum columns with defaults and constraints against
group-level DM restrictions and personal admin restrictions. There are no new
tables or indexes: reads use the group primary key and the membership composite
primary key. Group-wide changes update one group row, not every member.

Database tests use `WETTY_TEST_DATABASE_URL` pointing at a migrated test database.
