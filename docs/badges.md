# Badge and unread-count behavior

## Account preference

**Show unread message count** is a server-backed account setting, shared across devices and clients. It defaults to **off**. Off counts unread chats/conversations; on counts unread messages. Changing it does not mark anything read, change mute/archive state, or change which conversations belong to a scope. Concurrent settings patches preserve omitted preferences.

The native Apple client applies this preference to its app icon, active top-tab numbers, and back badge. PWA exposes and synchronizes the same setting for the server-owned app badge; its existing top-tab and archive counting behavior is unchanged. The preference remains shared because APNs must select the same unit while a client is not running.

## Scope and units

“Main” means non-archived main group chats and direct chats. App-icon and back badges exclude muted chats, including effective account defaults, per-chat overrides, and active timed mutes. Thread replies do not contribute to these badges. Folders are a future feature, not part of the current scope model; category tabs are filters, not folders.

| Surface | Toggle off | Toggle on | Scope / precedence |
| --- | --- | --- | --- |
| Chat or thread row | Unread messages | Unread messages | The row's conversation, including muted unread state; mention/reaction indicators remain separate |
| App icon / Dock / browser app badge | Unread Main chats | Unread Main messages | Eligible Main chats; never the currently selected tab or loaded page |
| Apple active top tab | Unread conversations | Unread messages | Tab's eligible unmuted scope; unread mentions/replies replace the numeric badge with `@` |
| PWA active top tab | Unread conversations | Unread conversations | Existing PWA policy; unread mentions/replies replace the numeric badge with `@` |
| Apple archive entry | Unread conversations | Unread conversations | Archived scope corresponding to the current tab, including muted conversations; always numeric, never replaced by `@` |
| PWA archive entry | Unread messages | Unread messages | Existing PWA policy; always numeric, never replaced by `@` |
| Apple chat back button | Unread Main chats excluding current parent chat | Unread Main messages excluding current parent chat | Always Main, regardless of navigation history |

Top-tab scope retains the existing categories: Groups, DMs/Friends, Threads, and Messages. Messages includes threads only when “show threads in Messages” is enabled. Threads remain distinct conversations, using their own archive state rather than inheriting parent-chat mute state. Top tabs overlap and their counts must not be added together. Archive entry scope follows the corresponding category and thread-display choice.

## Apple back badge

The badge answers “is there unread activity elsewhere in Main?”, not “does the previous page have unread activity?”

- Main → Chat A: exclude A from eligible Main activity.
- Main → Archive → Chat A: still show eligible Main activity. Archived A already contributes nothing.
- Inside a thread: exclude its parent main chat; thread replies themselves never contribute.
- Different windows derive their own exclusion from the same account snapshot without changing the unread subscription.

The setting changes only the counting unit. Reading or receiving messages in the excluded chat must not change the back badge through independent client-side arithmetic.

## Authoritative delivery

The existing account unread watch supplies `appBadgeCount` for the app icon and a coherent `mainUnread` snapshot for route-local exclusions. The snapshot contains its own `showUnreadMessageCount` mode and eligible positive-unread chat entries (`chatId`, `unreadCount`). It reuses backend unread counting; no per-navigation recount or exclusion subscription is required.

A present `mainUnread` replaces the entire previous snapshot, including an empty chat list. An omitted field in a partial frame retains the previous snapshot; omission in a full frame means the snapshot is unavailable. Changes in membership, per-chat counts, or counting mode must publish a replacement even when the final aggregate number is unchanged. Request identity and full-snapshot readiness prevent stale subscriptions from restoring obsolete data. Disconnect, account reset, and unread-watch errors invalidate the Apple back snapshot; unknown state hides the badge rather than estimating it.

Clients must not subtract independently delivered row/read-state counts from an app-icon total. The Apple back badge selects the unit from the same `mainUnread` snapshot as the per-chat counts, excludes the current parent chat, and only then sums/caps. Individual backend message counts and aggregate message badges are capped at 1,000; chat counts are not subject to this message-count cap. UI compact labels may apply their existing visual limits (for example `99+`) without changing counting semantics. Zero hides an in-app badge or clears the app-icon badge.

Backend APNs badge values and foreground app-icon values honor the same persisted account preference and eligibility policy. A local-only display toggle is insufficient: background notifications must not switch the icon back to another counting unit.

## Update behavior

Message arrival/deletion/publication, read-state changes on any device, archive/mute changes, timed-mute expiry, membership/access changes, membership-message visibility, and the count-mode preference can change the authoritative result. Clients consume server snapshots instead of incrementing local estimates or summing loaded list pages. Hidden membership messages follow the existing unread visibility policy.

Unread counts exclude the viewer's own user messages in chats and threads. Visible system messages retain their normal unread behavior. Marking a chat unread from the list moves its read position to just before the newest message that can count as unread.

## Examples

For eligible Main chats A with 5 unread messages and B with 2, plus archived C with 8 and muted D with 4:

- App icon: **2** with the toggle off, **7** with it on.
- Back badge inside A (or A's thread): **1** off, **2** on.
- Back badge inside archived C: **2** off, **7** on.
- A's row: **5** in both modes; C's row: **8** in both modes.
- Apple archive entry for a scope containing only C: **1** in both modes, even if C has unread mentions. The unchanged PWA archive entry shows **8**.

A top tab with eligible unread mentions shows `@` in either mode on both clients. Once those mentions are read, Apple uses the selected numeric unit; PWA retains conversation counts.
