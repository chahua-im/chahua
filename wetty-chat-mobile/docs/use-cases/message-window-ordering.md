# Message Window Ordering Use Cases

This note documents edge cases around the main chat timeline, history browsing, and live websocket delivery.

## Current Model

- Chat messages are held in Redux memory, not persisted to IndexedDB.
- Each chat has one or more message windows and one `activeWindowIndex`.
- The UI renders only the active window via `selectMessagesForChat`.
- `nextCursor` loads older messages above the active window.
- `prevCursor` loads newer messages below a centered or historical active window.
- Websocket and optimistic messages are inserted into the chronologically latest window.
- Server-confirmed messages are ordered primarily by numeric message id, with timestamp fallback for optimistic or non-numeric ids.

## User Cases

1. User is at the latest bottom and a websocket message arrives.
   Expected: the message appears at the bottom of the rendered window.

2. User scrolls up within the latest window and a websocket message arrives.
   Expected: the message is stored in the same window without forcing scroll; it appears when the user scrolls down.

3. User jumps to an older message, read boundary, pin, or permalink and a websocket message arrives.
   Expected: the user remains in the historical context. Risk: the live message is stored in the latest window but is invisible because the active window is older.

4. User is in a centered or historical window and fetches newer messages while websocket messages arrive.
   Risk: `appendMessages` appends fetched messages without sorting. If websocket inserted a newer row first, the rendered active window can become incorrectly ordered.

5. User fetches older messages while another event changes the chat generation.
   Risk: the in-flight older-history response is ignored, and the loading state can remain stuck if the early return path does not clear it.

6. User taps scroll-to-bottom from a historical window after live messages arrived.
   Expected: the UI returns to the latest window. Risk: latest refresh merging can keep unmatched live rows in a non-sorted order if the fetched page does not include them.

7. A websocket event arrives for a message already present in another window.
   Risk: global cross-window dedup skips adding it to the latest window, so switching to latest may still miss that row until refresh fills the gap.

8. User sends a message while browsing history.
   Current behavior: sending activates the latest window and fetches latest data, so the optimistic message becomes visible but the user loses historical context.

9. Optimistic message confirmation arrives from API and websocket in different order.
   Expected: `clientGeneratedId` reconciles the `cg_` row with the server id. Risk: missing or changed `clientGeneratedId` can leave duplicate logical rows.

10. Backend message ids do not match creation chronology.
    Risk: client rendering follows numeric id order for server messages, which can differ from `createdAt` order.
