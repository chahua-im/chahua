# Stickers and sticker packs

Sticker RPC methods require an authenticated session; HTTP uploads require bearer authentication. Pack IDs and
sticker IDs retain their string-encoded Snowflake representation. Field names
use camelCase.

## Create a sticker from a message

`stickers.createFromMessage` adds a new sticker to an
existing pack owned by the caller. The flat RPC parameters are:

```json
{
  "packId": "789",
  "chatId": "123",
  "messageId": "456",
  "emoji": "😀",
  "name": "Optional name",
  "description": "Optional description"
}
```

`packId`, `chatId`, `messageId`, and `emoji` are required. The caller must be a current
member of the source chat. The source must be a published, undeleted text-type
message with no non-whitespace text and exactly one active image attachment;
images sent as file messages are excluded. The image may belong to any sender.
Read-only speaking restrictions do not prevent copying an accessible image.
Membership checks do not lock the member record or the chat. Removal after the
final membership check may race with a successful copy; message and attachment
locks still keep the source content consistent through insertion.

The server reads the stored attachment, which may already be compressed, and
uses the same processing as a direct sticker upload. Inputs are limited to
10 MiB, including actual bytes downloaded from storage. Emoji validation accepts
one to four emoji graphemes. Static images are resized to a maximum dimension
of 512 pixels and encoded as WebP; animated GIF/WebP images retain their bytes.
Blank optional names and descriptions are stored as null.

Success returns the existing `StickerSummary` representation as the RPC result. The
sticker has independent media; the source message and attachment are unchanged.
This operation does not create packs or emit message update events. Each
successful request creates a new sticker; retries are not deduplicated.

Invalid composition, emoji, image data, or excessive input size returns RPC `BadRequest` (1000).
Missing chat membership or pack ownership returns RPC `Forbidden` (1003); missing packs and
missing, deleted, or unpublished source messages return RPC `NotFound` (1004). Source eligibility
and permissions are checked again before committing. Replacing the source image
during processing returns RPC `Conflict` (1009); other changes return the corresponding
eligibility or permission error. Database inserts are atomic. Failure to acquire
a connection for insertion, failed revalidation, or a failed commit triggers
best-effort deletion of the newly uploaded sticker object.

Both message-based creation and multipart sticker uploads acquire database
connections only for their initial checks and final insertion. Downloads,
multipart reads, image processing, and object uploads run without holding a
database connection. Connection acquisition and synchronous database queries run
on blocking workers rather than the async executor.

Message and membership lookups use primary keys. The attachment lookup is scoped
by the existing message-ID index and fetches at most two active rows to reject
multi-attachment messages. No new database index or migration is required.

## Visibility

`visibility` is either `public` or `private`. Existing packs are migrated to
public; newly created packs also default to public when the request omits the
field, including requests from older clients. Authors can explicitly choose
`private` when creating a pack or change its visibility afterward.

Authors set visibility through `POST /stickers/packs` and
`PATCH /stickers/packs/{packId}`. Omitting visibility in a PATCH preserves it;
explicit null and unknown enum values are invalid. Pack summaries and details
include visibility.

Private packs are absent from discovery, search and rankings, including for
their author. Authors access them through `/stickers/packs/mine/owned`.
Nonowners receive 404 when requesting private pack details or attempting to
subscribe. The owner's automatic subscription remains valid.

Making a pack private atomically removes other users' subscriptions and its
entries in their sticker pack order. Making it public again does not restore
those subscriptions. Deleting a pack also cleans subscribers' order entries.
Unsubscribing after a subscription has already been revoked remains idempotent.

Visibility applies to the pack, not to individual stickers or their media.
Existing favorites and sent messages remain usable. Anyone with a sticker ID
can continue to view and favorite that sticker. Single-sticker details only
include associated packs that are public or owned by the caller; `packs` may
be empty. A sticker may belong to several packs with different visibility.

## Discovery endpoint

`GET /stickers/packs` accepts:

| Parameter | Default | Contract |
| --- | --- | --- |
| `q` | none | Literal substring of name or description, trimmed, at most 255 Unicode characters |
| `sort` | `trending` | `subscribers` or `trending` |
| `limit` | 20 | Integer from 1 through 50 |
| `offset` | 0 | Nonnegative integer, number of matching packs to skip |

Whitespace-only queries behave as no query. Matching uses PostgreSQL ILIKE;
one-character Chinese queries work, and `%`, `_`, and backslash in input are
treated literally. Invalid query parameters return 400. Only public nonempty
packs qualify. Already subscribed packs remain in the results.

Search filters the candidate packs before applying the requested ranking.
There is no separate relevance, newest or Meilisearch-backed ranking.

The response contains `packs`, `hasMore`, `recentWindowDays` (30), and
`statsUpdatedAt`. Each entry contains the existing pack summary plus
`subscriberCount`, `recentSubscriberCount`, and `previewStickers` (up to four).
The existing `previewSticker` field reuses the first entry of `previewStickers`,
without a separate preview query. Previews use added time ascending, then
sticker ID ascending. `hasMore` comes from fetching one extra
ranked row; there is no total-count query.

## Ranking semantics

`subscriberCount` counts current subscriptions excluding the pack's owner.
`recentSubscriberCount` counts current subscriptions whose `subscribed_at` is
within the inclusive interval from `statsUpdatedAt - 30 days` to
`statsUpdatedAt`, also excluding the owner.

| Sort | Descending keys |
| --- | --- |
| `subscribers` | subscriberCount, pack ID |
| `trending` | recentSubscriberCount, subscriberCount, pack ID |

Zero-subscription packs remain eligible. Repeating an existing subscription
does not change its timestamp. Unsubscribing removes the record; subscribing
again creates a new timestamp and can count toward recent subscriptions.
These counts are not historical additions, first-time subscribers or net growth.

The database computes counts on each request; there is no ranking cache.
`statsUpdatedAt` is the window reference time within the read transaction.
Stable tie-breaking does not freeze the ranking between requests: offset
pagination can repeat or miss packs if subscriptions change while browsing.

## Consistency and query shape

Discovery and reads assembling externally visible pack contents use a read-only
repeatable-read transaction so authorization, associations and media metadata
come from the same database snapshot. A request already in progress may return
the previously public snapshot; it cannot mix it with subsequently private
contents. The server does not retract media or content already received by a
client.

Subscription and visibility writers lock the pack before user order rows.
Reordering locks requested packs in ID order before locking the user row,
then checks ownership and subscriptions. Revocation locks affected user rows
in UID order. Late order requests cannot restore a revoked subscription or
order entry. WebSocket order updates are sent only after successful commit.
The existing event carries no revision number; concurrent committed updates
can still arrive out of order at an existing client. Server reads remain the
source of truth.

Ranking aggregates subscriptions before pagination. Only the selected page
loads authors, counts, subscription flags and previews, in batches. Preview
selection uses a bounded lateral lookup on the existing
`(pack_id, added_at, sticker_id)` index. The subscription
`(pack_id, subscribed_at)` index supports filtered ranking and pack-level
subscription operations; an unfiltered ranking still aggregates qualifying
subscriptions. Search does not read message history.

The implementation lives in [the pack service](../src/services/stickers.rs),
[order persistence](../src/services/sticker_order.rs), and
[discovery queries](../src/services/sticker_discovery.rs).
Query measurements and indexing decisions are recorded in
[query verification](sticker-pack-query-verification.md).
