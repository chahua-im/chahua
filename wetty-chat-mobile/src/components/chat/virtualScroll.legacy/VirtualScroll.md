# Chat Virtual Scroll

This document is the implementation plan for the next chat virtual scroll rewrite.
It replaces the earlier measured-core design notes as the canonical source of truth.

The target is a chat-specific virtualizer that keeps the good behavior from commit
`956e92a37c4f144e513dc777963f024eafe0ee4a` without paying the old "measure the
entire loaded store before first paint" cost.

## Summary

We will use a hybrid model:

- global geometry for the full loaded `ChatRow[]`
- exact measured rows in the mounted viewport window
- hidden staging batches for rows that must be measured before becoming visible
- top and bottom spacers for everything outside the mounted window

The critical design decision is:

- the height tree is used for aggregate geometry and index lookup only
- mounted rows render in normal flow between spacers
- visible rows must never rely on estimated heights
- we do not position visible rows with per-row `translateY`

This is a direct replacement behind the existing `ChatVirtualScroll` API.

## Goals

1. No full-list hidden measuring pass on initial load.
2. Bottom-open remains the default behavior for normal chat entry.
3. Opening at a specific message remains supported through explicit item anchors.
4. Prepend, append, jump, resize, and optimistic confirmation preserve the viewport correctly.
5. Mounted DOM stays bounded.
6. Chat switching must not produce blank or stale-view returns.

## Non-Goals

- Generic feed virtualization.
- Perfectly stable scrollbar thumb size while offscreen estimates are corrected.
- Preserving scroll position across normal chat exit and re-entry. The default remains "reopen at bottom."

## Row Model

`conversation.tsx` continues to provide a flat `ChatRow[]` model.

Key rules:

- date rows keep stable `date:` / `datefirst:` keys
- group rows keep stable `grp:${clientGeneratedId || id}` keys
- mutation classification uses `grp:` keys only

The row model in `useChatRows()` stays as-is.

## Public API

`ChatVirtualScroll` keeps the current external contract:

- `rows`
- `renderRow`
- `initialAnchor`
- `scrollApiRef`
- `loadOlder`
- `loadNewer`
- `bottomPadding`
- `onAtBottomChange`

`VirtualScrollHandle` also stays the same:

- `scrollToBottom()`
- `scrollToItem(key, behavior?)`

`initialAnchor` semantics are explicit:

- `{ type: 'bottom' }` means normal open / reopen at latest
- `{ type: 'item' }` means explicit jump/open at a specific message

## Core Architecture

### 1. Global Height Model

Use a Fenwick tree over the full `rows` array.

Each index stores:

- exact cached height if the row has been measured
- otherwise a chat-specific estimate

The tree is used for:

- `offsetOf(index)`
- `indexAtOffset(scrollTop)`
- total scroll height
- top spacer height
- bottom spacer height
- exact scroll compensation deltas

The tree is **not** used to absolutely position visible rows.

### 2. Height Cache

Use a persistent keyed cache for the lifetime of the mounted chat view:

- `Map<string, number>`

Rules:

- keys are row keys, never array indices
- cache survives append/prepend within the same chat view
- cache is rebuilt into the height tree when `rowKeys` changes
- cache is discarded when the chat view is torn down or remounted for another `storeChatId`

### 3. Mounted Window

Maintain a bounded measured-only mounted range:

- `overscan = 6`
- `hard cap = 96 rows`

Layout structure:

```text
[top chrome]
[top spacer]
[mounted measured rows in normal flow]
[bottom spacer]
[hidden staging lane]
```

Mounted rows are exact-height rows only.
If a row is not measured yet, it must stay out of the mounted viewport window.

### 4. Hidden Staging Lane

Use a hidden staging lane to measure rows before they become visible.

Rules:

- staging lane width must match the visible chat width
- rows staged here are `visibility: hidden`
- staged rows do not participate in visible layout
- batch commits are atomic: measure the whole batch first, then update tree + mounted range together

### 5. Phases

Keep the lifecycle simple:

- `WAITING_VIEWPORT`
- `BOOTSTRAP`
- `READY`
- `RECENTERING`

Do not reintroduce measured-core style sub-phases for prepend/load/expand behavior.
Those are layout intents, not top-level lifecycle phases.

## Height Estimates

Use simple fixed buckets for offscreen geometry:

- date row: `32`
- deleted message: `48`
- plain text message: `76`
- reply preview surcharge: `+26`
- attachment message base: `220`
- cap any estimate at `320`

These estimates only back offscreen geometry.
They do not define visible row layout.

## Rendering Rules

### Mounted Rows

Mounted rows render in normal flow.

Do not:

- absolutely position each row
- assign per-row `translateY`
- keep visible rows pinned against tree offsets

Instead:

- top spacer height equals the tree sum before `mounted.start`
- bottom spacer height equals the tree sum after `mounted.end`
- mounted rows sit naturally between those spacers

This reduces visible jitter because tree corrections update spacers, not every visible row's offset.

### Why This Matters

If an offscreen estimate above the viewport becomes exact:

- top spacer height changes
- `scrollTop` is compensated by the exact delta in the same layout cycle
- mounted rows stay in normal flow

If the correction is below the viewport:

- only bottom spacer height changes

Visible rows do not "pop" from estimated to measured size because visible rows are already measured before promotion.

## Bootstrap

### Bottom Open

Default open behavior remains bottom.

Bootstrap algorithm:

1. Wait for a real viewport height.
2. Seed the last `16` rows into staging.
3. Measure them.
4. Commit them as the initial mounted range.
5. If measured height is still below `1.5 * viewportHeight`, stage backward batches of `12`.
6. Reveal once the mounted range is non-empty and covers enough measured height.
7. Snap to bottom, then run a short settle pass over the next two frames.

### Item Open

Explicit item-open is the jump-to-message path.

Bootstrap algorithm:

1. Find the target row index.
2. Stage `8` rows before and `8` rows after the target.
3. Measure and commit that seed.
4. If there is not enough measured content below the target to place it correctly, expand forward in `12`-row batches.
5. If additional context above is needed, expand backward after forward coverage is sufficient.
6. Scroll to the target after the seed is mounted.

## Ready-State Scrolling

### Window Derivation

On scroll:

1. Use `indexAtOffset(scrollTop)` to find the approximate visible start.
2. Derive the desired mounted range with `overscan = 6`.
3. If the desired range is already fully measured, expand or shrink the mounted range to match.
4. If the desired range approaches unmeasured rows within `6` rows of either side, queue a staging batch before those rows are promoted.

### Staging Before Promotion

This is the main anti-jitter rule:

- rows about to become visible are measured in staging first
- only after exact heights are known may they move into the mounted window

There must never be a frame where a row is visible first with an estimate and then with its measured height.

### Large Teleports

If the user thumb-drags or flings far enough that the estimated target index is more than `12` rows outside the mounted range:

1. Enter `RECENTERING`.
2. Keep the scroll position.
3. Stage a fresh seed around the target index.
4. Measure it.
5. Atomically replace the mounted range.

If the viewport would otherwise show no mounted rows during this process:

- show an explicit loading scrim
- do not allow a spacer-only `READY` state

## Mutation Handling

### Prepend

When older rows are inserted at the top:

1. Classify the mutation from `msg:` keys only.
2. Capture the first visible `msg:` row and its viewport offset before paint.
3. Rebuild the height tree from the new `rowKeys`, using cache-or-estimate values.
4. Update the top spacer height.
5. Restore the captured anchor in the same layout cycle.

Prepend data is committed to the store immediately.
Do not buffer prepends in the parent.

Implementation notes from debugging:

- never use `date:` / `datefirst:` rows as the prepend restore anchor; only `msg:` rows are stable enough
- prepend must mount the newly inserted region, not leave it in spacer-only geometry
- prepend preservation needs exact visible-message anchor restoration after layout; raw `scrollTop` preservation is not sufficient on its own

### Append

If bottom lock is active:

- snap to bottom immediately
- run a short two-frame settle pass

If bottom lock is not active:

- preserve current viewport naturally

Implementation notes from debugging:

- logical bottom lock must mean "no newer history exists", not merely "scroll is at the bottom of the currently loaded window"
- when opened from `around` history, scrolling to the bottom edge must load newer messages without reclassifying that state as normal bottom-open
- edge-trigger loading needs one-shot arms plus hysteresis so parked-at-edge states do not loop

### Reset

A reset means the logical row set no longer matches append/prepend semantics.

On reset:

- clear mounted/staging state
- rebuild the height tree
- re-enter `BOOTSTRAP`

### Row Resize After Mount

This is distinct from estimate-to-measure.

If a mounted row changes height after it is already visible:

- if bottom lock is active, snap to bottom
- if the row is above the viewport, add the exact height delta to `scrollTop`
- if the row is inside the viewport, allow natural reflow

Implementation notes from debugging:

- "above the viewport" means only the portion of the row strictly before `viewportTop`
- for very tall rows, compensate only the change in height above the viewport, not the full row delta
- after staged or mounted height correction, verify the same visible `msg:` anchor remains at the same viewport offset; anchor restore is the authoritative correction, numeric height delta is only a coarse first pass

## Network Loading Policy

Network loading remains parent-owned.

Virtualizer rules:

- trigger loads on scroll idle only
- use `200ms` idle debounce
- use exact-edge gating
- use one-shot arms so parked-at-edge states do not retrigger immediately
- re-arm after `24px` of hysteresis

UX notes from debugging:

- show persistent top and bottom edge hints whenever older/newer history may exist, not only after loading starts
- edge hints must reserve their own visual lane and must not overlap date separators or visible message rows

`conversation.tsx` changes:

- keep `useChatRows()`
- keep immediate `prependMessages`
- add real `loadingNewer` state and pass `loadNewer.loading`
- render `ChatVirtualScroll` with `key={storeChatId}`

## Invariants

1. Mounted rows use normal flow layout.
2. Visible rows never depend on estimated heights.
3. The Fenwick tree drives spacers and index lookup only.
4. No per-row `translateY` for mounted rows.
5. Prepend preservation happens before paint.
6. Parent owns network fetch policy.
7. `READY` requires a non-empty mounted measured range.
8. Spacer-only `READY` is invalid.
9. Bottom-open is the default reopen behavior.

## Historical Context

Short version:

- `956e92a37c4f144e513dc777963f024eafe0ee4a` had the best baseline behavior, but it measured the entire loaded store before first paint
- the measured-core rewrite avoided that startup cost, but became too complex and produced blank/not-bottom/chat-switch failures
- the `tanstack` / `virtuoso` experiments did not remove the chat-specific anchor, prepend, and iOS behavior problems

This rewrite intentionally keeps:

- stable `ChatRow[]` modeling
- keyed anchors
- parent-owned loading policy

And discards:

- full-list measuring
- measured-core geometry
- per-row visible positioning from global offsets

## Verification Matrix

Every implementation pass must verify these scenarios on the heavy-history chat:

1. Initial open lands at bottom without a full-list hidden measurement phase.
2. Loading older history preserves the visible message anchor.
3. Parked-at-top does not trigger repeated older fetches.
4. Append while at bottom stays pinned.
5. Append while away from bottom does not yank the viewport.
6. Jump-to-message opens the target reliably.
7. Jump-to-message can recover back to bottom.
8. Switching away and back after loading older history never returns blank.
9. Normal chat re-entry reopens at bottom.
10. Composer height changes do not jitter the viewport.
11. Optimistic confirmation does not remount a message row.
12. Large thumb-drag / fling recenters instead of draining through intermediate windows.

## Debug Instrumentation

During development, keep debug logs behind `import.meta.env.DEV` for:

- first-ready time
- mounted row count
- staged batch count
- recenter count
- anchor restore count
- bottom distance after reopen

Useful additional diagnostics:

- staged batch row deltas with viewport-relative geometry (`topBefore`, `bottomBefore`, `topAfter`, `bottomAfter`)
- exact preserve contribution per changed row
- anchor drift after staged batch commit
- explicit logs for preload trigger, recenter trigger, prepend detect, prepend compensation, and layout anchor restore

Remove or keep them DEV-only before final cleanup.
