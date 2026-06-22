# Review: PWA store/slice & test changes — branch `crsh/DevMode` vs `main`

Scope: message forwarding store tracking, thread/reaction handling for deleted
messages, store tests for forwarding & threads, and i18n strings.
Repo: `/home/yiyan/文档/wetty-chat` (PWA frontend `wetty-chat-mobile`).

Diff command: `git -C /home/yiyan/文档/wetty-chat diff main...HEAD -- <path>`
Files reviewed: `store/messages/slice.ts`, `store/messages/slice.test.ts`,
`store/messages/storeIntegration.test.ts`, `store/threadsSlice.ts`,
`store/threadsSlice.test.ts`, `pages/conversation/hooks/useChatMessageSender.ts`,
`pages/conversation/hooks/useChatMessageSender.dom.test.tsx`,
`pages/conversation/hooks/useConversationTimeline.dom.test.tsx`,
`utils/formatTime.ts`, `locales/{en,zh-CN,zh-TW}/messages.po`.

---

## Test-run evidence

- `npx vitest run --project unit` (branch): **128 passed / 0 failed**. All
  in-scope unit tests (`slice.test.ts`, `storeIntegration.test.ts`,
  `threadsSlice.test.ts`, `ForwardedLabel.test.tsx`) pass.
- `npm test` full suite (branch): 36 failed / 79 passed.
- `npm test` full suite on `main` (verified via a throwaway worktree):
  **identical 36 failed / 79 passed**. → No test regression introduced by this
  branch.

Note on the 36 dom failures: they are a **pre-existing environment breakage**,
not caused by this branch. Under the current Node/happy-dom combo,
`globalThis.localStorage` is undefined, so the shared `afterEach` in
`src/test/domSetup.ts:33` (`localStorage.clear();`) throws and fails every
`*.dom.test.tsx` regardless of assertion correctness (Node prints
`ExperimentalWarning: localStorage is not available because --localstorage-file
was not provided`). This blocks local validation of the two in-scope dom test
files; their assertions were inspected by reading the code and the diffs.

---

## FUNCTIONALITY REVIEW

### Correct: forwardedFrom preservation in insertion paths

`store/messages/slice.ts` carries `forwardedFrom` through untouched on the
insert paths (`messageAdded` → `applyRealtimeMessage`/`insertServerMessageIntoLatest`,
and `refreshLatest`). `forwardedFrom` is just a field on `MessageResponse`, so no
merge logic is needed for inserts. Tests `slice.test.ts:487` ("preserves
forwardedFrom when message is added via messageAdded") and `:512` ("preserves
forwardedFrom when message is loaded via refreshLatest") assert the field
survives with correct `sender.name` / `originalChatId`. Meaningful, not
tautological.

### Correct: thread-root placeholder vs. removal on delete

`slice.ts:281-299` (`messagePatched`, delete branch) correctly distinguishes:

- thread root with `threadInfo` (object or carried from existing) → kept as a
  deleted placeholder so the thread stays reachable;
- thread root with explicit server `threadInfo: null` → removed;
- plain message (no `threadInfo`) → removed.
The `!== undefined` check (vs. the old `??`) is the right fix so server `null`
is respected. Covered by `slice.test.ts:382/411/436` and the multi-step
`storeIntegration.test.ts:164` (replies all deleted → `updateThreadReplyCount`
removes `threadInfo` → follow-up `messagePatched` removes root).

### Correct: threadsSlice replyCount===0 cleanup

`threadsSlice.ts:90-96` removes the thread from `items`, flips
`subscriptionByThreadId` to `false`, and `delete`s the archived entry. Null-safe
(runs only when `idx >= 0`). Test `threadsSlice.test.ts:127` ("updateThreadFromWs
removes thread when replyCount is 0") asserts all three effects. Good coverage.

### Correct: useChatMessageSender forwarding preview

`useChatMessageSender.ts:62` adds `forwardedFromName: replyingTo.forwardedFrom?.sender.name`
to `buildReplyPreview`, matching the `MessagePreview.forwardedFromName` field
(`api/messages.ts:37`) consumed by `ComposeContextBanner.tsx:49` and
`StickerBubble.tsx:97`. Optional chaining guards the missing-`forwardedFrom` case.

---

### Finding F1 — `messagePatched` non-delete refactor clobbers `reactions` / `replyToMessage`; `??` fallbacks are now dead code

**Severity**: Medium (latent behavior change + misleading dead code)
**Location**: `store/messages/slice.ts:300-308`

The branch changed the non-delete patch path from a single spread-assign to
in-place `Object.assign`:

```ts
// Mutate the Immer draft directly instead of assigning a new object.
// Spread + assign wraps null in a Proxy, breaking threadInfo clearing.
Object.assign(current, message);
current.replyToMessage = message.replyToMessage ?? current.replyToMessage;
current.reactions = message.reactions ?? current.reactions;
if (message.threadInfo !== undefined) current.threadInfo = message.threadInfo;
```

`Object.assign(current, message)` overwrites `current.replyToMessage` and
`current.reactions` **in place** before the `?? current.X` fallbacks read them,
so the fallbacks can never restore the original value — `message.X ?? current.X`
evaluates to `message.X ?? message.X`. Verified with node:

```
Case B (patch carries reactions:null, replyToMessage:null):
  NEW code  -> {"reactions":null,"replyTo":null}        // clobbered
  OLD spread-> {"reactions":[{"emoji":"thumbs-up"}],"replyTo":{"id":"9"}} // preserved
```

Behaviour change: a non-delete `messagePatched` whose payload explicitly carries
`reactions: null` (or `replyToMessage: null`) as an own property now wipes the
existing value, where the old spread+`??` code preserved it. The threadInfo fix
itself is correct (server `null` should clear), but the same clobber applies to
`forwardedFrom` (not in the fallback list at all) and the `??` lines are dead.
No test exercises a patch carrying `null` for these fields, so this is silent.

**Suggestion**: capture the original values before `Object.assign`, or revert to
the spread form and only special-case `threadInfo`:

```ts
const prevReplyTo = current.replyToMessage;
const prevReactions = current.reactions;
Object.assign(current, message);
current.replyToMessage = message.replyToMessage ?? prevReplyTo;
current.reactions = message.reactions ?? prevReactions;
if (message.threadInfo !== undefined) current.threadInfo = message.threadInfo;
```

### Finding F2 — Misleading comment misdiagnoses the threadInfo bug

**Severity**: Low
**Location**: `store/messages/slice.ts:303-304`

```ts
// Mutate the Immer draft directly instead of assigning a new object.
// Spread + assign wraps null in a Proxy, breaking threadInfo clearing.
```

The actual reason the old code did not clear `threadInfo` on server `null` was
the `??` operator (`null ?? current.threadInfo` → `current.threadInfo`), not an
Immer Proxy wrapping `null`. The comment will mislead the next maintainer and
make F1 harder to spot. Suggestion: replace with the real rationale, e.g.
"Use `!== undefined` (not `??`) so an explicit server `thread_info: null` clears
the field instead of falling back to the stale local value."

### Finding F3 — Forwarding has no optimistic update / rollback (by design, but untested + no dedup assertion)

**Severity**: Low
**Location**: `components/chat/messages/ForwardMessageModal.tsx:113-133`

`handleSelect` calls `forwardMessage(...)` (`POST /chats/{target}/messages/{id}/forward`),
shows a toast on success, and only shows a toast on failure. There is no
optimistic `messageAdded` dispatch and therefore nothing to roll back — the
forwarded message is expected to arrive via WS echo. This is a reasonable design
for forwarding into another chat, but:

- the `clientGeneratedId` (`cg_${Date.now()}_${Math.random()...}`) is sent for
  server-side dedup, yet no test asserts dedup behaviour against a WS echo with
  the same id; and
- the store tests (`slice.test.ts:487/512`) only cover insertion-path
  `forwardedFrom` preservation. They do **not** cover: forwarding into a thread
  (`forwardedFrom` + `replyRootId`), forwarding an already-forwarded message,
  a deleted original sender, or `forwardedFrom` survival through `messagePatched`
  (edit). The patch path is exactly where F1 could drop `forwardedFrom`.

Suggestion: add a slice test dispatching `messagePatched` on a forwarded message
to lock in `forwardedFrom` preservation through edits.

### Finding F4 — "1 replies" lacks plural form

**Severity**: Low
**Location**: `components/chat/messages/ForwardMessageModal.tsx:216` →
`locales/{en,zh-CN,zh-TW}/messages.po` `msgid "{0} replies"`

```ts
{t`${thread.replyCount} replies`}
```

Uses a plain `t` template, so `replyCount === 1` renders "1 replies". The msgid
is new on this branch. Suggestion: use lingui's `plural` macro (or accept the
minor grammar slip) for correct singular/plural.

### Finding F5 — `formatTime` has no invalid-input guard

**Severity**: Low
**Location**: `utils/formatTime.ts:4-7`

```ts
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
```

`new Date(iso)` for a non-ISO / empty / `undefined` input yields an Invalid Date
and `toLocaleTimeString` returns the literal `"Invalid Date"`. Current callers
mostly guard (`InviteMessageCard.tsx:130` does `timestamp && formatTime(timestamp)`),
but `ChatBubbleBase.tsx:449/478` and `StickerBubble.tsx:117` pass `timestamp`
straight through. A defensive `Number.isNaN(d.getTime()) ? '' : ...` would avoid
"Invalid Date" leaking into the UI. (Note: the numeric edge cases 0 / negative /
NaN from the task brief don't really apply — the param is an ISO string, not a
number.)

### i18n sync — Correct

All three `.po` files are in sync:

- 470 `msgid` entries each, identical sets (`diff` rc=0 for en↔zh-CN and en↔zh-TW).
- 4 `msgctxt` context entries each, identical (`sticker pack`,
  `settings: reorder action label for heart`, `bookmark a message`,
  `settings: reorder action label for bookmark`).
- No empty `msgstr` in zh-CN/zh-TW (no untranslated new strings).
- New forwarding/thread strings present and translated in all three:
  `Forward`, `Forward to`, `Forwarded from {0}`, `Message forwarded`,
  `Failed to forward message`, `No chats available`, `Search chats`,
  `{0} replies`. The `Reactions` msgid was relocated (not removed) and remains
  in all three.

### Test quality summary

- `slice.test.ts`, `storeIntegration.test.ts`, `threadsSlice.test.ts`: strong —
  assert real behaviour (placeholder retention, null-threadInfo removal, empty
  segment cleanup, reply-preview `isDeleted` propagation, replyCount===0 thread
  removal). Not tautological. Minor: `threadInfo: null as any` type-escape in a
  few tests (test-only, acceptable).
- `useChatMessageSender.dom.test.tsx` new thread-send / auto-subscribe tests:
  meaningful, but could not be executed locally due to the dom env breakage
  (see Test-run evidence). Logic reads correct.
- `useConversationTimeline.dom.test.tsx`: only 2 assertion updates to match the
  new scroll API (`align: 'top'`, extra `scrollToMessageId` args) — correct
  updates, also blocked from local execution by the env issue.
- Gaps: no forwarding-into-thread / chained-forward / deleted-sender / edit-
  preservation tests (see F3).

---

## MAINTAINABILITY REVIEW (per skill checklist)

### 1. Dead / Compatibility-Only Code

**Severity**: Medium (linked to F1)
**Location**: `store/messages/slice.ts:306-307`
The `?? current.X` fallbacks are dead code (see F1). Either restore their
effect or remove them and document the new "patch wins, including null" semantics
explicitly.

### 2. Duplicate / Redundant Code

**Severity**: Low
**Location**: `pages/conversation/hooks/useChatMessageSender.ts:240-282`, `335-370`, `425-462`
The `sendPromise.then(confirm…).catch(rollback).finally(revoke)` block is
copy-pasted across the `text`, `sticker`, and `audio` branches. Pre-existing,
not introduced by this branch, but the branch added a 4th shared field
(`forwardedFromName`) to `buildReplyPreview` — a good time to extract a
`confirmSend(postResponse, optimistic, clientGeneratedId, scope)` helper.

### 3. Hard-Coded Values

**Severity**: Low
**Location**: `components/chat/messages/ForwardMessageModal.tsx:120`

```ts
clientGeneratedId: `cg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
```

Inline; fine for client dedup, but `generateClientId()` already exists in
`conversationUtils` (used by `useChatMessageSender`). Reusing it would keep id
generation consistent.

### 4. Magic Strings

**Severity**: Medium
**Location**: `store/messages/slice.ts:276, 327, 346`
The thread store-key prefix is matched three times:

```ts
if (storeKey !== baseChatId && !storeKey.startsWith(`${baseChatId}_thread_`)) continue;
```

`_thread_` is a domain concept repeated across `messagePatched`,
`messagesBulkDeleted`, and `reactionsUpdated`. Suggestion: extract a helper
`isChatOrThreadOf(storeKey, chatId)` or a `THREAD_KEY_PREFIX` constant so the
prefix can't drift between handlers.

### 5. Over-Complex Logic

**Severity**: Low
**Location**: `store/messages/slice.ts:288-289`

```ts
const newThreadInfo =
  existing && message.threadInfo !== undefined ? message.threadInfo : existing?.threadInfo;
```

Dense but adequately commented. Acceptable.

### 6. Unnecessary Comments

**Severity**: Low (linked to F2)
**Location**: `store/messages/slice.ts:303-304` — the "Proxy wraps null" comment
is inaccurate; rewrite per F2. The other new comments (slice.ts:282-283, 286-287;
threadsSlice.ts:90) are good "why" comments — keep.

### 7. Naming Quality

✅ No issues found. `updateThreadReplyCount`, `newThreadInfo`, `existing`,
`forwardedFromName` are accurate and specific.

### 8. Single Responsibility

✅ No issues found for the changed code. `messagePatched` is large but its
structure is pre-existing and the additions are cohesive with the reducer's
purpose.

### 9. Error Handling Consistency

✅ No issues found. `ForwardMessageModal` guards re-entry (`if (forwarding) return;`),
surfaces `err.message` with a typed fallback (`Failed to forward message`), and
always resets `forwarding` in `finally`. Consistent with `useChatMessageSender`.

### 10. Unnecessary Exposure

✅ No issues found. `updateThreadReplyCount` is exported and consumed
(`storeIntegration.test.ts`, WS wiring). `formatTime` is consumed by three
components.

### 11. Dependency Direction

✅ No issues found. `slice` imports only from lower-level modules
(`messageEvents`, `messageProjection`, `timelineAlgorithms`, `api/messages`
types). No cycles introduced.

---

## Summary

- No test regression vs `main` (identical pass/fail); all in-scope unit tests
  pass (128/0 unit project).
- The thread/deleted-message handling and `updateThreadReplyCount` logic is
  correct and well tested.
- i18n is fully in sync (470 msgids × 3 locales, no missing translations).
- **Top issue (F1, Medium)**: the `Object.assign` refactor in `messagePatched`
  silently changed patch-merge semantics and left dead `??` fallbacks; add a
  test for null-valued patch fields and capture originals before assign.
- Lower-severity items: misleading comment (F2), forwarding test gaps (F3),
  "1 replies" plural (F4), `formatTime` invalid-input guard (F5), `_thread_`
  magic string (§4), pre-existing dom env breakage that blocks local dom test
  validation (out of scope but worth fixing separately).
