# Forwarded messages

Backend design and decisions, updated 2026-09-28. Flutter/PWA presentation is outside this backend change.

## Contract

- Forward 1–100 distinct published, nondeleted messages from one source chat into one destination chat.
- Sources are ordered by message ID, not request-array order. System and invite messages are excluded.
- Require `clientGeneratedId` alongside `sourceChatId` and `messageIds`.
- Repeating a successful operation with the same authenticated sender, destination and canonical source selection returns the original message. Reusing its key for different content returns `409`.
- Retries do not rebuild snapshots, insert another bundle, advance read state again, or repeat delivery effects.
- Forwarding creates a top-level message. Destination threads, captions, and reply targets are not supported.
- Source membership and normal destination send authorization apply to creation. Blocked/unfriended DMs cannot receive forwards.
- Each bundle is immutable. Message rows and saved-message rows hold bundle foreign keys.
- A flat bundle may be included by reference in a new bundle. A bundle already containing children cannot itself be nested again.

## Creation and retry flow

```mermaid
sequenceDiagram
    participant C as Client
    participant H as Forward handler
    participant DB as PostgreSQL
    participant S as Message services
    participant W as WebSocket and push
    C->>H: Forward selection with clientGeneratedId
    H->>DB: Authorize destination send, including retries
    H->>DB: Begin transaction and lock operation key
    H->>DB: Find existing message by client key
    alt Existing operation
        H->>H: Verify sender, destination and canonical source selection
        H->>S: Hydrate original message
        H->>DB: Commit
        H-->>C: Original message or conflict
    else New operation
        H->>DB: Check source membership
        H->>DB: Read published source rows and metadata
        H->>S: Build durable snapshots and bundle-local replies
        H->>DB: Insert bundle and destination wrapper
        H->>DB: Advance destination read position and commit
        H->>W: Fire deferred delivery once
        H-->>C: Message with bundle ID and preview
    end
```

A transaction-scoped operation lock serializes concurrent requests using the same retry key. Existing-message uniqueness remains enforced by the database. The operation-key lock is not a source-content lock.
Retries still require destination send authorization, but do not require the source message to remain visible or source membership to remain present. Conflict paths roll back the transaction.

**Accepted tradeoff:** source text and dependent metadata are read separately at ordinary database isolation. Concurrent editing can yield a mixed-version capture. No source locking or repeatable-read redesign is included, per the explicit product decision.

## Durable snapshots and hydration

```mermaid
flowchart TD
    M[Forwarded message] -->|FK| B[Immutable bundle]
    SAV[Saved message owned by user] -->|FK| B
    B --> P[Full payload JSONB]
    B --> V[First-three preview JSONB]
    B --> IDS[Direct child IDs]
    P --> MSG[Captured message content]
    P --> REF[Existing flat bundle reference]
    REF --> CHILD[Child bundle]
    MSG --> A[Attachment storage keys and captured metadata]
    MSG --> ST[Sticker ID, media ID, storage key and captured metadata]
    A --> H[Request-time hydration]
    ST --> H
    USER[Requesting user favorite state] --> H
    CFG[Current media URL configuration] --> H
    H --> RESPONSE[User-specific response]
```

Stored sticker data is not a `MessageStickerResponse`. Public URLs and `isFavorited` are response data, not historical content. At read time:

1. Generate media URLs from stored object keys and current media configuration.
2. Batch-load favorite sticker IDs for the requesting user, not the original sender or forwarder.
3. Hydrate sender and mention profiles by UID.
4. Resolve internal reply previews from the same bundle's captured items.

This applies to both chat and saved-forward detail endpoints. Captured sticker metadata preserves the forwarded content without requiring a live sticker row to reconstruct it. Reply previews use the same captured content rather than fetching the original source message again.

Timeline hydration reads only preview JSON/count/child IDs in a batched query. Full payloads are loaded on explicit detail requests. Preview size is bounded by item count (three), not by serialized byte count.

## Reply contract

```mermaid
flowchart TD
    SOURCE[Source reply target] --> HAS{Has a reply?}
    HAS -->|No| NONE[No reply metadata]
    HAS -->|Yes| IN{Target selected in same immediate bundle?}
    IN -->|No| REDACT[Store redacted marker only]
    IN -->|Yes| LINK[Store bundle-local original message ID reference]
    LINK --> TARGET[Find target in captured payload]
    TARGET --> PREVIEW[Return structured target preview]
    REDACT --> LABEL[Client renders localized redacted label]
    PREVIEW --> CLIENT[Client renders preview and supports jump to target]
```

- **No reply:** no reply metadata.
- **Internal:** retain a reference to a selected item in the same immediate bundle; return a structured preview derived from that target snapshot. The client renders the preview and can locate the target within the bundle.
- **External:** retain only a redacted marker. Do not store or return target IDs, text, sender identity, or mentions. The client displays localized `[redacted]`.
- Do not resolve references across child bundles or use the source chat as a fallback.
- Snapshotting an existing forwarded wrapper uses the same selection boundary; child bundles keep their own already-captured reply boundaries.

The backend supplies structured data, not HTML or a pre-rendered localized string.

## Authorization and saved access

| Read path | Authority |
|---|---|
| Chat root details | Current chat membership plus live, published forwarded wrapper in that chat |
| Chat child details | Same root checks, then root ID or direct child ID must match |
| Saved root details | Saved row selected by both saved ID and authenticated UID |
| Saved child details | Same saved ownership check, then root ID or direct child ID must match |

Knowing a bundle ID alone is not authorization. Saved details intentionally survive original-message deletion and loss of source-chat membership. The saved owner is also the hydration viewer, so sticker favorite state is adapted to that user.

Routes, relative to the API mount:

- `POST /chats/{chat_id}/messages/forward`
- `GET /chats/{chat_id}/messages/{message_id}/forwarded-messages`
- `GET /chats/{chat_id}/messages/{message_id}/forwarded-bundles/{bundle_id}/messages`
- `PUT /saved-messages/{message_id}`
- `GET /saved-messages/{saved_message_id}/forwarded-messages`
- `GET /saved-messages/{saved_message_id}/forwarded-bundles/{bundle_id}/messages`

IDs are serialized as strings. Detail totals count immediate items, not recursively expanded leaves.

## Migration and local-development reset

Nothing in this feature has been deployed. The intermediate forwarding migrations are replaced by one final-schema migration:

`backend/migrations/2026-09-23-000001-0000_add_forwarded_bundles`

It adds the forwarded enum value, bundle table (including child IDs and preview), message bundle reference, and saved-message bundle reference. There is no temporary inline-payload column, conversion/backfill, or deployed-data compatibility path.

**Local databases that applied the old migrations are not automatically upgraded.** Before switching history, back up any valuable local data and revert the old feature migrations using the old checkout, or recreate a disposable development database. Do not merely remove entries from Diesel's migration ledger: the physical schema must match. Rollback retains the unused PostgreSQL enum value, as PostgreSQL does not support dropping an enum value in place.

History cleanup preserves the original feature author separately from integration and subsequent correctness work. Backup branches retain the pre-rewrite history. No remote force-push is part of this change.

## Remaining product limitations

- No forwarding directly from a saved item after source access is lost.
- No selecting individual embedded items without access to their original messages.
- No recursive re-forwarding of already-nested bundles.
- Search indexes text messages, not forwarded snapshots.
- Deleting source content does not recall existing forwarded/saved copies.
- Child references are application-maintained arrays, not foreign keys. Future garbage collection must trace message/saved roots and child edges, including media referenced in snapshots.
- Ordinary source deletion soft-deletes rows; it does not currently delete retained object-storage media.

## Verification targets

- Concurrent same-key requests create one bundle and wrapper; retry after source deletion returns the same result.
- Changed selection or destination with the same key returns `409`.
- External replies expose no target identity/content; internal replies use captured target content.
- Sticker snapshot JSON contains object keys and IDs, not URL/favorite state.
- Two viewers receive their respective favorite state for the same saved/chat bundle.
- New media URL configuration affects existing snapshot response URLs.
- Saved root/child reads reject another owner's saved ID and unrelated child IDs.
- Consolidated migration runs on a clean PostgreSQL database and supports rollback/reapply.

### Executed checks

- `cargo test --locked`: 253 tests passed.
- `cargo clippy --locked --all-targets -- -D warnings`: passed.
- `cargo build --locked`: passed.
- Disposable PostgreSQL 17: all migrations applied; final forwarding migration rolled back and reapplied successfully.
- Live authenticated API: four concurrent forwards returned one persisted message/bundle; changed selection/destination returned `409`; retry after deleting source rows and removing source membership returned the original ID.
- Live chat/saved details: internal preview and external redaction, per-viewer sticker favorites, saved-owner rejection, nested child access after chat departure/root soft deletion, and unrelated-child rejection all passed.
- Restarting the isolated API with a new media base URL changed URLs for previously saved sticker snapshots.

Migration schema generation reports the existing Diesel distinction between `Array<Int8>` and generated `Array<Nullable<Int8>>` for `child_bundle_ids`; migration execution/rollback was checked independently using a migration-only config. No local development or shared database was migrated.
