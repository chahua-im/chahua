# Backend

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
