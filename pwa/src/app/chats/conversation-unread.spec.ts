import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { ConversationsService } from '../../generated/endpoints/conversations/conversations.service';
import { ConversationCategory, type MeResponse } from '../../generated/models';
import { Connection } from '../api/connection';
import { jsonInterceptor } from '../api/json.interceptor';
import { encodeId } from '../api/snowflake-id';
import { mockRealtime, testChat, testUser } from '../api/testing';
import { SessionStore } from '../session/session-store';
import { conversationView } from './conversation-views';
import { ChatListStore } from './chat-list-store';
import { ChatStore } from './chat-store';
import { ListTab } from './list-tabs';

const endpoint = '/_api/conversations/unread-summary';
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

describe('conversation unread snapshots', () => {
  const user = signal<MeResponse | undefined>(testUser);
  let store: ChatListStore;
  let http: HttpTestingController;
  let resync: Subject<void>;
  let release: () => void;
  const showThreads = signal(true);
  const selectedSummary = () => store.summary(conversationView(store.selection(), showThreads()));
  const settle = async () => {
    TestBed.tick();
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };

  beforeEach(async () => {
    user.set(testUser);
    resync = new Subject<void>();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: Connection, useValue: mockRealtime({ resync$: resync }) },
        { provide: SessionStore, useValue: { user } },
      ],
    });
    store = TestBed.inject(ChatListStore);
    http = TestBed.inject(HttpTestingController);
    await settle();
    release = store.viewUnread.activate();
    await settle();
    const request = http.expectOne(endpoint);
    expect(request.request.body.views).toHaveLength(10);
    request.flush({
      summaries: [
        counts('friends', 12),
        counts('threads', 28, 2),
        counts('messages', 20),
        counts('messages-with-threads', 48, 2),
        counts('friends-archived', 3),
      ],
    });
    await settle();
  });
  afterEach(() => {
    release();
    http.verify();
  });

  it('shares one snapshot across consumers, tab switches, archives and preferences', async () => {
    const another = store.viewUnread.activate();
    store.selection.set(selection(ListTab.Friends));
    expect(selectedSummary()?.unreadMessageCount).toBe(12);
    store.selection.set(selection(ListTab.Threads));
    expect(selectedSummary()?.unreadAttentionCount).toBe(2);
    store.selection.set(selection(ListTab.Friends, true));
    expect(selectedSummary()?.unreadMessageCount).toBe(3);
    store.selection.set(selection(ListTab.Messages));
    showThreads.set(false);
    expect(selectedSummary()?.unreadMessageCount).toBe(20);
    showThreads.set(true);
    expect(selectedSummary()?.unreadMessageCount).toBe(48);
    await settle();
    http.expectNone(endpoint);
    another();
  });

  it('retains known counts during refresh and rejects superseded responses', async () => {
    store.selection.set(selection(ListTab.Friends));
    void store.viewUnread.refresh();
    await settle();
    const old = http.expectOne(endpoint);
    resync.next();
    expect(selectedSummary()?.unreadMessageCount).toBe(12);
    old.flush({ summaries: [counts('friends', 999)] });
    await settle();
    expect(selectedSummary()?.unreadMessageCount).toBe(12);
    http.expectOne(endpoint).flush({ summaries: [counts('friends', 8)] });
    await settle();
    expect(selectedSummary()?.unreadMessageCount).toBe(8);
    void store.viewUnread.refresh();
    await settle();
    http.expectOne(endpoint).flush({}, { status: 503, statusText: 'Unavailable' });
    await settle();
    expect(selectedSummary()?.unreadMessageCount).toBe(8);
  });

  it('clears a previous account snapshot immediately and does not accept its delayed response', async () => {
    store.selection.set(selection(ListTab.Friends));
    void store.viewUnread.refresh();
    await settle();
    const old = http.expectOne(endpoint);
    user.set({ ...testUser, uid: 2 });
    expect(selectedSummary()).toBeUndefined();
    await settle();
    old.flush({ summaries: [counts('friends', 999)] });
    await settle();
    expect(selectedSummary()).toBeUndefined();
    http.expectOne(endpoint).flush({ summaries: [counts('friends', 2)] });
    await settle();
    expect(selectedSummary()?.unreadMessageCount).toBe(2);
    user.set(undefined);
    expect(selectedSummary()).toBeUndefined();
    await settle();
    http.expectNone(endpoint);
  });

  it('refreshes unmuted attention when a known mute expires, preserving the old snapshot until it arrives', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
    try {
      const metadata = TestBed.inject(ChatStore);
      metadata.acceptChats([{ ...testChat, mutedUntil: '2026-10-21T00:00:02Z' }], metadata.snapshot());
      await settle();
      store.selection.set(selection(ListTab.Messages));
      showThreads.set(false);
      void store.viewUnread.refresh();
      await settle();
      http.expectOne(endpoint).flush({ summaries: [{ ...counts('messages', 20, 3), unreadUnmutedAttentionCount: 0 }] });
      await settle();
      expect(metadata.isMuted(testChat.id)).toBe(true);
      expect(selectedSummary()?.unreadUnmutedAttentionCount).toBe(0);
      await vi.advanceTimersByTimeAsync(2001);
      await settle();
      expect(metadata.isMuted(testChat.id)).toBe(false);
      expect(selectedSummary()?.unreadMessageCount).toBe(20);
      expect(selectedSummary()?.unreadUnmutedAttentionCount).toBe(0);
      http.expectOne(endpoint).flush({ summaries: [counts('messages', 20, 3)] });
      await settle();
      expect(selectedSummary()?.unreadUnmutedAttentionCount).toBe(3);
      expect(selectedSummary()?.unreadMessageCount).toBe(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves Snowflake IDs in generic custom selectors', () => {
    TestBed.inject(ConversationsService)
      .unreadSummary({
        views: [
          {
            key: 'custom',
            selector: {
              categories: [ConversationCategory.group],
              include: [{ chatId: encodeId('9007199254740993'), threadId: encodeId('9007199254740995') }],
            },
          },
        ],
      })
      .subscribe();
    const request = http.expectOne(endpoint);
    expect(request.request.body.views[0].selector.include[0]).toEqual({
      chatId: '9007199254740993',
      threadId: '9007199254740995',
    });
    request.flush({ summaries: [counts('custom', 1)] });
  });
});
