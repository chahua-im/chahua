# Backend

## Startup and maintenance

The API waits for database pool initialization, embedded migrations, and required
configuration/resource construction (including AWS SDK configuration). Migrations
are a schema-readiness prerequisite and may perform substantial database work.
Push credentials and other required configuration are still validated before serving.

Nonessential maintenance does not gate the API or metrics listeners:

- Activity gauges load in a blocking-pool task; they start at zero until the load completes.
- Stale-client cleanup runs in the background immediately and every six hours, with
  missed timer ticks skipped. Each blocking-pool task selects at most 500 clients
  inactive for more than 45 days, ordered by last activity, using
  `FOR UPDATE SKIP LOCKED`. A transaction deletes their push subscriptions and client
  records and updates the daily purge count. Cache eviction and Prometheus updates
  follow successful commit. Connections and row locks are released between batches;
  rows locked by concurrent activity or another instance are skipped.
- Audio-backlog discovery and legacy-state updates run in a blocking-pool task.
  Discovery retains its existing bounded queries.
- When message search is enabled, its health check and index setup run in the
  background. A slow or unavailable Meilisearch does not prevent API startup.
  Search remains not ready until setup succeeds; setup failures are logged.
  The `message-search-reindex` command still waits for search readiness.

The database-backed purge regression test uses temporary tables inside a
rollback-only connection and is enabled with a local migrated database:

## Database migrations

The server applies pending embedded Diesel migrations at startup in version order.
New migrations must sort after the latest migration on `main`; preserve dependency
order when re-dating an unmerged branch's migrations.

## Metrics

Prometheus endpoint behavior and the complete metric catalog are in
[docs/metrics.md](docs/metrics.md).

## OpenAPI contract

Snowflake IDs in URL path parameters are documented as decimal strings, including
`chat_id` on `/chats/{chat_id}/mentions` and `/chats/{chat_id}/reactions`. This
preserves IDs beyond JavaScript's safe-integer range in generated clients; Rust
handlers still parse them as `i64`. User UIDs and pagination counts are not
Snowflake IDs.

Validate the generated document with:

```bash
cargo test --locked openapi::tests::
```

## Conversation collection summaries

`POST /conversations/unread-summary` accepts `{ "views": [{ "key": "...", "selector": { ... } }] }`.
A selector contains `categories` (`group`, `dm`, `groupThread`, `dmThread`),
`include` and `exclude` arrays of `{ chatId, threadId? }`, and `archived` (default false).
IDs are decimal strings on the wire. Categories and explicit inclusions form a union;
exclusions take precedence. A main chat never implicitly selects its threads.

Only the caller's current memberships and subscribed, published threads qualify,
including explicitly selected IDs. A thread's archive state is independent of its
parent's archive state. Unknown, inaccessible, unsubscribed and mismatched references
contribute nothing. An empty selector selects nothing. Keys must be unique, nonempty,
and at most 128 bytes; a batch allows at most 32 views and 2048 explicit references.

Each response entry in `summaries` contains the key and:

- `unreadMessageCount`: unread messages, including muted conversations, capped at 1000.
- `unreadUnmutedMessageCount`: unread messages in unmuted conversations, capped independently at 1000.
- `unreadConversationCount`: distinct selected conversations with unread messages.
- `unreadUnmutedConversationCount`: distinct unmuted selected conversations with unread messages, not capped.
- `unreadAttentionCount`: unread group mentions/replies, including muted conversations,
  once per message, capped at 1000.
- `unreadUnmutedAttentionCount`: unread group mentions/replies in unmuted conversations,
  capped independently at 1000, for tab badges and the background title's `@` indicator.
  DMs and DM threads contribute zero to both attention counts. Reactions are separate.

Main chats are muted while `mutedUntil` is in the future; expired or absent mute times
are unmuted. Threads use their own archive state as their mute state, independently
of the parent chat's mute or archive state. All three unmuted counts use this rule.
Message and conversation counts include DMs and DM threads. The unmuted counts reuse
the same per-conversation counts without additional queries. Chat rows can retain gray mention badges
using their existing `unreadMentions` and mute metadata without contributing to tab
attention badges. Both attention counts use the same conversation read cursors and
the same mention queries; muting does not mark anything as read.

Views may overlap; each view counts a conversation once. A global collection must be
queried as its own union, never calculated by adding overlapping view totals. Read
cursors belong to conversations, not views. Existing unread endpoints retain their
legacy meanings for other clients and the global system badge.

The service resolves authorized scopes once, counts each selected scope once, then
aggregates all views. Main counts reuse `UnreadService`'s shared chat index; thread
counts use `idx_messages_thread_reply_stats`, attention counts use
`message_mentions_unread_idx`. LATERAL range seeks and per-scope caps bound message
queries independently of list pagination. No new tables or indexes are required.

## PWA notification metadata

DM Web Push recipients are filtered using ordinary message rules without
mention/reply exceptions, including DM threads. Ineligible Web Push subscriptions
are excluded before delivery, avoiding silent pushes. DM payloads include
`ordinaryMessageBody` for the PWA worker to display ordinary notification text.
Existing payload fields and APNs behavior are unchanged. The selected collection
only affects the PWA title and list badges, never push eligibility.

## Client WebSocket controls

Client commands are decoded by the serde-tagged `ClientWsMessage` enum in
`src/dto/ws.rs`, alongside `ServerWsMessage`. The wire format remains flat:
`{"type":"ping","state":"active"}`, not a `payload` envelope.

| Type | Fields | Behavior |
| --- | --- | --- |
| `auth` | Required `ticket` string | Must be the first message, within five seconds; invalid credentials or a non-auth first message close the connection. |
| `ping` | Optional `state`: `active` or `inactive` | Updates liveness and app state, replies with `pong`; missing/null state defaults to `active`. |
| `appState` | Optional `state`: `active` or `inactive` | Updates app state and liveness; missing/null state defaults to `inactive`. |
| `watchPresence` | Optional/null numeric `requestId`; optional/null `userIds` and `chatIds` arrays | Replaces the presence scope described below; missing/null arrays are empty. |

After authentication, unknown message types are ignored without closing the socket.
Malformed JSON, missing/non-string message types, wrong field types in known commands,
and oversized presence scopes are ignored without replacing the current watch.
Additional fields on known commands are ignored for forward compatibility.
An additional `auth` command cannot switch the authenticated session.


## Scoped WebSocket presence

Authenticated WebSocket clients may replace that socket's watched presence scope with
`{"type":"watchPresence","userIds":[2],"chatIds":[]}`. A scope is
limited to 100 users and four chats. Non-empty replacements receive an immediate absolute
`presenceSnapshot` and refresh on a 15-second interval; an empty scope stops publication.
Omitted users and groups are not authorized or no longer exist in the
caller's visible scope, so clients must clear them.

`requestId` is an optional client correlation ID. When supplied, the same value
(including `0`) is echoed in every initial and periodic snapshot for that scope.
When omitted or `null`, snapshots omit `requestId`; the server does not generate an
ID or substitute zero. Clients that change scopes and need to reject stale snapshots
can opt in by supplying it on each replacement.

Live `online` means at least one fresh, open authenticated WebSocket for the user, irrespective
of foreground/background application state. It is distinct from `user_extra.last_seen_at`, which
is existing HTTP activity data and is read without writing or changing its five-minute tracking
throttle. User visibility is limited to self, friends, or current shared regular-group membership,
and either blocking direction suppresses visibility. Group snapshots are limited to current
members of regular groups; DMs and thread participation do not expose presence.

Group aggregates are shared across viewers using Moka's async cache, with a 15-second TTL and
a capacity target of 128 groups. Concurrent misses for the same group share one database load
and registry scan; only the two resulting counts are retained, not the member UID list.
Failed loads are not cached. Authorization is queried before each snapshot and is never
reused from the aggregate cache; database connections are released before awaiting shared counts.
Each scan uses one liveness timestamp for all members.

A cached group aggregate can be up to 15 seconds old when sent. Combined with the client's
15-second snapshot schedule, a count change can take approximately 30 seconds to become visible
under normal service operation. Individual user online status is not cached this way.

The live registry is intentionally process-local. These snapshots require a single backend
instance; multi-instance deployments need a shared presence registry and cross-instance
coordination before the counts are globally authoritative. Sticky sessions alone are insufficient.
The existing 300-second stale-connection timeout and 60-second pruning interval remain unchanged;
silent network loss is not an immediate offline transition. No persistent presence writes are added.

## Individual presence privacy

Privacy applies to individual `online` and `lastSeenAt` together, including DM indicators
and user details. Both users must permit sharing with each other. The existing self,
friend/shared-group discoverability, and blocking checks still apply; `everyone` does
not make arbitrary UIDs discoverable. Self-presence remains available.

| Authenticated endpoint | GET response / PUT body and response |
| --- | --- |
| `/me/presence-settings` | `{ "visibility": "everyone" }`; allowed values: `everyone`, `friends`, `nobody`. |
| `/friends/{uid}/presence-settings` | `{ "override": "inherit" }`; allowed values: `inherit`, `share`, `hide`. Requires a current friendship; missing friendships return 404. Only the caller's override is exposed. |

The base policy is stored in `user_extra.presence_visibility`, a PostgreSQL enum with
`NOT NULL DEFAULT 'everyone'`. Existing and newly created users default to everyone;
reads without a user-extra row also use everyone. `friends` requires a current friendship;
`nobody` denies sharing unless an explicit friend override permits it.

Each canonical `friendships` row stores `uid1_shares_presence` and
`uid2_shares_presence`: SQL NULL inherits that user's global policy, true shares,
false hides. Writes update only the authenticated owner's column. Overrides take
precedence over that owner's base policy, never over the other person's choice or
a block. Unfriending deletes both overrides with the friendship; re-adding inherits.

The existing batched friendship reads select both directional overrides. One bounded
user-extra read loads the viewer and candidate peers' policies with last-seen data;
there are no per-peer queries or materialized visibility pairs. Existing primary keys
and friendship indexes serve these lookups; global changes update one row.

Unauthorized individual entries are omitted, not emitted as offline, and clients
must clear them. Policies are rechecked on every snapshot; no privacy authorization
cache or separate policy-change push is used. Other clients apply changes on their
next normal snapshot, while the saving PWA invalidates its affected individual cache
and immediately re-requests its scope. Group aggregates, their cache, and registry
online membership ignore individual privacy, so small-group counts may indirectly
reveal activity.

## Direct-message read receipts

Read receipts are limited to DMs and have no timestamp. A single check remains
the delivered/sent state; a double check means the peer's visible receipt has
advanced. Group chats never expose a receipt.

| Authenticated endpoint | GET response / PUT body and response |
| --- | --- |
| `/me/read-receipt-settings` | `{ "visibility": "friends" }`; allowed values: `friends`, `nobody`. |
| `/friends/{uid}/read-receipt-settings` | `{ "override": "inherit" }`; allowed values: `inherit`, `share`, `hide`. Requires a current friendship; missing friendships return 404. |
| `/chats/{chat_id}/read-receipt?threadId={root_id}` | `{ "lastReadMessageId": "…" }`; omit `threadId` for top-level DM messages. The field is absent when no receipt is visible or known. |

Both DM participants must be current friends, unblocked in either direction,
and permit sharing through their global policy plus their own per-friend
override. Overrides are directional, take precedence over the owner's global
policy, and disappear with the friendship. New users and users without a
`user_extra` row default to `friends`.

`group_membership.last_read_receipt_message_id` and
`thread_user_states.last_read_receipt_message_id` are independent monotonic
high-water marks. Rewinding unread state or deleting a message never rewinds
them. Thread requests read only the matching thread-state marker; they never
fall back to the parent DM marker. Explicit read targets must be published
messages in the authorized top-level or thread scope. Sending also advances
the receipt alongside the sender's existing read pointer, including while an
accepted voice message awaits publication.

The `readReceiptChanged` WebSocket event is an invalidation only:
`{ "type": "readReceiptChanged", "payload": { "chatId": "…" } }`.
Receipt advances omit `privacyChanged`; a policy, friendship, or block change
sets `privacyChanged: true` so clients clear a cached check before refetching.
Neither form contains a receipt cursor or timestamp.

## APNs setup

This backend talks to Apple Push Notification service directly using **token-based auth**.

It does **not** use an APNs TLS certificate in the current implementation. Instead, it expects an
Apple-issued `.p8` private key plus the associated key metadata.

### 1. Apple-side setup

1. In the Apple Developer portal, enable the **Push Notifications** capability for your app's
   App ID / bundle identifier.
2. Create an **APNs Auth Key** under **Certificates, Identifiers & Profiles -> Keys**.
3. Download the generated `.p8` file and store it securely. Apple only lets you download it once.
4. Record:
   - the **Key ID**
   - your Apple Developer **Team ID**
   - your app's **bundle identifier**; this backend uses it as `APNS_TOPIC`
5. In the iOS app, call `registerForRemoteNotifications()`, obtain the device token from APNs, and
   send that token to the backend's `/push/subscribe` endpoint.

### 2. Backend environment variables

The backend always requires the existing web-push configuration:

```env
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:push@example.com
```

To enable APNs support, set all of these:

```env
APNS_KEY_ID=ABCDEFGHIJ
APNS_TEAM_ID=ABCDEFGHIJ
APNS_PRIVATE_KEY_PATH=/absolute/path/to/AuthKey_ABCDEFGHIJ.p8
APNS_TOPIC=com.example.app
```

Notes:

- `APNS_PRIVATE_KEY_PATH` must point to the downloaded `.p8` key file on disk.
- `APNS_TOPIC` should be the iOS app bundle identifier used for push.
- APNs support is considered configured only when **all** `APNS_*` variables above are present.
- If APNs is not configured, `POST /push/subscribe` rejects `provider=apns`.

### 3. Environment handling

The backend stores APNs environment per subscription row:

- `sandbox`
- `production`

The iOS client must tell the backend which environment the token belongs to when subscribing.

### 4. API usage

Web push remains backward compatible:

- if `provider` is omitted, `/push/subscribe` treats the request as `webPush`

APNs subscriptions must include:

```json
{
  "provider": "apns",
  "deviceToken": "hex-device-token-from-ios",
  "environment": "sandbox"
}
```

or:

```json
{
  "provider": "apns",
  "deviceToken": "hex-device-token-from-ios",
  "environment": "production"
}
```

### 5. Localization behavior

APNs alert notifications are sent with localization keys/arguments, not pre-rendered translated
strings.

That means:

- the backend does not localize APNs message text
- the iOS app must ship the notification string resources referenced by the APNs payload

Message alerts include `aps.category: "chahua"`, matching the Apple client's text-input Reply
action. Keep this identifier synchronized with the client; without it, the system does not show
quick reply. Replies use the existing authenticated message API and the `wettyChat` routing
envelope, including `threadRootId` when present.

### 6. Operational notes

- One APNs signing key can be used for both sandbox and production.
- Protect the `.p8` file carefully; treat it like a production secret.
- Rotating the APNs key means creating a new key in Apple Developer, updating the env vars / key
  file on the backend, deploying, and only then revoking the old key.

## References

- Apple: [Registering your app with APNs](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns)
- Apple: [Create a private key to access a service](https://developer.apple.com/help/account/keys/create-a-private-key/)
- Apple: [Communicate with APNs using authentication tokens](https://developer.apple.com/help/account/capabilities/communicate-with-apns-using-authentication-tokens/)
- Apple: [Establishing a certificate-based connection to APNs](https://developer.apple.com/documentation/usernotifications/establishing-a-certificate-based-connection-to-apns)
