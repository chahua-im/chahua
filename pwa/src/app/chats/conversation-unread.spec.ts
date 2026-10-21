import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import {
  ServerWsMessageType,
  type ConversationUnreadPayload,
  type MeResponse,
  type ServerWsMessage,
} from '../../generated/models';
import { Connection } from '../api/connection';
import { jsonInterceptor } from '../api/json.interceptor';
import { mockRealtime, testUser } from '../api/testing';
import { SessionStore } from '../session/session-store';
import { conversationView } from './conversation-views';
import { ChatListStore } from './chat-list-store';
import { ListTab } from './list-tabs';

const counts = (key: string, messages: number, attention = 0) => ({
  key,
  unreadMessageCount: messages,
  unreadUnmutedMessageCount: messages,
  unreadConversationCount: messages ? 1 : 0,
  unreadUnmutedConversationCount: messages ? 1 : 0,
  unreadAttentionCount: attention,
  unreadUnmutedAttentionCount: attention,
});
const selection = (tab: ListTab, archived = false) => ({ tab, archived, requestHistory: false });

describe('conversation unread WebSocket subscription', () => {
  const user = signal<MeResponse | undefined>(testUser);
  const connected = signal(true);
  let store: ChatListStore;
  let http: HttpTestingController;
  let events: Subject<ServerWsMessage>;
  let resync: Subject<void>;
  let release: () => void;
  const watch = vi.fn<Connection['watchConversationUnread']>();
  const requestId = () => watch.mock.calls.at(-1)![0];
  const summary = () => store.summary(conversationView(store.selection(), true));
  const publish = (payload: Partial<ConversationUnreadPayload> = {}) =>
    events.next({
      type: ServerWsMessageType.conversationUnread,
      payload: {
        requestId: requestId(),
        full: true,
        summaries: [counts('friends', 12), counts('threads', 28, 2), counts('friends-archived', 3)],
        appBadgeCount: 7,
        ...payload,
      },
    });
  beforeEach(() => {
    user.set(testUser);
    connected.set(true);
    watch.mockClear();
    events = new Subject();
    resync = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        {
          provide: Connection,
          useValue: {
            ...mockRealtime({ events$: events, resync$: resync, connected }),
            watchConversationUnread: watch,
          },
        },
        { provide: SessionStore, useValue: { user } },
      ],
    });
    store = TestBed.inject(ChatListStore);
    http = TestBed.inject(HttpTestingController);
    release = store.viewUnread.activate();
    TestBed.tick();
    expect(watch).toHaveBeenCalledOnce();
    expect(watch.mock.calls[0][1]).toHaveLength(10);
    expect(watch.mock.calls[0][2]).toBe(true);
    publish();
    store.selection.set(selection(ListTab.Friends));
  });
  afterEach(() => {
    release();
    TestBed.resetTestingModule();
    http.verify();
  });

  it('shares one subscription across tabs, archive entries and the app icon', () => {
    const releaseBadge = store.unread.activate();
    expect(store.unread.value()?.unreadCount).toBe(7);
    store.selection.set(selection(ListTab.Threads));
    expect(summary()?.unreadAttentionCount).toBe(2);
    store.selection.set(selection(ListTab.Friends, true));
    expect(summary()?.unreadMessageCount).toBe(3);
    TestBed.tick();
    user.set({ ...testUser, username: 'renamed' });
    TestBed.tick();
    expect(watch).toHaveBeenCalledOnce();
    releaseBadge();
    http.expectNone(() => true);
  });

  it('replaces changed collections, preserves others and accepts zero badge counts', () => {
    publish({ full: false, summaries: [counts('friends', 0)], appBadgeCount: 0 });
    expect(summary()?.unreadMessageCount).toBe(0);
    store.selection.set(selection(ListTab.Threads));
    expect(summary()?.unreadMessageCount).toBe(28);
    expect(store.unread.value()?.unreadCount).toBe(0);
    publish({ full: false, summaries: [counts('threads', 0)], appBadgeCount: undefined });
    expect(store.unread.value()?.unreadCount).toBe(0);
    http.expectNone(() => true);
  });

  it('refreshes via WS, retaining old counts and rejecting late or premature partial replies', () => {
    const old = requestId();
    store.viewUnread.refresh();
    expect(requestId()).not.toBe(old);
    publish({ requestId: old, summaries: [counts('friends', 999)] });
    publish({ full: false, summaries: [counts('friends', 999)] });
    expect(summary()?.unreadMessageCount).toBe(12);
    publish({ summaries: [counts('friends', 8)] });
    expect(summary()?.unreadMessageCount).toBe(8);
    expect(store.viewUnread.value()).toHaveLength(1);
  });

  it('retains counts on failure and recovers from the server retry without an HTTP fallback', () => {
    events.next({ type: ServerWsMessageType.conversationUnreadError, payload: { requestId: requestId() } });
    expect(store.viewUnread.error()).toBe(true);
    expect(summary()?.unreadMessageCount).toBe(12);
    publish({ summaries: [counts('friends', 8)] });
    expect(store.viewUnread.error()).toBe(false);
    expect(summary()?.unreadMessageCount).toBe(8);
    http.expectNone(() => true);
  });

  it('does not resubscribe on healthy foreground resync, but does after reconnection', () => {
    resync.next();
    TestBed.tick();
    expect(watch).toHaveBeenCalledOnce();
    const old = requestId();
    connected.set(false);
    TestBed.tick();
    expect(summary()?.unreadMessageCount).toBe(12);
    connected.set(true);
    TestBed.tick();
    expect(watch).toHaveBeenCalledTimes(2);
    publish({ requestId: old, summaries: [counts('friends', 999)] });
    expect(summary()?.unreadMessageCount).toBe(12);
    publish({ summaries: [counts('friends', 4)] });
    expect(summary()?.unreadMessageCount).toBe(4);
  });

  it('clears another account immediately and rejects its messages before effects run', () => {
    const old = requestId();
    user.set({ ...testUser, uid: 2 });
    expect(summary()).toBeUndefined();
    publish({ requestId: old, summaries: [counts('friends', 999)] });
    TestBed.tick();
    expect(summary()).toBeUndefined();
    publish({ summaries: [counts('friends', 2)] });
    expect(summary()?.unreadMessageCount).toBe(2);
    user.set(undefined);
    expect(summary()).toBeUndefined();
    TestBed.tick();
    expect(watch.mock.calls.at(-1)?.slice(1)).toEqual([[], false]);
  });

  it('keeps the subscription in the background and cancels after the final consumer leaves', () => {
    const releaseBadge = store.unread.activate();
    release();
    release = () => {};
    TestBed.tick();
    expect(watch).toHaveBeenCalledOnce();
    document.dispatchEvent(new Event('visibilitychange'));
    resync.next();
    TestBed.tick();
    expect(watch).toHaveBeenCalledOnce();
    releaseBadge();
    TestBed.tick();
    expect(watch.mock.calls.at(-1)?.slice(1)).toEqual([[], false]);
  });

  it('updates archived totals and mute expiry directly from server publications', () => {
    store.selection.set(selection(ListTab.Friends, true));
    publish({ full: false, summaries: [counts('friends-archived', 0)], appBadgeCount: undefined });
    expect(summary()?.unreadMessageCount).toBe(0);
    store.selection.set(selection(ListTab.Threads));
    publish({
      full: false,
      summaries: [{ ...counts('threads', 28, 2), unreadUnmutedAttentionCount: 0 }],
      appBadgeCount: undefined,
    });
    expect(summary()?.unreadUnmutedAttentionCount).toBe(0);
    publish({ full: false, summaries: [counts('threads', 28, 2)], appBadgeCount: undefined });
    expect(summary()?.unreadUnmutedAttentionCount).toBe(2);
    expect(watch).toHaveBeenCalledOnce();
    http.expectNone(() => true);
  });
});
