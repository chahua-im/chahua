import { NgZone } from '@angular/core';

/** Opt in before navigating: sessionStorage.setItem('chat-list-trace', '1'). */
export function chatListTraceEnabled() {
  return sessionStorage.getItem('chat-list-trace') === '1';
}

export function traceChatList(event: string, detail?: unknown) {
  if (!chatListTraceEnabled()) return;
  // Serialize now: DevTools' lazy object inspection otherwise shows later state.
  console.debug('[chat-list]', performance.now().toFixed(2), event, NgZone.isInAngularZone(), JSON.stringify(detail));
}
