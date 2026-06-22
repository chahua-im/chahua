# Progress

## Status

Review complete. Findings in `review-advanced-settings.md`. No code edited (review-only).

## Tasks

- [x] Review PWA advanced-settings (branch crsh/DevMode vs main) — functionality + maintainability
- [x] Review PWA store/slice & test changes (branch crsh/DevMode vs main) — forwarding, thread/reaction handling, store tests, i18n — functionality + maintainability

## Files Changed

- `review-advanced-settings.md` (created) — full review
- `review-store-tests.md` (created) — full functionality + maintainability review
- `progress.md` (this file)

## Notes

- Scope: advancedSettingsStore, settings pages, PresetSlider, AppVersionItem, layouts, main, features, ConversationOverlayHost + consumers (ChatBubble, ChatMessageRow, MessageOverlay, useMessageOverlayActions, overlayActionPolicy, conversation.tsx, db.ts).
- Top blockers: (1) `forward` missing from `ADVANCED_DEFAULTS.actionOrder` → wrong default action order for all users; (2) `npm run verify` FAILS — stale `useMessageOverlayActions` order test (branch regression) + pre-existing `domSetup.ts` localStorage failures.
- Other: lock redirect doesn't cover sub-pages; stored order not reconciled w/ canonical keys (forward-compat gap); no `advancedSettings` feature flag (routes ungated); duplicate hardcoded action-key list (root cause).
- Verified: IDB write-queue serialization, lock race benign, useSyncExternalStore snapshot stability, wiring of long-press delay / menu opacity / hide-avatar / action order to overlay.
- Commands run: `git diff main...HEAD`, `npm run verify` (FAIL), `npx vitest run` for overlayActionPolicy.test (PASS 16/16) + useMessageOverlayActions.dom.test (FAIL 5/5).
- Store/tests review scope: store/messages/slice.ts (+test), storeIntegration.test.ts, threadsSlice.ts (+test), useChatMessageSender.ts (+dom test), useConversationTimeline.dom.test.tsx, utils/formatTime.ts, locales/{en,zh-CN,zh-TW}/messages.po, ForwardMessageModal.tsx (forwarding send path).
- Top issue (F1, Medium): `messagePatched` non-delete path switched spread→`Object.assign(current, message)`, which clobbers `current.reactions`/`replyToMessage` in place BEFORE the `?? current.X` fallbacks run → fallbacks are dead code; patch carrying `reactions:null`/`replyToMessage:null` now wipes values (old spread preserved them). threadInfo fix is correct; suggested fix = capture originals before assign. Verified w/ node snippet. No test covers null-valued patch fields.
- Correct: forwardedFrom preserved on insert paths (messageAdded/refreshLatest, tested); thread-root placeholder-vs-remove logic + `!== undefined` for server null; threadsSlice replyCount===0 cleanup (null-safe); useChatMessageSender forwardedFromName preview; `updateThreadReplyCount` reducer.
- i18n: all 3 .po in sync — 470 msgids each (diff rc=0), 4 msgctxt each, no empty msgstr in zh-CN/zh-TW. New forwarding strings present/translated. Minor: `{0} replies` uses plain `t` → "1 replies" (no plural).
- Tests: unit project PASS 128/0 (in-scope slice/storeIntegration/threadsSlice/ForwardedLabel all green). Full `npm test` = 36 fail/79 pass = IDENTICAL to main (verified via worktree) → no regression. Dom failures are pre-existing env breakage: `domSetup.ts:33 localStorage.clear()` throws (happy-dom localStorage undefined under Node 22) → fails all *.dom.test.tsx on both main & branch.
- Lower-sev: misleading "Proxy wraps null" comment (F2); forwarding test gaps (into-thread/chained/deleted-sender/edit-preservation, F3); formatTime no Invalid-Date guard (F5); `_thread_` magic string x3 in slice (§4); pre-existing send-confirm block dup across text/sticker/audio (§2).
- Commands run: `git diff main...HEAD`, `npx vitest run --project unit` (PASS 128/0), `npm test` branch (36f/79p), `npm test` main worktree (36f/79p), node snippet for Object.assign semantics, .po msgid/msgctxt/empty-msgstr diffs. No code edited (review-only).
