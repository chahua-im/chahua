# Backend Review — branch `crsh/DevMode` vs `main`

Scope: backend only (migration, messages DTO/handler, chats/mod, reactions, invites, members, pins, models, schema, background, message_search, saved_messages, threads).

Validation run:

- `cd backend && cargo clippy` → `No issues found`, exit 0.
- `cargo build` → successful.
- No hard `DELETE FROM messages` anywhere in `backend/src` (soft-delete only) — verified via grep.

---

## PASS 1 — FUNCTIONALITY

### [Medium] Unused index on a high-volume table

**Location**: `backend/migrations/2026-06-17-025442-0000_add_message_forwarding/up.sql:4-6`
**Issue**: The migration adds

```sql
CREATE INDEX idx_messages_forwarded_from
    ON messages (forwarded_from_message_id)
    WHERE forwarded_from_message_id IS NOT NULL;
```

but **no read query filters on `forwarded_from_message_id`**. Every usage reads the column off an already-loaded `Message` row, then looks up the forwarded-from message **by primary key `id`** (`attach_metadata`: `m_dsl::id.eq_any(&fwd_message_ids)`, `mod.rs:847`; `forward_message`: `dsl::id.eq(message_id)`, `messages.rs:1195`). The FK `REFERENCES messages(id)` does **not** need this index either — PostgreSQL does not auto-index FKs, and FK enforcement only fires on hard delete of the referenced row, which never happens (messages are soft-deleted only). So the index adds write overhead to the highest-volume table (`messages`) with zero read benefit — exactly the situation `AGENTS.md` (Database & Index section) asks to highlight.
**Suggestion**: Drop the index unless a "list all forwards of message X" query is planned. If kept, add a code comment naming the query that will use it.

### [Medium] Forward-into-thread skips mention subscription

**Location**: `backend/src/handlers/chats/messages.rs:1254-1265` (`forward_message`) vs `messages.rs:812-824` (`post_thread_message`)
**Issue**: `post_thread_message` auto-subscribes mentioned users to the thread:

```rust
// Auto-subscribe mentioned users (unique to thread replies)
if let Some(ref text) = response.message {
    for mentioned_uid in extract_mention_uids(text) {
        if mentioned_uid != uid {
            crate::services::threads::ensure_thread_subscription(conn, chat_id, thread_id, mentioned_uid)?;
```

`forward_message` copies the original text verbatim (`message: original.message.clone()`, `messages.rs:1236`), so `@[uid:N]` tokens survive, but it never calls `extract_mention_uids` / `ensure_thread_subscription` for the thread path — it only calls `apply_thread_side_effects` (sender + root-author subscription). A mentioned user in a forwarded thread reply receives the push (via `side_effects.fire`, `messages.rs:1283`) but is **not subscribed** to the thread, so they miss subsequent `ThreadUpdate`s. Behaviour diverges from `post_thread_message` for the same logical event.
**Suggestion**: After `apply_thread_side_effects` in the thread branch, run the same mention-subscription loop as `post_thread_message`, or fold mention subscription into `apply_thread_side_effects` so both callers stay consistent.

### [Medium] Heavy broadcast on every thread-reply deletion

**Location**: `backend/src/handlers/chats/messages.rs:1121-1137` (`delete_message`)
**Issue**: Deleting a thread reply now broadcasts a **full `MessageUpdated(root_response)`** to **all** members:

```rust
let root_response = attach_metadata(conn, vec![root_msg], &state, uid)
    .await.into_iter().next().unwrap();
let ws_msg = std::sync::Arc::new(ServerWsMessage::MessageUpdated(root_response.clone()));
state.ws_registry.broadcast_to_uids(&member_uids, ws_msg);
```

plus `broadcast_thread_update_safely` (ThreadUpdate to subscribers). For a large chat (AGENTS.md targets 5k members), each thread-reply deletion now fans out a full message payload (reactions, attachments, sticker, forwarded-from, etc.) to every member. The bulk-delete path (`background.rs:292`) solves the same problem with the lighter `broadcast_thread_update_to_uids(&member_uids)` — so the two deletion paths are **inconsistent** and the single-delete path is the heavier one. The `ThreadUpdate` payload already carries `reply_count`/`last_reply_at`, which is the only root state that changes when a reply is deleted.
**Suggestion**: Replace the `MessageUpdated`-to-all block with `broadcast_thread_update_to_uids(conn, &state.ws_registry, &member_uids, chat_id, reply_root_id)` to match the bulk-delete pattern and shed the per-member full-message payload. Keep `MessageUpdated` only if clients genuinely need a fresh full root object (then document why).

### [Low] Fragile `.unwrap()` on `attach_metadata` result

**Location**: `backend/src/handlers/chats/messages.rs:1131` (new) and `:1106` (pre-existing)
**Issue**: `attach_metadata(conn, vec![root_msg], &state, uid).await.into_iter().next().unwrap();`. `send_prepared_message` handles the same shape safely with `.ok_or(AppError::Internal("Failed to build message response"))?` (`mod.rs:714` and `mod.rs:740`). The new code adds a second `unwrap`; if `attach_metadata` ever returns fewer items than inputs, this panics the request handler.
**Suggestion**: Use `.ok_or(AppError::Internal("…"))?` for consistency and panic-safety.

### [Low] TOCTOU: source + thread-root loaded outside the transaction

**Location**: `backend/src/handlers/chats/messages.rs:1193-1204` (original load) and `:1211-1212` (thread-root load), before `BEGIN` at `:1218`
**Issue**: `original` and `thread_root` are fetched before the transaction opens. A concurrent soft-delete of the original between the load and `BEGIN` means the forward proceeds with stale content and `forwarded_from_message_id` pointing at a now-`deleted_at`-set row; `attach_metadata` will still build `ForwardedFromInfo` from it. Low impact (content was visible to the forwarder at request time) but the invariant "forward only non-deleted originals" is not enforced transactionally.
**Suggestion**: Re-validate `original.deleted_at.is_null()` inside the transaction, or move the original load inside `BEGIN`.

### [Note] Idempotency check omits `forwarded_from_message_id`

**Location**: `backend/src/handlers/chats/mod.rs:805-813` (`validate_idempotent_message_payload`)
**Issue**: The duplicate-payload comparison checks chat, sender, message, type, sticker, reply_to, reply_root, attachments — but **not** `forwarded_from_message_id`. A forward retry with the same `client_generated_id` still matches (same payload in practice), so this is currently benign, but the contract is looser than the struct implies.
**Suggestion**: Add `&& existing.forwarded_from_message_id == prepared.forwarded_from_message_id` to make the idempotency check faithful to the full prepared payload.

### [Note] Thread-list previews never show `forwardedFromName`

**Location**: `backend/src/services/threads.rs:871` and `:912` (`enrich_thread_list`)
**Issue**: Both call sites pass `&HashMap::new()` as `fwd_messages_map`, so `build_message_preview` always yields `forwarded_from_name: None` in the thread list, whereas the main message list (`attach_metadata`) populates it. Minor inconsistency for a summary view; acceptable if intentional.

### ✅ Correct — functionality

- **Authorization**: `forward_message` calls `check_membership` for **both** source and target chats (`messages.rs:1189-1190`); cannot forward from/into a chat the user is not in.
- **Forwarding a forwarded message**: `let root_message_id = original.forwarded_from_message_id.unwrap_or(original.id);` (`messages.rs:1223`) stores the **root** id — no chain, no recursion. Text/attachments are cloned from the immediate `original`, which already carries the root's content. Consistent.
- **Type restrictions**: `validate_client_message_type(&original.message_type)` (`messages.rs:1208`) blocks `System`/`Invite` forwarding; `Text`/`Audio`/`File`/`Sticker` allowed.
- **Deleted originals blocked**: source load filters `deleted_at.is_null().and(is_published.eq(true))` (`messages.rs:1198-1199`).
- **Deleted-message / thread-reaction fix is coherent**:
  - `redact_deleted_message_response` keeps reactions only when `thread_info` is present (`mod.rs:461`), and `thread_info` is populated iff `has_thread` (`mod.rs:1177`). Deleted thread roots keep reactions; ordinary deleted messages clear them.
  - `get_reaction_details` allows `deleted_at.is_null().or(has_thread.eq(true))` (`reactions.rs:149-151`); `put_reaction` (`reactions.rs:238`) and `delete_reaction` (`reactions.rs:293`) still require non-deleted → reactions on deleted thread roots are **frozen** (viewable, not mutable). Sensible, consistent policy.
  - `recalculate_thread_meta` now resets `has_thread=false` when no active replies (`threads.rs:341-343`), and `build_thread_update_payload` dropped the `has_thread.eq(true)` filter (`threads.rs` diff) so a `ThreadUpdate` with `reply_count=0` is broadcast when the last reply is deleted — fixing the stale-count bug.
  - `load_thread_root_message` uses `.ok_or(...)` (no `None.unwrap`) and explicitly blocks creating new threads on deleted roots with no existing thread (`messages.rs:620-624`). No panic risk found in the new thread logic.
- **FK safety**: `forwarded_from_message_id … REFERENCES messages(id)` with default `NO ACTION` is safe because messages are only soft-deleted (rows persist); no hard `DELETE FROM messages` exists.
- **Migration**: `up.sql` adds a nullable column (NULL for existing rows, no backfill needed) + partial index; `down.sql` drops index then column — symmetric.
- **API serialization**: `ForwardedFromInfo`, `MessageResponse.forwarded_from`, `MessagePreview.forwarded_from_name` all under `#[serde(rename_all="camelCase")]`; DTOs live in `dto/messages.rs`. i64 fields use `serde_i64_string`. Compliant with AGENTS.md.
- **Transaction boundaries**: `forward_message` wraps attachment clone + `send_prepared_message` + thread side-effects in `BEGIN`/`COMMIT`/`ROLLBACK` (`messages.rs:1218-1300`); `delete_message` uses `conn.transaction(...)` (`messages.rs:1064`). Atomic.

---

## PASS 2 — MAINTAINABILITY

### [Medium] Duplicated per-iteration `sticker_emoji_map` construction

**Location**: `backend/src/handlers/chats/mod.rs:1104-1107` (reply_to preview) and `:1201-1205` (forwarded `original_reply_to` preview)
**Issue**: Both spots rebuild the identical `HashMap<i64, String>` from `sticker_rows` **inside** the per-message `for (idx, m) in messages_to_process …` loop (`mod.rs:1031`). The new forwarded-from code copies the existing suboptimal pattern, so a message-list page with N messages now rebuilds this map up to 2×N times. `sticker_rows` is loaded once before the loop (`mod.rs:876`), so a single hoisted map would serve both.
**Suggestion**: Hoist one `let sticker_emoji_map: HashMap<i64, String> = sticker_rows.iter().map(|(&id,(s,_))| (id, s.emoji.clone())).collect();` above the loop and pass `&sticker_emoji_map` to both `build_message_preview` calls; delete both inline rebuilds.

### [Medium] Over-complex inline `forwarded_from` closure

**Location**: `backend/src/handlers/chats/mod.rs:1194-1238`
**Issue**: The `forwarded_from` field is built by a 4–5-level nested closure (`and_then` → `and_then` → `map` → `Box::new(build_message_preview(...))`) that also rebuilds a sticker map inline. It is the single hardest-to-read block in the diff and mixes lookup, preview construction, and sticker-map assembly.
**Suggestion**: Extract a helper, e.g.

```rust
fn build_forwarded_from_info(
    fwd_msg_id: i64,
    fwd_messages_map: &HashMap<i64, Message>,
    fwd_reply_messages_map: &HashMap<i64, Message>,
    sticker_emoji_map: &HashMap<i64, String>,
    user_avatars: &HashMap<i32, _>,
    user_profiles: &HashMap<i32, _>,
) -> Option<ForwardedFromInfo> { … }
```

and call it from the struct literal. Mirrors the existing `build_message_preview` / `build_sender` extraction style.

### [Low] Error-handling inconsistency on `attach_metadata` results

**Location**: `messages.rs:1106` and `:1131` (`.unwrap()`) vs `mod.rs:714` / `mod.rs:740` (`.ok_or(AppError::Internal(...))?`)
**Issue**: Same operation, two strategies. The `unwrap` variant will panic on any future change that makes `attach_metadata` return fewer rows than inputs.
**Suggestion**: Standardise on `.ok_or(AppError::Internal("Failed to build message response"))?`.

### [Low] Redundant clones

**Location**: `backend/src/handlers/chats/messages.rs:1133` and `backend/src/handlers/chats/mod.rs:1150`/`:1154`
**Issue**: `root_response.clone()` (`messages.rs:1133`) is the last use of `root_response` — the clone is unnecessary; move it. `let msg_type = m.message_type;` then `message_type: msg_type.clone()` (`mod.rs:1150,1154`) — `MessageType` derives `Copy` (`models.rs:124`), so `.clone()` is redundant; `message_type: msg_type` suffices and `msg_type` remains valid for the later `if msg_type == MessageType::Sticker` check.
**Suggestion**: `let ws_msg = Arc::new(ServerWsMessage::MessageUpdated(root_response));` and `message_type: msg_type,`.

### [Low] Magic string `"Unknown"` / `"Unknown User"`

**Location**: `backend/src/handlers/chats/mod.rs:427` (`"Unknown"`) and `:507` (`"Unknown User"`)
**Issue**: Two different hard-coded fallback names for the same concept (unknown sender). The new forwarded-preview code at `:427` introduces another `"Unknown"` use.
**Suggestion**: Extract a single `const UNKNOWN_USER_NAME: &str = "Unknown";` and use it in both spots (or align the wording).

### ✅ No maintainability issues — items

- **Dead/compat code**: none found. `broadcast_thread_update_to_subscribers` is retained and now delegates to `broadcast_thread_update_to_uids` (`threads.rs:415-423`) — both still used.
- **Good extractions**: `load_thread_root_message`, `apply_thread_side_effects`, `broadcast_thread_update_safely` (`messages.rs:599-693`) properly de-duplicate logic between `post_thread_message` and `forward_message`. Net reduction in copy-paste.
- **Why-comments are justified**: the deleted-root invariant (`messages.rs:614-631`), "no chain resolution needed" (`:1221-1222`), and best-effort broadcast rationale (`:675-678`) explain non-obvious decisions; none merely restate code.
- **Naming**: `fwd_messages_map` / `fwd_reply_ids` / `fwd_msg_id` use the `fwd` abbreviation consistently; `ForwardedFromInfo`, `forwarded_from_message_id` are precise.
- **Single responsibility**: `forward_message` is long but mirrors `post_thread_message`'s shape (auth → validate → tx → side-effects → broadcast); acceptable.
- **Visibility**: `forward_message` is private, registered only via `router()` (`messages.rs:1310`); `broadcast_thread_update_to_uids` is `pub` and used cross-module. Correct minimum scope.
- **Dependency direction**: `handlers/chats` → `services/threads`, `services/background` → `services/threads`. No circular or reversed dependencies.

---

## Test coverage note

`backend/src/handlers/chats/messages.rs:1318` test module covers only `validate_client_message_type` and `search_*`. **No unit/integration test for `forward_message`, `clone_attachments_for_forward`, `apply_thread_side_effects`, or `load_thread_root_message`** was added. The `redact_deleted_message_response` test was correctly updated for the new "keep reactions on deleted thread roots" policy (`mod.rs:2322` asserts `reactions.len() == 1`). Recommend adding at least: forward into top-level chat, forward into thread, forward of an already-forwarded message (root-id preservation), and forwarding from a chat the user is not a member of (expect 403).

---

## Conflict note

Task instructions asked to update `progress.md`, but also said "Do NOT make any edits." Per review-only/no-edit precedence, `progress.md` was not modified. Only this review artifact (`review-backend.md`) was written as the required deliverable.
