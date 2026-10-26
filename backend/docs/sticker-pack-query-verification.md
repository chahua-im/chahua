# Sticker pack query verification

Measurements recorded on 2026-10-26 for the
[sticker pack discovery and visibility contract](stickers.md).

## Method and dataset

The queries were measured with `EXPLAIN (ANALYZE, BUFFERS)` on local Docker
PostgreSQL 18.3 in an isolated test database. Session-local temporary tables
provided the synthetic data; writes ran inside transactions ending in
`ROLLBACK`.

The ranking dataset contained 5,000 nonempty packs and 100,000 subscriptions
distributed across approximately 20,000 user IDs, with 20 subscriptions per
pack. Of these packs, 4,550 were public and 50 public packs matched the
single-character Chinese query `猫`. Visibility used a text column to simulate
the enum. The fixture retained relevant keys and indexes but did not reproduce
the complete production schema or data distribution. These measurements compare
query paths; they do not predict production response times.

Ranking selected 21 rows with a reference time of `2026-10-26T00:00:00Z` and
a 30-day recent window. The baseline subscription indexes were the
`(uid, pack_id)` primary key and `(uid, subscribed_at DESC)`. The same queries
were measured after adding `(pack_id, subscribed_at)` and running `ANALYZE`.

## Ranking and search

The aggregate query is `DISCOVERY_SQL` in
[sticker_discovery.rs](../src/services/sticker_discovery.rs).

| Query | Without pack index | With pack index | Execution path |
| --- | --- | --- | --- |
| Trending without a keyword | 57.3 ms | 58.9 ms | Scans 100,000 subscriptions, hash join and aggregate, top-N sort |
| Single-character Chinese search | 16.9 ms | 7.3 ms | The pack index restricts subscription reads to 50 matching packs and 1,000 records |

Both queries scan pack metadata to evaluate visibility and substring matching.
The unfiltered ranking still aggregates qualifying subscriptions; the new index
does not remove that work. The index also supports reading and removing
subscriptions when a pack becomes private.

The implementation includes `(pack_id, subscribed_at)` and retains the existing
user-oriented indexes. It uses live database statistics without a ranking cache
or search engine. Cache decisions should be revisited if measured request volume
and aggregation cost warrant them. No trigram index was evaluated for these
short Chinese substring queries.

## Bounded previews

`load_preview_stickers` in the discovery service uses a lateral lookup with
`LIMIT 4` per pack, followed by a batch load of stickers and media. Selecting IDs
for 20 packs took approximately 0.18 ms using the existing
`(pack_id, added_at, sticker_id)` index and one bounded index-only scan per pack.
This performance fixture contained only one sticker per pack. Separate database
tests cover packs with more than four stickers, equal addition times, shared
stickers, and empty packs.

A separate comparison used 1,000 packs with 200 stickers each and a page of
20 packs. Selecting a first preview with a joined `DISTINCT ON` query scanned
200,000 stickers and performed 4,000 media lookups, taking approximately
31.9 ms. Bounding each pack to four stickers before joining read 80 stickers
and their media, taking approximately 0.78 ms. These are individual SQL timings,
not complete endpoint timings.

Discovery reuses the first of its four previews for `previewSticker`, so summary
assembly does not run the separate first-preview query. When repeating these
measurements, regenerate the synthetic data, run `ANALYZE`, and record the
PostgreSQL version, dataset sizes, index definitions, and execution plans.
