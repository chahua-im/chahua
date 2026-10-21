# Backend metrics catalog

The backend exposes Prometheus metrics from a **metrics-only** listener. It binds
`0.0.0.0:3001` by default; set `METRICS_ADDR` to override the address. `GET
/metrics` returns the shared application registry in Prometheus text exposition
format. The metrics listener only exposes that route, separate from the API
listener.

The registry is explicitly constructed in `src/metrics/mod.rs`. The application
does not register built-in runtime or process collectors, so those series are
not part of this endpoint unless source code registers them later.

## Reading this catalog

- **Counter** values are monotonically increasing totals since process start.
  A `*_total` metric is a counter.
- **Gauge** values are current snapshots and can rise or fall.
- Each **histogram** named `foo` exposes `foo_bucket{le="..."}`, `foo_sum`, and
  `foo_count`; it has no separate redundant total. `histogram_quantile` consumes
  the bucket series.
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

## HTTP API

| Family | Type / labels | Meaning and recording boundary | Buckets / cardinality |
| --- | --- | --- | --- |
| `http_requests_total` | Counter; `method`, `route`, `status` | Completed non-multipart API requests, counted after the handler returns. `route` is Axum's matched route template, or `unknown` when none matched; `status` is the numeric response status. | The route template, method, and status keep this bounded by the API surface; do not replace `route` with a request path. |
| `http_request_duration_seconds` | Histogram; `method`, `route`, `status` | End-to-end non-multipart API request latency around the next handler, in seconds. | `H1`; same bounded labels as `http_requests_total`. |
| `http_multipart_duration_seconds` | Histogram; `method`, `route`, `status` | End-to-end requests whose `Content-Type` starts with `multipart/form-data`, in seconds. | `H1`; same bounded labels as `http_requests_total`. |

## Chat messages

| Family | Type / labels | Meaning and recording boundary | Buckets / cardinality |
| --- | --- | --- | --- |
| `messages_total` | Counter; `chat_id` | Successfully persisted messages. It increments once after persistence for all sender/message kinds; duplicate retries that return early are not counted. | `chat_id` is an unbounded per-chat label. Use aggregation/retention deliberately; do not add further per-entity labels. |

## WebSocket registry

| Family | Type / labels | Meaning and recording boundary | Buckets / cardinality |
| --- | --- | --- | --- |
| `ws_connected_users` | Gauge | Current number of user entries in the in-process connection registry. | No labels. |
| `ws_active_connections` | Gauge | Current registered connections reporting active app presence. | No labels. |
| `ws_inactive_connections` | Gauge | Current registered connections reporting inactive app presence. | No labels. |
| `ws_connections_total` | Counter | Successfully registered WebSocket connections. | No labels. |
| `ws_connection_duration_seconds` | Histogram | Duration from the authenticated socket handler start through connection removal, in seconds. | `H2`; no labels. |
| `ws_messages_pushed_total` | Counter; `message_type` | Broadcast messages accepted by a WebSocket send buffer. | One series per emitted message type, not per user or connection. |
| `ws_messages_dropped_total` | Counter; `message_type` | Broadcast messages rejected by a full or closed WebSocket send buffer. | One series per emitted message type, not per user or connection. |

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
| `discuz_avatar_lookup_fs_duration_seconds` | Histogram | Filesystem portion of an enabled Discuz avatar lookup, in seconds. | `H6`; no labels. |
| `discuz_avatar_lookup_users_total` | Counter | Requested users processed by enabled Discuz avatar lookups. | No labels. |

## Client tracking and daily activity

Authenticated HTTP requests and WebSocket heartbeats (both active and inactive) share
the per-client five-minute activity write throttle. Heartbeats update user/client activity
and daily rollups without changing the recorded HTTP application version.

| Family | Type / labels | Meaning and recording boundary | Buckets / cardinality |
| --- | --- | --- | --- |
| `client_activity_writes_total` | Counter; `result` | Client activity database writes attempted. | Result is a small outcome classification. |
| `client_activity_writes_skipped_total` | Counter; `reason` | Client activity writes skipped before a write; currently used for throttling. | Keep reasons bounded; never label by client or user. |
| `client_rebinds_total` | Counter | Client-to-user rebind events recorded during a daily rollup update. | No labels. |
| `client_tracking_purge_total` | Counter; `kind` | Client tracking records purged, incremented by the number deleted. | `kind` is a bounded record-kind classification. |
| `activity_daily_rollup_updates_total` | Counter; `result` | Daily activity rollup update attempts. | Result is a small outcome classification. |
| `activity_today_active_users` | Gauge | Exact active-user count for today mirrored from the daily rollup. | No labels. |
| `activity_today_new_users` | Gauge | Exact new-user count for today mirrored from the daily rollup. | No labels. |
| `activity_today_active_clients` | Gauge | Exact active-client count for today mirrored from the daily rollup. | No labels. |
| `activity_today_new_clients` | Gauge | Exact new-client count for today mirrored from the daily rollup. | No labels. |
| `activity_today_client_rebinds` | Gauge | Exact client-rebind count for today mirrored from the daily rollup. | No labels. |
| `activity_today_stale_clients_purged` | Gauge | Exact stale-client purge count for today mirrored from the daily rollup. | No labels. |
| `activity_today_legacy_subscriptions_purged` | Gauge | Exact legacy-subscription purge count for today mirrored from the daily rollup. | No labels. |
| `app_version_requests_total` | Counter; `version` | Non-WebSocket-upgrade HTTP requests observed by client tracking, grouped by the request app-version header or `unknown`. | Version values are client supplied and can grow without bound; monitor and constrain this label operationally. |
| `app_version_unique_clients` | Gauge; `version` | Unique client IDs observed per app version in the current process. Requests without a resolved client ID increment the request counter but do not change this gauge. | Per-version series only, but the `version` label has the same unbounded client-supplied cardinality risk. |

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
