# Backend metrics catalog

The backend exposes Prometheus metrics from a **metrics-only** listener. It binds
`0.0.0.0:3001` by default; set `METRICS_ADDR` to override the address. `GET
/metrics` returns the shared application registry in Prometheus text exposition
format. The metrics listener only exposes that route, separate from the API
listener.

The registry is explicitly constructed in `src/metrics/mod.rs`. On Linux it
registers Prometheus's standard process collector; these process series are
absent on other platforms. No Tokio runtime collector is registered.

## Reading this catalog

- **Counter** values are monotonically increasing totals since process start.
  A `*_total` metric is a counter.
- **Gauge** values are current snapshots and can rise or fall.
- Each **histogram** named `foo` exposes `foo_bucket{le="..."}`, `foo_sum`, and
  `foo_count`; `histogram_quantile` consumes the bucket series. The unified API
  counter is not redundant: it also retains the native `error_code` omitted from
  the API histogram.
- The **Buckets** column below refers to the single bucket profiles in
  [Histogram bucket profiles](#histogram-bucket-profiles). All profiles also
  include Prometheus's implicit `+Inf` bucket.
- Labels omitted from a row mean that metric has no labels. Labels are part of
  the metric contract, not incidental query filters.

## Histogram bucket profiles

| Profile | Explicit bucket bounds |
| --- | --- |
| `H1` | `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10` seconds |
| `H2` | `1, 5, 15, 30, 60, 300, 900, 1800, 3600, 14400` seconds |
| `H3` | `0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5` seconds |
| `H4` | `1, 10, 50, 100, 500, 1000, 5000, 10000, 20000` members |
| `H5` | `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30` seconds |
| `H6` | `0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1` seconds |
| `H7` | `0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60` seconds |
| `H8` | `0, 1, 5, 10, 20, 50, 100, 500, 1000` items |
| `H9` | `1, 5, 15, 30, 60, 300, 900, 1800, 3600` seconds |
| `H10` | `0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60` seconds |
| `H11` | `0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120` seconds |
| `H12` | `0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30` seconds |
| `H13` | `0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 5000` requested IDs |

## Backend process

Linux process metrics are sampled when `/metrics` is scraped. They describe the
backend process, not PostgreSQL or container limits. Values can be unavailable
when `/proc` cannot be read.

| Family | Type / labels | Meaning |
| --- | --- | --- |
| `process_cpu_seconds_total` | Counter; none | Cumulative user and system CPU seconds; `rate(...[5m])` is CPU cores consumed, not a percent of the container limit. |
| `process_resident_memory_bytes` | Gauge; none | Resident process memory in bytes. |
| `process_virtual_memory_bytes` | Gauge; none | Virtual address space in bytes, not physical memory consumption. |
| `process_open_fds` | Gauge; none | Open file descriptors. |
| `process_max_fds` | Gauge; none | File-descriptor soft limit. |
| `process_threads` | Gauge; none | OS thread count, not Tokio task count. |
| `process_start_time_seconds` | Gauge; none | Process start time as Unix seconds. |

CPU throttling, host I/O, PostgreSQL CPU, and PostgreSQL wait events require
separate infrastructure/database monitoring; these metrics do not infer them.
The standard collector reports CPU time in whole seconds; use a multi-minute
rate window rather than interpreting single-scrape increments as CPU spikes.

```promql
rate(process_cpu_seconds_total{job="wetty-chat-backend"}[5m])
```

```promql
process_resident_memory_bytes{job="wetty-chat-backend"}
```

## Shared database pool

These metrics cover the production pool shared by HTTP, RPC, and background
workers, including migration/startup checkouts. They are collected through r2d2
events and pool state, without issuing diagnostic SQL.

| Family | Type / labels | Meaning | Buckets |
| --- | --- | --- | --- |
| `db_pool_checkout_duration_seconds` | Histogram; none | Elapsed time of successful `get`/`get_timeout` calls, including waiting and checkout validation. | `H12` |
| `db_pool_checkout_timeouts_total` | Counter; none | `get`/`get_timeout` attempts ending in timeout, including exhaustion or inability to obtain a healthy connection. | — |
| `db_pool_connections_active` | Gauge; none | Established connections not idle at scrape time; includes checkout validation, not just executing SQL. | — |
| `db_pool_connections_idle` | Gauge; none | Established idle connections at scrape time. | — |
| `db_pool_connections_max` | Gauge; none | Configured pool capacity, not the current established connection count. | — |

Gauges come from one pool-state snapshot per scrape. Pending connections being
created are not established connections. Failed checkout elapsed time is **not**
recorded in the duration histogram: r2d2's timeout event exposes only the requested
timeout, not actual elapsed time. Monitor the timeout counter alongside successful
checkout latency. Nonblocking `try_get` calls and initial pool-construction
failures do not emit checkout events. No per-request or per-user labels are used.

```promql
histogram_quantile(0.95,
  sum by (instance, le) (
    rate(db_pool_checkout_duration_seconds_bucket{job="wetty-chat-backend"}[$__rate_interval])
  )
)
```

```promql
increase(db_pool_checkout_timeouts_total{job="wetty-chat-backend"}[5m])
```

```promql
db_pool_connections_active{job="wetty-chat-backend"}
/
db_pool_connections_max{job="wetty-chat-backend"}
```

## Profile and app-version operations

| Family | Type / labels | Meaning | Buckets |
| --- | --- | --- | --- |
| `profile_lookup_duration_seconds` | Histogram; `outcome=success\|error` | Shared profile lookup elapsed time, including SQL round trip, row decoding, and profile-map assembly. | `H12` |
| `profile_lookup_batch_size` | Histogram; none | Number of IDs supplied to each completed profile lookup, including duplicates and failed attempts; not returned row count. | `H13` |
| `app_version_aggregation_duration_seconds` | Histogram; `outcome=success\|error` | Active-client version aggregation SQL round trip, row decoding, and version-count normalization. Excludes gauge publication. | `H12` |

The production pool attaches the metric context to each new connection, so these
shared operations record across HTTP, RPC, and background callers. Diesel's
existing SQL tracing is preserved. Connections created outside that pool must
explicitly attach the context; isolated tests use their own registries.

Durations exclude pool acquisition and blocking-worker scheduling; compare with
pool and API-stage metrics for those waits. These are client-side operation
timings, not PostgreSQL execution-only timings. They cannot distinguish database
CPU, network latency, lock waits, or I/O waits.

An empty profile batch records size zero and a successful duration without issuing
SQL. A missing user is not a database error. Both outcome series exist at startup.
Each operation records once when returning `Ok` or `Err`; panic/abort is not
recorded as a completed outcome. No IDs, SQL text, query parameters, or versions
are used as labels in these three families.

```promql
histogram_quantile(0.95,
  sum by (instance, outcome, le) (
    rate(profile_lookup_duration_seconds_bucket{job="wetty-chat-backend"}[$__rate_interval])
  )
)
```

The background app-version job runs once per minute per instance. Its low volume
makes short-window percentiles noisy; count slow completions instead:

```promql
sum by (instance, outcome) (
  increase(app_version_aggregation_duration_seconds_count{job="wetty-chat-backend"}[15m])
)
-
sum by (instance, outcome) (
  increase(app_version_aggregation_duration_seconds_bucket{job="wetty-chat-backend",le="0.5"}[15m])
)
```

## Read-receipt query diagnostics

| Family | Type / labels | Meaning | Buckets |
| --- | --- | --- | --- |
| `read_receipt_query_duration_seconds` | Histogram; `query`, `outcome=success\|error` | SQL round trip and row decoding for each attempted batched receipt query, excluding pool waits and post-query map construction. | `H12` |

The fixed `query` values are `dm_peers`, `friendships`, `blocks`, `visibility`,
`chat_receipts`, and `thread_receipts`. Chat and thread receipt loading share the
first four queries; the fifth fetch uses the corresponding scope-specific value.
All pooled callers share these metrics, without transport or account labels.
Queries skipped by empty input, no DM peers, or privacy filtering have no
observation. Errors are recorded before propagation; later queries are not run.
Both outcomes are registered at startup. Panic/abort is not a completed outcome.
The query label contains a fixed operation name, never SQL or parameters.

The API `read_receipts` stage includes these SQL operations and in-memory privacy
checks; do not add its duration to the nested query durations or add percentiles.
These timings do not distinguish PostgreSQL execution, network, locks, or I/O.

```promql
histogram_quantile(0.95,
  sum by (instance, query, outcome, le) (
    rate(read_receipt_query_duration_seconds_bucket{job="wetty-chat-backend"}[5m])
  )
)
```


## Unified API

| Family | Type / labels | Meaning and recording boundary | Buckets / cardinality |
| --- | --- | --- | --- |
| `api_requests_total` | Counter; `transport`, `api`, `status`, `error_code` | One completed API call or whole-envelope rejection, classified by transport and outcome. | Labels use bounded operation and outcome classifications. |
| `api_request_duration_seconds` | Histogram; `transport`, `api`, `status` | Server-side turnaround through individual response preparation, in seconds, for the same completions. | `H1`; native `error_code` is deliberately omitted to limit cardinality. |

- `transport` is `http` or `rpc`. `api` is the canonical registered RPC
  operation literal shared by equivalent HTTP endpoints, or `unknown` for
  unrecognized operations/routes and whole-envelope rejections. Paths, arbitrary
  method names, IDs, tokens, request bodies and error text are not labels.
- HTTP-only labels are `sessions.createWebSocketTicket`, `users.getAuthToken`,
  `stickers.uploadToPack`, `external.createInvite`, `external.getRelationships`,
  `external.getSessionGeneration`, and `external.revokeSessions`.
  `users.getAuthToken` is legacy signing, distinct from the shared `auth.refresh`
  operation. Other equivalent HTTP and RPC operations use the same API label.
- `status` is the numeric HTTP status for HTTP, or the HTTP-equivalent status
  below for RPC. HTTP 2xx and 3xx and RPC successes use `error_code="none"`;
  failures use the native numeric HTTP status or RPC error code as a string.
  RPC success is `status="200"`.

| RPC error | Native `error_code` | `status` |
| --- | --- | --- |
| ParseError | `-32700` | `400` |
| InvalidRequest | `-32600` | `400` |
| InvalidParams | `-32602` | `400` |
| BadRequest | `1000` | `400` |
| Unauthorized | `1001` | `401` |
| Forbidden | `1003` | `403` |
| SpeakingRestricted | `1103` | `403` |
| MethodNotFound | `-32601` | `404` |
| NotFound | `1004` | `404` |
| Conflict | `1009` | `409` |
| Gone | `1010` | `410` |
| PayloadTooLarge | `1013` | `413` |
| Overloaded | `1429` | `429` |
| DispatcherInternal | `-32603` | `500` |
| Internal | `1500` | `500` |
| Unavailable | `1503` | `503` |

HTTP counts completed application API requests, including multipart uploads,
authentication failures, method 405s and unknown-route 404s. The actual `/ws`
upgrade endpoint, `/docs`, `/api-docs`, `/metrics`, `/health`, `/healthz` and
`/readyz` are excluded. Its outer timing includes authentication, activity
tracking and handler work through the prepared response, not socket transmission.

RPC timing starts when a complete frame arrives at `RpcSessionInput`, before
bounded input, control-lane and worker waits, and ends when that call's response
is serialized and prepared. It excludes sibling batch wait, result/outbound
queue wait and socket transmission. Each incoming call, including a notification,
is counted separately; peer responses and outgoing pushes are ignored. A whole
malformed, oversized or otherwise unparsed envelope rejection is counted once as
`unknown`. Preparation budget errors are `429`/`1429`, oversized replies are
`413`/`1013`, and serialization errors are `500`/`-32603`. Supervised admitted
work still records if it completes after disconnect; cancellation before
preparation is not a completion.

### API stage diagnostics

| Family | Type / labels | Meaning and recording boundary | Buckets / cardinality |
| --- | --- | --- | --- |
| `api_stage_duration_seconds` | Histogram; `transport`, `api`, `stage` | Elapsed wall time for each instrumented stage, including attempts ending in errors. | `H12`; canonical API names and fixed stage literals only; no request parameters, user IDs, or SQL. |

Ordinary RPC read/mutation calls record `blocking_queue` (submission through
blocking-worker start), `authentication` (session-generation check),
`activity` (activity bookkeeping), and `handler` (decoded dispatch through result
conversion to JSON). Session/control operations do not record these stages.
The authentication and activity stages can themselves include database waits.

`chats.list` additionally records the following stages on both HTTP and RPC:

| Stage | Boundary |
| --- | --- |
| `pool_acquire` | Connection acquisition, including failed attempts. |
| `settings` | Notification defaults and chat settings loading. |
| `page` | Chat page loading, including cursor lookup. |
| `unread_counts` | Membership unread counts. |
| `mention_counts` | Unread mention counts. |
| `reaction_counts` | Unread reaction counts. |
| `message_previews` | Last-message hydration, including avatar lookup and database work. |
| `dm_peers` | DM peer selection and member-summary loading, including avatars. |
| `read_receipts` | Visible peer receipt loading. |
| `response_build` | Chat response assembly, excluding transport serialization. |

HTTP `chats.list` also records `blocking_queue`; its authentication/activity
middleware is outside these stages. Database-backed stages include SQL execution
and lock waits, not just database CPU time.

Timers record on scope exit, including errors and unwinding. A cancelled queued
task can record elapsed queue time without executing; stages not reached have no
observation. Series appear on first use. RPC `handler` contains the detailed chat
stages: do not add parent and child durations, or add independently calculated
percentiles. These metrics do not measure RPC admission waits before dispatch or
socket transmission. Existing API turnaround covers pre-dispatch admission waits.

**Per-stage p95 for chat listing (seconds):**

```promql
histogram_quantile(0.95,
  sum by (transport, stage, le) (
    rate(api_stage_duration_seconds_bucket{job="wetty-chat-backend",api="chats.list"}[$__rate_interval])
  )
)
```

**Stage observations exceeding 500 ms per second:**

```promql
sum by (api, transport, stage) (
  rate(api_stage_duration_seconds_count{job="wetty-chat-backend"}[$__rate_interval])
)
-
sum by (api, transport, stage) (
  rate(api_stage_duration_seconds_bucket{job="wetty-chat-backend",le="0.5"}[$__rate_interval])
)
```

Use the second query to locate intermittent slow stages without relying solely
on low-volume percentile estimates. Neither query separates successful and failed
attempts. Counts and sums are additive across instances; retain `instance` in
aggregations when checking for an instance-specific stall.


## API PromQL

These examples aggregate the `wetty-chat-backend` job across instances over five
minutes. For business-traffic transport share, exclude only the explicit
housekeeping operations below from both numerator and denominator; in particular,
`auth.refresh` and `sessions.listClients` remain business traffic.

**Business traffic share by transport (percent)**

```promql
100 * sum by (transport) (
  rate(api_requests_total{job="wetty-chat-backend",api!~"session[.](open|ping|setAppState)|presence[.]watch|conversations[.](watchUnread|watchStates)|sessions[.]createWebSocketTicket"}[5m])
)
/
scalar(sum(
  rate(api_requests_total{job="wetty-chat-backend",api!~"session[.](open|ping|setAppState)|presence[.]watch|conversations[.](watchUnread|watchStates)|sessions[.]createWebSocketTicket"}[5m])
))
```

**Successful per-API p95 across transports (seconds)**

```promql
histogram_quantile(0.95,
  sum by (api, le) (
    rate(api_request_duration_seconds_bucket{job="wetty-chat-backend",status=~"2..|3.."}[5m])
  )
)
```

Add `transport` to the aggregation to separate transports. Restricting latency
to successful calls prevents fast errors from making a failing API appear fast;
compare failure rates and traffic alongside latency.

**Per-API success rate across transports**

```promql
(
  sum by (api) (rate(api_requests_total{job="wetty-chat-backend",status=~"2..|3.."}[5m]))
  or on (api)
  (0 * sum by (api) (rate(api_requests_total{job="wetty-chat-backend"}[5m])))
)
/
sum by (api) (rate(api_requests_total{job="wetty-chat-backend"}[5m]))
```

The numerator is zero for an API with only failures. A zero or absent
denominator remains undefined/no data, not a healthy success rate; successful
p95 likewise has no meaningful value without successful observations.

**Failure throughput by API, HTTP-equivalent status and native error code**

```promql
sum by (api, transport, status, error_code) (
  rate(api_requests_total{job="wetty-chat-backend",status=~"4..|5.."}[5m])
)
```

This is failures per second, not a fraction. Keep `transport` when interpreting
native codes: HTTP uses HTTP status codes, RPC uses RPC codes. `status` separates
4xx from 5xx; compare against the full traffic rate for context:

```promql
sum by (api, transport) (
  rate(api_requests_total{job="wetty-chat-backend"}[5m])
)
```

This volume includes housekeeping, as do the latency and outcome examples; use
the business-traffic filter above on both sides of any filtered ratio.

## Chat messages

| Family | Type / labels | Meaning and recording boundary | Buckets / cardinality |
| --- | --- | --- | --- |
| `messages_total` | Counter; `chat_id` | Incremented once after message insertion and preparation for all sender and message kinds, including invite, pin and member system messages. Duplicate retries that return early are not counted. The increment can occur inside a surrounding transaction, before commit, so a later rollback does not undo it. | `chat_id` is an unbounded per-chat label. Use aggregation/retention deliberately; do not add further per-entity labels. |
| `messages_by_chat_kind_total` | Counter; `chat_kind` | Incremented at the same boundary and under the same rules as `messages_total`. | `chat_kind` is the destination `GroupKind`, bounded to `dm` or `group`; threads inherit their destination chat kind, and forwards use the destination kind. Both counter children start at zero. |

**Message share by destination chat kind over the selected dashboard range**

```promql
(
  sum by (chat_kind) (
    increase(messages_by_chat_kind_total{job="wetty-chat-backend",chat_kind=~"dm|group"}[$__range])
  )
  /
  scalar(sum(
    increase(messages_by_chat_kind_total{job="wetty-chat-backend",chat_kind=~"dm|group"}[$__range])
  ))
) >= 0
```

Evaluate at the end of the selected range; the result is a fraction formatted as
a percentage. Counters from instances are additive, so calculate `increase` per
series before summing. If only one kind has observations, it represents the
whole distribution; zero or absent total traffic has no defined share. The
comparison filters undefined fractions without removing valid zero shares.

The aggregate family is available only after deployment; historical messages
are not backfilled. Its two fixed counter children avoid per-chat first-sample
loss when new chats are created. Prometheus `increase` still requires sufficient
samples per series and extrapolates, so it may not reflect every individual
message.

## WebSocket registry

| Family | Type / labels | Meaning and recording boundary | Buckets / cardinality |
| --- | --- | --- | --- |
| `ws_connected_users` | Gauge | Current number of user entries in the in-process connection registry. | No labels. |
| `ws_active_connections` | Gauge | Current registered connections reporting active app presence. | No labels. |
| `ws_inactive_connections` | Gauge | Current registered connections not reporting active app presence, including newly connected sockets and connections past personal away expiry. | No labels. |
| `ws_connections_total` | Counter | Successfully registered WebSocket connections. | No labels. |
| `ws_connection_duration_seconds` | Histogram | Duration from the authenticated socket handler start through connection removal, in seconds. | `H2`; no labels. |
| `ws_messages_pushed_total` | Counter; `message_type` | Broadcast messages accepted by a WebSocket send buffer. | One series per emitted message type, not per user or connection. |
| `ws_messages_dropped_total` | Counter; `message_type` | Broadcast messages rejected by a full or closed WebSocket send buffer. Rejection also signals that connection to disconnect, so clients can calibrate after reconnecting. | One series per emitted message type, not per user or connection. |

Connection-local unread summaries and conversation-state snapshots are sent directly by the socket task, outside the broadcast queue; they do not increment the broadcast pushed/dropped counters.

Notification preference broadcasts use `message_type=notificationSettingsChanged` and
`message_type=chatNotificationSettingChanged`, plus `message_type=notificationExceptionsCleared` for a category-wide reset. Chat preference and archive writes also
emit the compatible `chatArchiveStateChanged` snapshot; each accepted/rejected event
is counted separately, without user or chat labels.

Group membership-message policy broadcasts use `message_type=membershipMessagePolicyChanged`, carrying only the chat ID to invalidate cached policies after policy or role changes. They also invalidate unread watches; no user or chat labels are added.

Successful member additions and invite redemptions use `message_type=chatMembershipChanged`, carrying only the chat ID to the joining user's connections. These events invalidate that user's unread watches independently of system-message visibility; no user or chat labels are added.

Speaking restriction broadcasts use `message_type=groupSpeakingModeChanged` for
group-wide settings and `message_type=memberSpeakingModeChanged` for personal
settings and role changes. They carry the updated state; unlike notification
preferences, they do not invalidate unread counts.

## Presence snapshots

Snapshots include initial watches, periodic refreshes, and refreshes triggered by committed
privacy/relationship changes. A completed result discarded because of a concurrent policy
change still records its service duration; the replacement query records another observation.

All presence duration metrics use `H3`; all have no identifiers as labels. For
the process-local presence boundary, see the [Scoped WebSocket presence section
of the backend README](../README.md#scoped-websocket-presence).

| Family | Type / labels | Meaning and recording boundary | Buckets / cardinality |
| --- | --- | --- | --- |
| `presence_snapshot_duration_seconds` | Histogram; `result=success\|failure` | Completed service snapshot latency, including scope data and shared-count waits; excludes serialization and socket send. | `H3`; fixed result label only. Cancellation before completion is not recorded. |
| `presence_scope_load_duration_seconds` | Histogram; `result=success\|failure` | Authorization (including reciprocal individual-presence privacy) and requested-user data loading, including `spawn_blocking` scheduling, database-pool wait, and database work. | `H3`; fixed result label only. Cancellation before completion is not recorded. |
| `presence_group_count_lookup_duration_seconds` | Histogram | Every authorized group aggregate lookup, including cache hits, coalesced refresh waits, and errors. | `H3`; no labels. Cancellation before completion is not recorded. |
| `presence_group_count_refresh_duration_seconds` | Histogram; `result=success\|failure` | Only an actual Moka cache initializer's completed refresh: blocking-task scheduling, pool wait, membership query, and registry scan. | `H3`; fixed result label only. Cancellation before completion is not recorded. |
| `presence_group_online_scan_duration_seconds` | Histogram | Registry scan time only, after membership loading succeeds, for an actual refresh. | `H3`; no labels. A blocking scan may complete and record after its caller is cancelled. |
| `presence_group_members_scanned` | Histogram | One observation of membership UID count per actual group scan, not per viewer. | `H4`; no labels. |

## Push delivery

| Family | Type / labels | Meaning and recording boundary | Buckets / cardinality |
| --- | --- | --- | --- |
| `push_notifications_total` | Counter; `provider`, `result` | Push delivery attempts, classified success or failure. | Provider/result are low-cardinality classifications; never use subscription or user IDs. |
| `push_notification_jobs_total` | Counter; `result` | Push worker jobs processed, including database connection failures. | Fixed success/failure result labels. |
| `push_notification_job_duration_seconds` | Histogram; `result` | Push worker job runtime, in seconds. | `H5`; fixed success/failure result labels. |
| `push_notifications_suppressed_total` | Counter | Recipient notifications skipped because active WebSocket presence suppresses push. | No labels. |
| `push_delivery_failures_total` | Counter; `provider`, `class` | Classified failed delivery attempts. | Classification labels are deliberately bounded; never use an error message as a label. |
| `push_subscription_prunes_total` | Counter; `provider`, `reason` | Subscriptions pruned after delivery failure. | Classification labels are deliberately bounded; never use subscription/user IDs. |

## Avatar lookup

| Family | Type / labels | Meaning and recording boundary | Buckets / cardinality |
| --- | --- | --- | --- |
| `discuz_avatar_lookup_duration_seconds` | Histogram | Enabled Discuz avatar lookup latency for a requested UID batch, in seconds. | `H6`; no labels. Lookups return without recording when avatar resolution is not configured. |
| `discuz_avatar_lookup_fs_duration_seconds` | Histogram | Time spent on filesystem metadata calls made by this enabled Discuz avatar lookup, in seconds; cache hits and coalesced waits contribute zero. | `H6`; no labels. |
| `discuz_avatar_lookup_users_total` | Counter | Requested users processed by enabled Discuz avatar lookups. | No labels. |

Avatar URLs and missing-avatar placeholders are cached per UID for 60 seconds
after insertion; hits do not extend the TTL. The shared cache has a capacity of
20,000 entries and may evict or reject entries under capacity pressure. Concurrent
misses for the same UID share one filesystem lookup.

## Client tracking and daily activity

Tracked authenticated HTTP/RPC operations, active WebSocket pings, and explicit
active state reports record last seen in memory immediately. Inactive WebSocket
reports update connection liveness only. Client ownership binding remains
synchronous on first use/account changes and is cached for same-account activity;
timestamps, versions, and daily rollups use the shared background activity worker.
See the [activity persistence contract](../README.md#scoped-websocket-presence)
for buffer limits, flush bounds, ownership ordering, retries, and durability.

Client metadata observations retain the five-minute throttle, bypassed on account,
application-version, or observation UTC-day changes. Legacy active reports preserve
the recorded application version; RPC supplies its version during session binding.
Worker snapshots and acknowledgement update the pending gauges, normally every
15 seconds; they are not a per-scrape measurement of the buffers.

HTTP bookkeeping follows the [direct user-session eligibility rules](../README.md#scoped-websocket-presence):
service-token requests and requests carrying `X-On-Behalf-Of` schedule no client
writes, including subsequent legacy WebSocket reports. RPC ignores upgrade
headers and uses only the first-frame verified user/client. Excluded HTTP and
legacy reports do not increment client-write, client-write-throttling,
client-rebind or client-bookkeeping rollup metrics.

| Family | Type / labels | Meaning and recording boundary | Buckets / cardinality |
| --- | --- | --- | --- |
| `client_activity_writes_total` | Counter; `result=success\|error` | Background client metadata transaction attempts; excludes binding and user last-seen transactions. | Two outcomes. |
| `client_activity_writes_skipped_total` | Counter; `reason=throttled` | Client metadata observations suppressed by the five-minute throttle; last seen is still buffered. | One reason. |
| `client_activity_pending` | Gauge | Sum of buffered client/day and user/day entries at the latest worker snapshot or acknowledgement. | No labels. |
| `client_activity_oldest_pending_seconds` | Gauge | Maximum pending age across client entries and user last-seen observations at the latest worker snapshot or acknowledgement; zero when empty. | No labels. |
| `client_activity_dropped_total` | Counter | Client or user observations dropped when their pending buffer is full; never fails the business request. | No labels. |
| `client_activity_flush_duration_seconds` | Histogram; `outcome=success\|error` | Combined client and last-seen flush duration when at least one buffer is nonempty; partial progress followed by an error records `error`. | `H12`; both outcomes registered at startup. |
| `client_activity_flush_retry_needed_total` | Counter | Nonempty combined flush attempts that fail and leave work pending for retry; increments once per attempt, not per entry or actual retry. Includes pool, lock, statement, and uncertain-commit failures. | No labels. |
| `client_rebinds_total` | Counter | Successful client-to-user ownership transitions, recorded immediately after binding commits; daily rollup persistence may lag. | No labels. |
| `client_tracking_purge_total` | Counter; `kind` | Client tracking records purged, incremented by the number deleted. | `kind` is a bounded record-kind classification. |
| `activity_daily_rollup_updates_total` | Counter; `result` | Daily activity rollup updates from client bookkeeping, purge work, and last-seen batches; failed batch acquisition or persistence also records an error. | Result is a small outcome classification. |
| `activity_today_active_users` | Gauge | Exact active-user count for today mirrored from the daily rollup. | No labels. |
| `activity_today_new_users` | Gauge | Exact new-user count for today mirrored from the daily rollup. | No labels. |
| `activity_today_active_clients` | Gauge | Exact active-client count for today mirrored from the daily rollup. | No labels. |
| `activity_today_new_clients` | Gauge | Exact new-client count for today mirrored from the daily rollup. | No labels. |
| `activity_today_client_rebinds` | Gauge | Exact client-rebind count for today mirrored from the daily rollup. | No labels. |
| `activity_today_stale_clients_purged` | Gauge | Exact stale-client purge count for today mirrored from the daily rollup. | No labels. |
| `activity_today_legacy_subscriptions_purged` | Gauge | Exact legacy-subscription purge count for today mirrored from the daily rollup. | No labels. |
| `app_version_active_clients` | Gauge; `version` | Unique authenticated client IDs active in the rolling last 24 hours, grouped by their latest persisted app version across HTTP and RPC. | Version values are client supplied and can grow without bound; monitor and constrain this label operationally. |

Each client record contributes once, regardless of request volume, connections,
reconnects, account rebinds, upgrades, or server restarts. HTTP records versions
from its app-version header; an authenticated RPC `session.open` alone records
client usage and its version. Later activity preserves the recorded version. Missing,
empty, and whitespace-only persisted versions are reported as `unknown`, merged
with a literal `unknown` version. Anonymous sessions and excluded service-token
or on-behalf-of requests do not contribute client bookkeeping.

Each instance refreshes this shared database snapshot asynchronously at startup
and every 60 seconds, retaining the last successful snapshot if refresh fails.
Persisted activity is subject to the five-minute observation throttle and the
background flush schedule. Version changes bypass the throttle but still await
flushing; failures or a backlog can extend this delay. Snapshot publication adds
up to the refresh interval. Each successful refresh removes expired clients and
versions with no remaining clients. The gauge has no series for an empty population; this is
healthy no-data, not a zero-filled distribution.

Snapshots are replicas, not instance-local counts: use
`max by (version) (app_version_active_clients{job="wetty-chat-backend"})`
across instances, never sum replicas or apply `rate`/`increase`. Divide that
per-version result by its sum for the client distribution; do not weight it by
request volume. See the [Grafana dashboard](../../docs/grafana.json).

## Message search

| Family | Type / labels | Meaning and recording boundary | Buckets / cardinality |
| --- | --- | --- | --- |
| `message_search_index_operations_total` | Counter; `operation`, `result` | Index operations completed by the best-effort index work. | `operation` is `upsert`, `delete`, or `delete_batch`; result is success/failure. |
| `message_search_queries_total` | Counter; `sort`, `result` | Message search queries completed. | `sort` is `relevance` or `newest`; result is success/failure. |
| `message_search_query_duration_seconds` | Histogram; `sort`, `result` | Message-search request latency, in seconds. | `H1`; bounded sort/result labels. |
| `message_search_index_operation_duration_seconds` | Histogram; `operation`, `result` | Index operation latency from enqueue to Meilisearch task completion, in seconds. | `H7`; bounded operation/result labels. |
| `message_search_candidates_per_query` | Histogram; `sort` | Meilisearch candidate hits per query. | `H8`; bounded sort label. |
| `message_search_results_per_query` | Histogram; `sort` | Authoritative messages returned after database filtering, per query. | `H8`; bounded sort label. |
| `message_search_candidates_dropped_total` | Counter; `reason` | Candidate hits dropped during database authority checks. | Reasons are `missing_db_row`, `wrong_chat`, `not_searchable`, and `stale_version`. |
| `message_search_index_documents_total` | Counter; `operation`, `result` | Documents affected by index operations; zero-document operations do not increment it. | Bounded operation/result labels. |
| `message_search_reindex_duration_seconds` | Histogram; `result` | Full reindex job latency, in seconds. | `H9`; success/failure labels. |
| `message_search_reindex_documents_total` | Counter; `result` | Documents indexed by full reindex jobs; zero-document jobs do not increment it. | Success/failure labels. |
| `message_search_reindex_last_success_timestamp_seconds` | Gauge | Unix timestamp in seconds of the last successful full reindex. | No labels. |

## Background jobs

| Family | Type / labels | Meaning and recording boundary | Buckets / cardinality |
| --- | --- | --- | --- |
| `background_jobs_total` | Counter; `job_kind`, `result` | Background jobs processed by the worker. | Current `job_kind` is `bulk_delete_messages`; result is success/failure. Keep future kinds bounded. |
| `background_job_duration_seconds` | Histogram; `job_kind`, `result` | Runtime of a processed background job, in seconds. | `H10`; same bounded labels as `background_jobs_total`. |

## Audio transcoding

| Family | Type / labels | Meaning and recording boundary | Buckets / cardinality |
| --- | --- | --- | --- |
| `audio_transcode_source_total` | Counter; `content_type` | Audio transcode work entering the job path, grouped by normalized attachment media type. | The label is normalized to `audio/ogg`, `audio/mp4`, `audio/mpeg`, `audio/webm`, `audio/wav`, `audio/aac`, `audio/flac`, `other`, or `unknown`; raw MIME types are not used. |
| `audio_transcode_jobs_total` | Counter; `result` | Audio transcode jobs completed; an unfinished metric guard records failure when dropped. | Fixed success/failure labels. |
| `audio_transcode_job_duration_seconds` | Histogram; `result` | Audio transcode job runtime, in seconds; the same guard records the duration. | `H11`; fixed success/failure labels. |

## Presence PromQL

These examples use a five-minute range and aggregate across all matching
instances. Add your deployment's identifying labels only when you need to
partition the result.

**Successful snapshot p95**

```promql
histogram_quantile(
  0.95,
  sum by (le) (
    rate(presence_snapshot_duration_seconds_bucket{result="success"}[5m])
  )
)
```

**Snapshot error rate**

```promql
sum(rate(presence_snapshot_duration_seconds_count{result="failure"}[5m]))
/
sum(rate(presence_snapshot_duration_seconds_count[5m]))
```

**Estimated group-count refresh work avoided by lookups**

```promql
1 -
sum(rate(presence_group_count_refresh_duration_seconds_count[5m]))
/
sum(rate(presence_group_count_lookup_duration_seconds_count[5m]))
```

This includes coalesced waits and estimates avoided refresh work; it is not a
strict cache-hit rate.

Ratios are undefined when there is no traffic in the selected range; dashboards
should show that as no data rather than claiming a zero error rate or cache benefit.

**Average membership UID count scanned per actual group scan**

```promql
sum(rate(presence_group_members_scanned_sum[5m]))
/
sum(rate(presence_group_members_scanned_count[5m]))
```
