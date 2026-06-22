# Review: PWA Advanced Settings (branch `crsh/DevMode` vs `main`)

Scope: advanced settings easter egg, long-press delay, menu bg opacity, hide-avatar toggle, action-order drag-reorder, and the backing `advancedSettingsStore`.

Method: full file reads of all in-scope files + consumers (`ChatBubble`, `ChatMessageRow`, `MessageOverlay`, `useMessageOverlayActions`, `overlayActionPolicy`, `conversation.tsx`, `db.ts`), plus `git diff main...HEAD` and `npm run verify`.

> Caveman-mode review text. Technical substance intact.

---

## Pass 1 — FUNCTIONALITY

### Correct (verified)

- **IDB write serialization**: `enqueueIdbWrite` chains writes (`advancedSettingsStore.ts:157-163`); rejections are logged, not thrown. Rapid slider drags coalesce because the queued callback reads live `settingsCache` at run time, not at enqueue time. Good.
- **Lock race is benign**: `lockAdvancedSettings` resets `settingsCache = { ...ADVANCED_DEFAULTS }` synchronously *before* its `await` (`advancedSettingsStore.ts:134-136`), so any pending queued `kvSet(SETTINGS_KEY, settingsCache)` writes defaults, not stale custom values.
- **`useSyncExternalStore` snapshots are referentially stable**: `getActionOrderSnapshot` returns `settingsCache.actionOrder`; non-actionOrder `setSetting` calls spread into a new `settingsCache` but preserve the same `actionOrder` array ref → no infinite re-render loop. Primitive snapshots bail via `Object.is`.
- **Action order is wired to the overlay**: `useMessageOverlayActions` calls `useActionOrder()` (`useMessageOverlayActions.ts:63`) → `getOverlayActionPolicy(input, actionOrder)` sorts (`overlayActionPolicy.ts:86-92`) → passed to `ConversationOverlayHost` (`conversation.tsx:549`). Reorder applies. ✔
- **Long-press delay wired**: `ChatBubble.tsx:121` `setTimeout(..., getLongPressDelayMs())`. Units ms, correct. ✔
- **Menu opacity wired**: `MessageOverlay.tsx:106` `useMenuBgOpacity()` → `'--menu-bg-opacity': \`${menuBgOpacity}%\``(`:459`) → consumed in`MessageOverlay.module.scss:44,49,205`. ✔
- **Hide-avatar applied in main + thread timelines**: `ChatMessageRow.tsx:50,59,73` sets `hideAvatarColumn: shouldHideOwn ? true : undefined`; thread view reuses `ConversationPage`/`ChatMessageRow`. ✔

---

### High — `forward` action missing from default stored order → wrong position for ALL users

**Location**: `advancedSettingsStore.ts:26-37` vs `constants/overlayAction.ts:33-45`

`ADVANCED_DEFAULTS.actionOrder` omits `'forward'`:

```ts
actionOrder: ['reply','thread','pin','copy','edit','save','favorite','copy-link','delete','reaction-details'] as OverlayActionKey[],
```

but canonical `DEFAULT_ACTION_ORDER` (overlayAction.ts:33-49) includes it at index 1.

`useMessageOverlayActions` always calls `useActionOrder()`, which returns `ADVANCED_DEFAULTS.actionOrder` from first boot — even for users who never unlock advanced settings. `getOverlayActionPolicy` then sorts with `actionOrder.indexOf(a.key)`, and `forward` resolves to `-1 → 999` (`overlayActionPolicy.ts:88-90`), so **Forward is forced to the last slot for every user**, diverging from the legacy build-order position (5th) and the canonical default (2nd).

Side effects:

- The action-order settings page (`action-order.tsx:67`) maps only `actionOrder`, so **Forward is invisible / not reorderable** until the user taps *Reset* — which uses `DEFAULT_ACTION_ORDER` (forward at index 1). So Reset silently jumps Forward from last → 2nd. Surprising, inconsistent.
- Three divergent "default" orderings now exist: policy build-order, `DEFAULT_ACTION_ORDER`, and `ADVANCED_DEFAULTS.actionOrder`.

**Suggestion**: derive the store default from the single source of truth:

```ts
import { DEFAULT_ACTION_ORDER } from '@/constants/overlayAction';
// ...
actionOrder: [...DEFAULT_ACTION_ORDER] as OverlayActionKey[],
```

---

### High — `npm run verify` FAILS (branch regression)

**Location**: `src/pages/conversation/hooks/useMessageOverlayActions.dom.test.tsx:191`

`npm run verify` is red. One failure is directly caused by this branch:

```
useMessageOverlayActions > builds the current admin-owned text action order
AssertionError: expected [ 'reply','thread','pin','…(6)' ] to deeply equal [ 'reply','thread','pin','…(5)' ]
- Expected:  ['reply','thread','pin','copy','edit','save','copy-link','delete']
+ Received:  ['reply','thread','pin','copy','edit','save','copy-link','delete','forward']
```

The test's expected array is stale (written before `forward` existed on main; `forward` + `messageForward` flag were added on this branch in commit `8622548e`). The `+8` lines added on this branch wired `onForward` into the *other* test ("binds copy, reply…") but did not update this assertion. Received has `forward` last — a direct consequence of the High finding above.

**Note (pre-existing, not this branch)**: all `|dom|` tests also fail in setup/teardown with `TypeError: Cannot read properties of undefined (reading 'clear')` at `src/test/domSetup.ts:33` (`localStorage.clear()`). `domSetup.ts` is unchanged on this branch and exists on `main`, so this is a pre-existing jsdom env issue affecting `useMessageReactions` / `useThreadSubscription` / other dom tests. Flagged because the convention "npm run verify passes" is currently unmet regardless of cause.

**Suggestion**: update the stale assertion to include `forward` at its intended default position (after fixing `ADVANCED_DEFAULTS`). Separately, fix `domSetup.ts` localStorage availability so dom tests run.

---

### Medium — Lock redirect is incomplete; sub-pages bypassable when locked

**Location**: `advanced.tsx:164-168`, `DesktopSplitLayout.tsx:369-376`

Both guards only cover the exact `/settings/advanced` route:

```ts
// advanced.tsx (mobile)
useEffect(() => { if (!unlocked) history.replace('/settings'); }, [unlocked, history]);
// DesktopSplitLayout.tsx
useEffect(() => { if (!advancedUnlocked && currentRoute.advancedSettings) history.replace(...); }, [...]);
```

The sub-pages — `long-press-delay`, `menu-bg-opacity`, `action-order` — have **no unlocked guard** (`LongPressDelayPage`/`MenuBgOpacityPage`/`ActionOrderPage` just render their `Core`). On mobile the routes are registered unconditionally (`MobileLayout.tsx:108-110`); on desktop the modal renders the matching `Core` for `currentRoute.longPressDelay`/`menuBgOpacity`/`actionOrder` with no check. A locked user deep-linking to `/settings/advanced/long-press-delay` reaches the setting. The lock only protects the main page (which holds the JWT-copy item).

**Suggestion**: either guard each sub-page (`if (!unlocked) return null/redirect`), or extend the redirect effect to fire for the whole `advancedSettings || longPressDelay || menuBgOpacity || actionOrder` family.

---

### Medium — Forward-compat gap: stored order not reconciled with canonical keys

**Location**: `advancedSettingsStore.ts:110-112` (hydration), `action-order.tsx:67` (reorder list)

```ts
if (storedSettings) { settingsCache = { ...ADVANCED_DEFAULTS, ...storedSettings }; }
```

`storedSettings.actionOrder` fully replaces defaults — new canonical keys added in a future version never appear in a returning user's `actionOrder`. Consequences:

- Reorder list renders only `actionOrder` entries → newly-added actions are **invisible & not reorderable** until the user taps Reset.
- Unknown/stale keys persisted in IDB are not filtered: `ACTION_ICONS[key]`/`labels[key]` would render `undefined` icon and the raw key string.
- No clamping/validation of numeric fields on hydration (a corrupt `menuBgOpacity: 200` or `longPressDelayMs: -5` loads as-is).

**Suggestion**: on hydration, reconcile `actionOrder` to the union of stored + `DEFAULT_ACTION_ORDER` (append missing canonical keys, drop unknowns), and clamp numerics to their min/max.

---

### Low — `setLongPressDelayMs` does not clamp

**Location**: `advancedSettingsStore.ts:181-183` vs `:195-198`

`setMenuBgOpacity` clamps (`Math.max(MIN, Math.min(MAX, opacity))`); `setLongPressDelayMs` does not, relying solely on the slider's `min/max`. A future caller or a preset change could set out-of-range. `LONG_PRESS_CUSTOM_MIN=5` is also an extremely hair-trigger value (any touch fires the overlay before a swipe can be distinguished). Defensive clamp + raise floor recommended.

### Low — Easter-egg toggle races on rapid taps (>5)

**Location**: `AppVersionItem.tsx:43-62`

Each click is a separate async `handleVersionClick`. `unlockAdvancedSettings` sets `unlockedCache=true` synchronously before its `await`, so a 6th tap during the in-flight toggle reads `isAdvancedSettingsUnlocked() === true` and toggles back to locked. Mashing the version 6+ times can end locked. Add an in-flight guard (ignore taps while a toggle is awaiting).

### Low — Menu opacity 0% / CSS fallback mismatch

**Location**: `MessageOverlay.module.scss:44,49,205`, `advancedSettingsStore.ts:24,44`

`MENU_BG_OPACITY_MIN=0` lets the menu background go fully transparent (unreadable buttons). The CSS fallback is `var(--menu-bg-opacity, 90%)` but the store default is `100%` — inconsistent if the var is ever unset. Consider raising min to ~30% and aligning the fallback to 100%.

### Note (security) — JWT copy behind a weak easter egg

**Location**: `advanced.tsx:149-154` ("Copy JWT Token"), `AppVersionItem.tsx:44` (`developerSettings` enabled for all)

`features.ts` flips `developerSettings` to `enabled: true`, so any user can 5-tap the version label to unlock advanced settings, which exposes "Copy JWT Token" (copies the user's own JWT to clipboard). Not a hard boundary and the JWT is already reachable via devtools, but the easter egg lowers the bar for clipboard credential exposure. Consider a separate, default-disabled gate for the JWT-copy item, or omit it from advanced settings.

### Note — `initAdvancedSettings` in bootstrap critical path

**Location**: `main.tsx:52` (inside `Promise.all`)

If IDB is unavailable, `initAdvancedSettings()` rejects → `bootstrap()` throws → app never renders. This is consistent with the pre-existing `kvGet` calls in the same `Promise.all`, so not a regression — but advanced-settings init is now another hard dependency on IDB in the boot path.

### Note — Perf: single broadcast `notify()`

All hooks share one `listeners` set; any setting change notifies every subscriber. Acceptable because snapshots are referentially stable (subscribers bail via `Object.is`) and settings change only while the user is in settings (conversation components unmounted). No action needed; documenting the design choice.

---

## Pass 2 — MAINTAINABILITY (per skill checklist)

### Duplicate / Redundant Code — **High**

**Location**: `advancedSettingsStore.ts:26-37` vs `constants/overlayAction.ts:33-45`

The canonical action-key list is hardcoded in two places. They drifted (`forward` missing in the store), directly causing the High functional bug. This is the root maintainability defect. Merge to one source of truth (`DEFAULT_ACTION_ORDER`) — see fix above.

### Dead / Compatibility-Only Code — Medium

**Location**: `constants/overlayAction.ts:53-67` (`getActionLabels`), `overlayActionPolicy.ts:180-183`

- `getActionLabels()` is consumed only by `action-order.tsx:34`, which **overrides** `save` and `favorite` with context-tagged `t({message, context})` variants (`action-order.tsx:35-36`). So those two entries in `getActionLabels` are dead for that consumer. The overlay itself (`useMessageOverlayActions`) uses its own inline labels (`t\`Copy\``,`t\`Fav\``,`t({message:'Save',…})`), not`getActionLabels`. Two parallel label sources invite drift.
- `overlayActionPolicy.ts:180-183` test "falls back to default order when actionOrder is not provided" documents a branch that is **dead in production** — `useActionOrder()` always returns an array now, so `actionOrder` is never `undefined`. Either keep the guard + test as defensive, or drop both intentionally.

### Naming Quality — Low

**Location**: `advancedSettingsStore.ts:18` (`hideOwnAvatarAndInfo`) vs `advanced.tsx:129` (`Hide own avatar in chat`)

Setting key says "AndInfo" but implementation only hides the avatar column (`ChatMessageRow.tsx:73` → `hideAvatarColumn`; `ChatBubbleBase.tsx:539` renders `null`, `showName` untouched). The key name overpromises. Rename to `hideOwnAvatar` or actually also suppress sender name.

### Over-Complex Logic — Low

**Location**: `PresetSlider.tsx:61-62`

`isCurrentlyCustom = customSelected || isCustomValue` mixes local UI state (`customSelected`) with the derived prop (`isCustomValue`). It works but the dual sources can diverge (e.g., parent sets value to a preset while `customSelected` is still true). Consider making `customSelected` fully derived from `isCustomValue`, or document why local state is needed.

### Hard-Coded Values — Low

**Location**: `advancedSettingsStore.ts:52-55, 68-71`

Preset lists (`150/350/600/1000`, `50/70/90/100`) and labels are inline. Acceptable as local config, but `getMenuBgOpacityPresets` returns an inferred (untyped) shape while `getLongPressPresets` returns `Preset[]` — inconsistent typing. Type the opacity presets as `Preset[]` too. Also `getMenuBgOpacityPresets` mixes untranslated `'50%'` with `t\`Default (100%)\`` — minor i18n inconsistency.

### Error Handling Consistency — Low

**Location**: `advancedSettingsStore.ts:104-113, 125-138` vs `:159-163`

`enqueueIdbWrite` swallows+logs rejections (good). But `initAdvancedSettings`, `unlockAdvancedSettings`, `lockAdvancedSettings` propagate rejections. `unlockAdvancedSettings` is awaited in `AppVersionItem.handleVersionClick` without try/catch — an IDB failure becomes an unhandled rejection and the success toast never shows, while `unlockedCache` was already flipped true in-memory. Adopt one strategy (e.g., wrap the toggle handlers, or have the store not throw on IDB failure).

### Unnecessary Exposure — Low

**Location**: `advancedSettingsStore.ts` exports

`isCustomLongPressValue`, `isCustomMenuBgOpacity`, `getLongPressPresets`, `getMenuBgOpacityPresets` are exported and used only by their own settings page. Fine for now, but they could live beside the page rather than in the store module, which already mixes schema + presets + pub/sub + IDB queue + hooks (SRP). Not urgent.

### Feature Gating Consistency — Medium

**Location**: `features.ts`, `MobileLayout.tsx:107-110`, `DesktopSplitLayout.tsx:121-136`

Per `AGENTS.md`: "New user-visible features should have an explicit flag in `src/features.ts`. Gate every frontend entry point … including routes." The advanced-settings feature has **no dedicated flag** (the diff only adds `messageForward` and flips `developerSettings` to enabled). The `/settings/advanced/*` routes are registered/matched unconditionally. The easter egg is the only gate, via `developerSettings`. Add an `advancedSettings` flag and/or gate the routes for consistency with the project convention.

### Items with no issues

- **Magic Strings**: action keys are typed via `OverlayActionKey` union. ✔
- **Dependency Direction**: store imports from `constants`/`utils` (lower layers); no cycles. ✔
- **Unnecessary Comments**: comments explain *why* (write-queue rationale, "Adding a new advanced setting" recipe). Keep. ✔

---

## Summary

| # | Severity | Area | Finding |
|---|----------|------|---------|
| 1 | High | Func | `forward` missing from `ADVANCED_DEFAULTS.actionOrder` → wrong order for all users |
| 2 | High | Func/Verify | `npm run verify` fails; stale `useMessageOverlayActions` order test (+ pre-existing domSetup localStorage failures) |
| 3 | Medium | Func | Lock redirect incomplete; advanced sub-pages bypassable when locked |
| 4 | Medium | Func | Forward-compat: stored order not reconciled with canonical keys; no hydration validation |
| 5 | Medium | Maintain | Duplicate hardcoded action-key list (root cause of #1) |
| 6 | Medium | Gate | No `advancedSettings` feature flag; routes ungated (vs AGENTS.md) |
| 7 | Low | Func | `setLongPressDelayMs` no clamp; 5ms floor hair-trigger |
| 8 | Low | Func | Easter-egg toggle races on >5 rapid taps |
| 9 | Low | Func | Menu opacity 0% unreadable; CSS fallback 90% vs default 100% |
| 10 | Low | Maintain | `getActionLabels` save/favorite dead; parallel label sources |
| 11 | Low | Maintain | `hideOwnAvatarAndInfo` name vs behavior mismatch |
| 12 | Low | Maintain | `PresetSlider` dual custom-state sources |
| 13 | Note | Security | JWT copy behind weak 5-tap easter egg |
| 14 | Note | Func | `initAdvancedSettings` hard IDB dependency in boot path (pre-existing pattern) |

Top blockers before merge: #1 and #2 (verify must pass; default action order must be correct & single-sourced). #3/#4/#5/#6 should follow.
