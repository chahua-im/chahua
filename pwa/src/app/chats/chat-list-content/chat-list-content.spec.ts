import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
import { IonActionSheet, IonButton, IonItemOption, IonItemSliding } from '@ionic/angular';
import { chatbubbles } from 'ionicons/icons';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import {
  FriendRequestDirection,
  FriendRequestStatus,
  GroupKind,
  MessageType,
  ServerWsMessageType,
  type ChatListItem as ChatData,
  type FriendRequestHistoryEntry,
  type ThreadListItem as ThreadData,
  type ServerWsMessage,
} from '../../../generated/models';
import { Connection } from '../../api/connection';
import { decodeId, encodeId, type SnowflakeID } from '../../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser } from '../../api/testing';
import { routes } from '../../app.routes';
import { ConversationNavigation, ConversationTargetKind } from '../../conversations/conversation-navigation';
import { DraftStore } from '../../conversations/draft-store';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { ChatListItem } from '../chat-list-item/chat-list-item';
import { ChatListStore, FriendRequestAction, type ChatListError } from '../chat-list-store';
import { ChatStore, type ChatInfo } from '../chat-store';
import { MessageDelivery } from '../../messages/message-delivery';
import { MessageStatus } from '../../messages/message-status/message-status';
import { MessageOutbox, type OutgoingMessage } from '../../messages/message-outbox';
import { listSelection, ListTab } from '../list-tabs';
import { ChatListContent } from './chat-list-content';

const incoming: FriendRequestHistoryEntry = {
  id: encodeId('1'),
  createdAt: '2026-09-05T12:00:00Z',
  direction: FriendRequestDirection.incoming,
  status: FriendRequestStatus.pending,
  from: { uid: 2, username: '小李', gender: 0 },
  to: { uid: 1, username: '自己', gender: 0 },
  message: '一起聊天吧',
};

const thread: ThreadData = {
  archived: false,
  chatId: testChat.id,
  chatKind: testChat.kind,
  chatName: '测试群',
  chatAvatar: 'https://example.com/thread-group.jpg',
  lastReplyAt: testMessage.createdAt,
  participants: [
    { uid: 1, name: '自己', gender: 0 },
    { uid: 2, name: '小花', gender: 0, avatarUrl: 'https://example.com/participant.jpg' },
  ],
  replyCount: 3,
  subscribedAt: testMessage.createdAt,
  threadRootMessage: {
    ...testMessage,
    mentions: [],
    message: '话题开头',
    sender: { uid: 7, name: '发起人', gender: 0, avatarUrl: 'https://example.com/root-author.jpg' },
  },
  lastReply: {
    ...testMessage,
    id: encodeId('9007199254741005'),
    mentions: [],
    message: '最新回复',
    sender: { uid: 2, name: '小花', gender: 0 },
  },
  unreadCount: 3,
  unreadMentions: 0,
  unreadReactions: 0,
};

class ListVisibilityObserver {
  static instances: ListVisibilityObserver[] = [];
  readonly targets = new Set<Element>();

  constructor(private readonly callback: IntersectionObserverCallback) {
    ListVisibilityObserver.instances.push(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  disconnect() {
    this.targets.clear();
  }

  emit(entries: { target: Element; isIntersecting: boolean }[]) {
    this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

describe('ChatListContent', () => {
  const lastMessage = { ...testMessage, mentions: [] };
  let fixture: ComponentFixture<ChatListContent>;
  let presenceEvents: Subject<ServerWsMessage>;
  const connected = signal(true);
  const watchPresence =
    vi.fn<(requestId: number, userIds: readonly number[], chatIds: readonly SnowflakeID[]) => void>();
  const session = { user: signal(testUser), logout: vi.fn() };
  const preferences = {
    showThreadsInMessages: signal(false),
    showAllAvatars: signal(false),
  };
  const chats = {
    items: signal<ChatData[]>([]),
    loading: signal(false),
    loadingMore: signal(false),
    loadedThrough: signal(-Infinity),
    hasMore: signal(false),
    error: signal<ChatListError | undefined>(undefined),
    activate: vi.fn(() => vi.fn()),
    refresh: vi.fn(),
    loadMore: vi.fn().mockResolvedValue(undefined),
  };
  const data = {
    chats: vi.fn(() => chats),
    markRead: vi.fn().mockResolvedValue(undefined),
    markUnread: vi.fn().mockResolvedValue(undefined),
    setNotificationSetting: vi.fn().mockResolvedValue(undefined),
    setArchived: vi.fn().mockResolvedValue(undefined),
  };
  const navigation = { goTo: vi.fn() };
  const outbox = { items: signal<OutgoingMessage[]>([]) };
  const chatInfo = signal<ChatInfo | undefined>(undefined);
  const metadata = {
    chatState: (id: SnowflakeID) => chats.items().find((chat) => chat.id === id),
    notificationDefaults: session.user,
    isMuted: (id: SnowflakeID) =>
      Date.parse(chats.items().find((chat) => chat.id === id)?.mutedUntil ?? '') > Date.now(),
    get: () => chatInfo(),
    ensure: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn(),
  };
  function query<T>(items: T[]) {
    return {
      items: signal(items),
      loading: signal(false),
      error: signal(false),
      activate: vi.fn(() => vi.fn()),
      refresh: vi.fn().mockResolvedValue(undefined),
    };
  }
  const requests = query<FriendRequestHistoryEntry>([]);
  const history = query<FriendRequestHistoryEntry>([]);
  const threads = {
    ...query<ThreadData>([]),
    loadingMore: signal(false),
    loadedThrough: signal(-Infinity),
    hasMore: signal(false),
    loadMore: vi.fn().mockResolvedValue(undefined),
  };
  const inbox = {
    friendRequests: vi.fn((archived: boolean) => (archived ? history : requests)),
    threads: vi.fn(() => threads),
    markThreadRead: vi.fn().mockResolvedValue(undefined),
    setThreadArchived: vi.fn().mockResolvedValue(undefined),
    decideRequest: vi.fn<(id: SnowflakeID, action: FriendRequestAction) => Promise<void>>().mockResolvedValue(),
  };
  const counts = {
    chats: {
      value: signal(0),
      loading: signal(false),
      error: signal(false),
      activate: vi.fn(() => vi.fn()),
      refresh: vi.fn(),
    },
    threads: {
      value: signal(0),
      loading: signal(false),
      error: signal(false),
      activate: vi.fn(() => vi.fn()),
      refresh: vi.fn(),
    },
  };

  async function selectRoute(url: string) {
    const router = TestBed.inject(Router);
    await router.navigateByUrl(url);
    const selection = listSelection(router.routerState.snapshot.root);
    if (selection) fixture.componentRef.setInput('selection', selection);
  }
  beforeEach(async () => {
    ListVisibilityObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', ListVisibilityObserver);
    presenceEvents = new Subject<ServerWsMessage>();
    connected.set(true);
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    counts.chats.loading.set(false);
    counts.threads.loading.set(false);
    counts.chats.error.set(false);
    counts.threads.error.set(false);
    history.loading.set(false);
    history.error.set(false);
    chats.loadedThrough.set(-Infinity);
    threads.loadedThrough.set(-Infinity);
    vi.clearAllMocks();
    preferences.showThreadsInMessages.set(false);
    vi.spyOn(IonItemSliding.prototype, 'close').mockResolvedValue();
    vi.spyOn(IonActionSheet.prototype, 'present').mockResolvedValue();
    vi.spyOn(IonActionSheet.prototype, 'onDidDismiss').mockResolvedValue({
      role: 'selected',
      data: { mode: 'temporarilyMuted', durationSeconds: 3600 },
    });
    outbox.items.set([]);
    chats.items.set([{ ...testChat, lastMessage }]);
    chats.loading.set(false);
    chats.hasMore.set(false);
    chatInfo.set({ ...testChat, avatar: 'https://example.com/group.jpg' });
    threads.items.set([]);
    threads.loading.set(false);
    threads.hasMore.set(false);
    counts.chats.value.set(0);
    counts.threads.value.set(0);
    inbox.markThreadRead.mockReset().mockResolvedValue(undefined);
    inbox.setThreadArchived.mockReset().mockResolvedValue(undefined);
    requests.items.set([]);
    history.items.set([]);
    requests.error.set(false);
    inbox.decideRequest.mockReset().mockResolvedValue();
    await TestBed.configureTestingModule({
      imports: [ChatListContent],
      providers: [
        { provide: Connection, useValue: { ...mockRealtime({ events$: presenceEvents }), connected, watchPresence } },
        { provide: MessageOutbox, useValue: outbox },
        provideRouter(routes),
        {
          provide: ChatListStore,
          useValue: {
            ...data,
            ...inbox,
            archivedUnread: counts,
            viewUnread: counts.chats,
            summary: (view: { key: string }) => ({
              unreadMessageCount: view.key.startsWith('threads')
                ? counts.threads.value()
                : counts.chats.value() + (view.key.startsWith('messages-with-threads') ? counts.threads.value() : 0),
            }),
          },
        },
        { provide: ConversationNavigation, useValue: navigation },
        {
          provide: ChatStore,
          useValue: {
            ...metadata,
            ...data,
            markThreadRead: inbox.markThreadRead,
            setThreadArchived: inbox.setThreadArchived,
          },
        },
        { provide: SessionStore, useValue: session },
        { provide: Preferences, useValue: preferences },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ChatListContent);
    fixture.componentRef.setInput('selection', { tab: ListTab.Messages, archived: false, requestHistory: false });
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function conversationRow() {
    return fixture.debugElement
      .queryAll(By.directive(ChatListItem))
      .find((row) => (row.componentInstance as ChatListItem).entry().link?.includes(decodeId(testChat.id)))!;
  }

  it('shows live online dots only on DM rows and removes them when the peer goes offline', async () => {
    const dm = {
      ...testChat,
      id: encodeId('9007199254740994'),
      kind: GroupKind.dm,
      peer: { uid: 2, username: '小花', gender: 0 },
    };
    chats.items.set([testChat, dm]);
    requests.items.set([incoming]);
    preferences.showThreadsInMessages.set(true);
    threads.items.set([thread]);
    fixture.detectChanges();
    await fixture.whenStable();
    const dmRow = fixture.nativeElement.querySelector('[data-presence-uid="2"]') as HTMLElement;
    const observer = ListVisibilityObserver.instances.at(-1)!;
    observer.emit([{ target: dmRow, isIntersecting: true }]);
    await fixture.whenStable();
    const requestId = watchPresence.mock.calls.at(-1)![0];
    presenceEvents.next({
      type: ServerWsMessageType.presenceSnapshot,
      payload: { requestId, users: [{ uid: 2, online: true }], groups: [] },
    });
    await fixture.whenStable();
    expect(dmRow.querySelector('.online-dot')).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.online-dot')).toHaveLength(1);

    presenceEvents.next({
      type: ServerWsMessageType.presenceSnapshot,
      payload: { requestId, users: [{ uid: 2, online: false }], groups: [] },
    });
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.online-dot')).toBeNull();
  });

  it('watches only visible DMs and releases presence when rows scroll away or the list leaves', async () => {
    chats.items.set([
      { ...testChat, kind: GroupKind.dm, peer: { uid: 2, gender: 0 } },
      { ...testChat, id: encodeId('9007199254740994'), kind: GroupKind.dm, peer: { uid: 3, gender: 0 } },
    ]);
    fixture.detectChanges();
    await fixture.whenStable();
    const row = fixture.nativeElement.querySelector('[data-presence-uid="2"]') as HTMLElement;
    const observer = ListVisibilityObserver.instances.at(-1)!;
    observer.emit([{ target: row, isIntersecting: true }]);
    await fixture.whenStable();
    expect(watchPresence.mock.calls.at(-1)![1]).toEqual([2]);

    observer.emit([{ target: row, isIntersecting: false }]);
    await fixture.whenStable();
    expect(watchPresence.mock.calls.at(-1)![1]).toEqual([]);

    observer.emit([{ target: row, isIntersecting: true }]);
    await fixture.whenStable();
    const requestId = watchPresence.mock.calls.at(-1)![0];
    presenceEvents.next({
      type: ServerWsMessageType.presenceSnapshot,
      payload: { requestId, users: [{ uid: 2, online: true }], groups: [] },
    });
    await fixture.whenStable();
    expect(row.querySelector('.online-dot')).not.toBeNull();

    connected.set(false);
    await fixture.whenStable();
    expect(row.querySelector('.online-dot')).toBeNull();
    connected.set(true);
    await fixture.whenStable();
    fixture.componentRef.setInput('active', false);
    await fixture.whenStable();
    expect(watchPresence.mock.calls.at(-1)![1]).toEqual([]);
  });
  function options(side: 'start' | 'end') {
    return conversationRow()
      .queryAll(By.directive(IonItemOption))
      .filter((option) => option.nativeElement.parentElement.getAttribute('side') === side);
  }

  it('delegates archive and request history navigation without changing the conversation route', async () => {
    const router = TestBed.inject(Router);
    const url = '/chats/chat/9007199254740993';
    await router.navigateByUrl(url);
    const opened = vi.fn();
    fixture.componentInstance.openList.subscribe(opened);
    const friends = { tab: ListTab.Friends, archived: false, requestHistory: false };
    fixture.componentRef.setInput('selection', friends);
    await fixture.whenStable();
    for (const [title, selection] of [
      ['已归档', { ...friends, archived: true }],
      ['好友请求', { ...friends, requestHistory: true }],
    ] as const) {
      const row = fixture.debugElement
        .queryAll(By.directive(ChatListItem))
        .find((item) => (item.componentInstance as ChatListItem).entry().title === title)!;
      const item: HTMLIonItemElement = row.nativeElement.querySelector('ion-item');
      expect(item.button).toBe(true);
      expect(item.getAttribute('href')).toBeNull();
      item.click();
      expect(opened).toHaveBeenLastCalledWith(selection);
    }
    expect(router.url).toBe(url);
  });

  it('derives list selection from routes and keeps it locally while a conversation is open', async () => {
    await selectRoute('/chats/groups/archived');
    await fixture.whenStable();
    expect(fixture.componentInstance['list']()).toEqual({ tab: ListTab.Groups, archived: true, requestHistory: false });
    expect(data.chats).toHaveBeenLastCalledWith(true);
    await selectRoute('/chats/chat/9007199254740993');
    await fixture.whenStable();
    expect(fixture.componentInstance['list']()).toEqual({ tab: ListTab.Groups, archived: true, requestHistory: false });
    await selectRoute('/chats/friends/archived-requests');
    await fixture.whenStable();
    expect(history.activate).toHaveBeenCalledOnce();
    expect(fixture.componentInstance['list']()).toEqual({
      tab: ListTab.Friends,
      archived: false,
      requestHistory: true,
    });
    await selectRoute('/chats/groups');
    await fixture.whenStable();
    expect(counts.chats.activate).toHaveBeenCalledTimes(2);
    const releaseHistory = history.activate.mock.results[0].value;
    expect(releaseHistory).toHaveBeenCalledOnce();
    expect(fixture.componentInstance['list']()).toEqual({
      tab: ListTab.Groups,
      archived: false,
      requestHistory: false,
    });
  });

  it('filters group and friend rows locally without restarting the shared chat query', async () => {
    const dm = {
      ...testChat,
      id: encodeId('9007199254740994'),
      kind: GroupKind.dm,
      peer: { uid: 2, username: '小花', gender: 0 },
    };
    chats.items.set([testChat, dm]);
    counts.chats.value.set(268);
    await selectRoute('/chats/groups');
    await fixture.whenStable();
    expect(fixture.componentInstance['conversationRows']().map((row) => row.chat.id)).toEqual([testChat.id]);
    expect(fixture.componentInstance['archivedUnreadCount']()).toBe(268);
    await selectRoute('/chats/friends');
    await fixture.whenStable();
    expect(fixture.componentInstance['conversationRows']().map((row) => row.chat.id)).toEqual([dm.id]);
    expect(fixture.componentInstance['archivedUnreadCount']()).toBe(268);
    expect(chats.activate).toHaveBeenCalledOnce();
    expect(counts.chats.activate).toHaveBeenCalledOnce();
  });

  it('maps read and mute actions from conversation state to the matching service', async () => {
    expect(conversationRow().nativeElement.querySelector('ion-item').getAttribute('href')).toBe(
      '/chats/chat/9007199254740993',
    );
    expect(options('start').map((item) => item.nativeElement.textContent.trim())).toEqual(['标为已读']);
    expect(options('end').map((item) => item.nativeElement.textContent.trim())).toEqual(['通知设置', '归档']);
    options('start')[0].triggerEventHandler('click', new Event('click'));
    await fixture.whenStable();
    expect(data.markRead).toHaveBeenCalledWith(testChat.id, testMessage.id);
    options('end')[0].triggerEventHandler('click', new Event('click'));
    await fixture.whenStable();
    expect(data.setNotificationSetting).toHaveBeenCalledWith(testChat.id, {
      mode: 'temporarilyMuted',
      durationSeconds: 3600,
    });
    options('end')[1].triggerEventHandler('click', new Event('click'));
    await fixture.whenStable();
    expect(data.setArchived).toHaveBeenCalledWith(testChat.id, true);

    chats.items.set([{ ...testChat, lastMessage, unreadCount: 0, mutedUntil: '9999-12-31T23:59:59Z' }]);
    fixture.detectChanges();
    expect(options('start')[0].nativeElement.textContent.trim()).toBe('标为未读');
    expect(options('end')[0].nativeElement.textContent.trim()).toBe('通知设置');
    options('start')[0].triggerEventHandler('click', new Event('click'));
    await fixture.whenStable();
    expect(data.markUnread).toHaveBeenCalledWith(testChat.id);
    vi.mocked(IonActionSheet.prototype.onDidDismiss).mockResolvedValueOnce({
      role: 'selected',
      data: { mode: 'alwaysUnmuted' },
    });
    options('end')[0].triggerEventHandler('click', new Event('click'));
    await fixture.whenStable();
    expect(data.setNotificationSetting).toHaveBeenLastCalledWith(testChat.id, { mode: 'alwaysUnmuted' });
  });

  it('merges topics into Messages by activity and releases them when the preference is disabled', async () => {
    threads.items.set([{ ...thread, lastReplyAt: '2099-01-01T00:00:00Z' }]);
    preferences.showThreadsInMessages.set(true);
    await fixture.whenStable();
    expect(threads.activate).toHaveBeenCalledOnce();
    expect(fixture.componentInstance['rows']().map((row) => row.entry.link)).toEqual([
      ['/chats/chat', decodeId(thread.chatId), 'thread', decodeId(thread.threadRootMessage.id)],
      ['/chats/chat', decodeId(testChat.id)],
    ]);
    expect((fixture.componentInstance['rows']()[0].entry as { state?: unknown }).state).toEqual({ fromChatList: true });
    expect(fixture.nativeElement.textContent).toContain('话题开头');
    const release = threads.activate.mock.results[0].value;
    preferences.showThreadsInMessages.set(false);
    await fixture.whenStable();
    expect(release).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.textContent).not.toContain('话题开头');
    await selectRoute('/chats/threads');
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('话题开头');
  });

  it('includes archived topic unread counts only when topics are included in Messages', async () => {
    counts.chats.value.set(7);
    counts.threads.value.set(3);
    expect(fixture.componentInstance['archivedUnreadCount']()).toBe(7);
    preferences.showThreadsInMessages.set(true);
    await fixture.whenStable();
    expect(fixture.componentInstance['archivedUnreadCount']()).toBe(10);
    expect(counts.chats.activate).toHaveBeenCalledOnce();
    preferences.showThreadsInMessages.set(false);
    await fixture.whenStable();
    expect(counts.chats.activate).toHaveBeenCalledOnce();
    expect(fixture.componentInstance['archivedUnreadCount']()).toBe(7);
  });

  it('shows fixed entries without waiting for archive totals or loading request history', async () => {
    chats.items.set([{ ...testChat, kind: GroupKind.dm }]);
    history.loading.set(true);
    counts.chats.loading.set(true);
    fixture.componentRef.setInput('selection', { ...fixture.componentInstance['list'](), tab: ListTab.Friends });
    await fixture.whenStable();
    const entries = fixture.debugElement.queryAll(By.directive(ChatListItem));
    expect(entries.map((item) => (item.componentInstance as ChatListItem).entry().title)).toContain('已归档');
    expect(entries.map((item) => (item.componentInstance as ChatListItem).entry().title)).toContain('好友请求');
    expect(entries).toHaveLength(3);
    expect(history.activate).not.toHaveBeenCalled();
    fixture.componentInstance['refresh']();
    expect(history.refresh).not.toHaveBeenCalled();
    await selectRoute('/chats/friends/archived-requests');
    await fixture.whenStable();
    expect(history.activate).toHaveBeenCalledOnce();
  });

  it('keeps navigation entries visible alongside the initial list skeleton', async () => {
    chats.items.set([]);
    chats.loading.set(true);
    counts.chats.loading.set(true);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('ion-content ion-item')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('已归档');
    expect(fixture.nativeElement.querySelector('.chat-skeleton-row')).not.toBeNull();
  });

  it('shows the archive entry in every category and the request entry only in friends', async () => {
    for (const tab of [ListTab.Messages, ListTab.Groups, ListTab.Friends, ListTab.Threads]) {
      fixture.componentRef.setInput('selection', { ...fixture.componentInstance['list'](), tab });
      await fixture.whenStable();
      const titles = fixture.debugElement
        .queryAll(By.directive(ChatListItem))
        .map((item) => (item.componentInstance as ChatListItem).entry().title);
      expect(titles).toContain('已归档');
      expect(titles.includes('好友请求')).toBe(tab === ListTab.Friends);
    }
  });

  it('shows only the native refresher and never re-shows the skeleton over existing rows', async () => {
    chats.items.set([{ ...testChat, kind: GroupKind.dm }]);
    chats.refresh.mockImplementationOnce(() => chats.loading.set(true));
    fixture.debugElement.query(By.css('ion-refresher')).triggerEventHandler('ionRefresh');
    await fixture.whenStable();
    expect(fixture.componentInstance['refreshing']()).toBe(true);
    expect(fixture.nativeElement.querySelector('.chat-skeleton-row')).toBeNull();
    chats.loading.set(false);
    await fixture.whenStable();
    expect(fixture.componentInstance['refreshing']()).toBe(false);
    chats.loading.set(true);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.chat-skeleton-row')).toBeNull();
  });

  it('reveals a shared time range and pages only the source with the newer boundary', async () => {
    preferences.showThreadsInMessages.set(true);
    chats.items.set([{ ...testChat, lastMessageAt: '2026-09-07T08:00:00Z' }]);
    threads.items.set([{ ...thread, lastReplyAt: '2026-09-07T10:00:00Z' }]);
    chats.loadedThrough.set(Date.parse('2026-09-07T08:00:00Z'));
    threads.loadedThrough.set(Date.parse('2026-09-07T10:00:00Z'));
    chats.hasMore.set(true);
    threads.hasMore.set(true);
    await fixture.whenStable();
    expect(fixture.componentInstance['rows']().map((row) => row.key)).toEqual([thread.threadRootMessage.id]);
    const complete = vi.fn();
    fixture.debugElement
      .query(By.css('ion-infinite-scroll'))
      .triggerEventHandler('ionInfinite', { target: { complete } });
    await fixture.whenStable();
    expect(chats.loadMore).not.toHaveBeenCalled();
    expect(threads.loadMore).toHaveBeenCalledOnce();
    threads.loadedThrough.set(Date.parse('2026-09-07T07:00:00Z'));
    await fixture.whenStable();
    expect(fixture.componentInstance['rows']().map((row) => row.key)).toEqual([
      thread.threadRootMessage.id,
      testChat.id,
    ]);
    preferences.showThreadsInMessages.set(false);
    threads.loadedThrough.set(Infinity);
    await fixture.whenStable();
    expect(fixture.componentInstance['rows']().map((row) => row.key)).toEqual([testChat.id]);
    fixture.debugElement
      .query(By.css('ion-infinite-scroll'))
      .triggerEventHandler('ionInfinite', { target: { complete } });
    await fixture.whenStable();
    expect(chats.loadMore).toHaveBeenCalledOnce();
    expect(threads.loadMore).toHaveBeenCalledOnce();
  });

  it.each([ListTab.Groups, ListTab.Friends, ListTab.Threads])(
    'never applies mixed coverage to the %s tab',
    async (tab) => {
      chats.items.set([{ ...testChat, kind: tab === ListTab.Friends ? GroupKind.dm : GroupKind.group }]);
      threads.items.set([thread]);
      chats.loadedThrough.set(Infinity);
      threads.loadedThrough.set(Infinity);
      fixture.componentRef.setInput('selection', { ...fixture.componentInstance['list'](), tab });
      for (const enabled of [false, true]) {
        preferences.showThreadsInMessages.set(enabled);
        await fixture.whenStable();
        expect(fixture.componentInstance['rows']().map((row) => row.key)).toEqual([
          tab === ListTab.Threads ? thread.threadRootMessage.id : testChat.id,
        ]);
      }
    },
  );

  it('shows a draft preview and promotes it without changing the server pagination boundary', async () => {
    preferences.showThreadsInMessages.set(true);
    chats.items.set([{ ...testChat, lastMessageAt: '2026-09-07T08:00:00Z' }]);
    threads.items.set([{ ...thread, lastReplyAt: '2026-09-07T10:00:00Z' }]);
    chats.loadedThrough.set(Date.parse('2026-09-07T08:00:00Z'));
    threads.loadedThrough.set(Date.parse('2026-09-07T10:00:00Z'));
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-07T12:00:00Z'));
    TestBed.inject(DraftStore).save(testChat.id, undefined, '未发送的文字');
    await fixture.whenStable();
    expect(fixture.componentInstance['rows']()[0].key).toBe(testChat.id);
    expect(fixture.nativeElement.textContent.replace(/\s+/g, '')).toContain('草稿：未发送的文字');
    expect(chats.loadedThrough()).toBe(Date.parse('2026-09-07T08:00:00Z'));
  });

  it('refreshes and pages both sources in the mixed Messages list', async () => {
    preferences.showThreadsInMessages.set(true);
    chats.hasMore.set(true);
    threads.hasMore.set(true);
    await fixture.whenStable();
    fixture.componentInstance['refresh']();
    expect(chats.refresh).toHaveBeenCalledOnce();
    expect(threads.refresh).toHaveBeenCalledOnce();
    expect(counts.chats.refresh).toHaveBeenCalledOnce();
    expect(counts.threads.refresh).not.toHaveBeenCalled();
    const complete = vi.fn().mockResolvedValue(undefined);
    fixture.debugElement
      .query(By.css('ion-infinite-scroll'))
      .triggerEventHandler('ionInfinite', { target: { complete } });
    await fixture.whenStable();
    expect(chats.loadMore).toHaveBeenCalledOnce();
    expect(threads.loadMore).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    threads.loading.set(true);
    expect(fixture.componentInstance['loading']()).toBe(true);
  });

  it.each([ListTab.Messages, ListTab.Groups, ListTab.Friends, ListTab.Threads])(
    'refreshes the shared unread summary when pulling to refresh archived %s',
    async (tab) => {
      fixture.componentRef.setInput('selection', { tab, archived: true, requestHistory: false });
      await fixture.whenStable();
      counts.chats.refresh.mockClear();
      fixture.debugElement.query(By.css('ion-refresher')).triggerEventHandler('ionRefresh');
      expect(counts.chats.refresh).toHaveBeenCalledOnce();
      expect(counts.chats.activate).toHaveBeenCalledOnce();
    },
  );

  it('keeps archived conversations readable with only unarchive on the right, and omits read for empty chats', async () => {
    fixture.componentRef.setInput('selection', { tab: ListTab.Messages, archived: true, requestHistory: false });
    chats.items.set([{ ...testChat, archived: true, lastMessage }]);
    fixture.detectChanges();
    expect(options('start')).toHaveLength(1);
    expect(options('end').map((item) => item.nativeElement.textContent.trim())).toEqual(['取消归档']);
    options('end')[0].triggerEventHandler('click', new Event('click'));
    await fixture.whenStable();
    expect(data.setArchived).toHaveBeenCalledWith(testChat.id, false);
    chats.items.set([{ ...testChat, archived: true, lastMessage: undefined }]);
    fixture.detectChanges();
    expect(options('start')).toHaveLength(0);
    expect(conversationRow().nativeElement.querySelector('ion-label p').textContent).toContain('暂无消息');
  });

  it('hides DM mention badges in chats and threads while retaining normal unread counts', () => {
    for (const kind of [GroupKind.dm, GroupKind.group]) {
      chats.items.set([{ ...testChat, kind, unreadCount: 4, unreadMentions: 2 }]);
      chatInfo.set({ ...testChat, kind });
      threads.items.set([{ ...thread, chatKind: kind, unreadMentions: 2 }]);
      fixture.detectChanges();
      expect(fixture.componentInstance['conversationRows']()[0].entry).toMatchObject({
        unreadCount: 4,
        unreadMentions: kind === GroupKind.dm ? 0 : 2,
      });
      expect(fixture.componentInstance['threadRows']()[0].entry).toMatchObject({
        unreadCount: 3,
        unreadMentions: kind === GroupKind.dm ? 0 : 2,
      });
    }
  });

  it('uses the shared message preview rules and keeps sender names specific to group conversations', () => {
    chats.items.set([{ ...testChat, lastMessage: { ...lastMessage, message: '', messageType: MessageType.audio } }]);
    fixture.detectChanges();
    expect((conversationRow().componentInstance as ChatListItem).entry()).toMatchObject({
      title: testChat.name,
      sender: testMessage.sender.name,
    });
    expect(conversationRow().nativeElement.querySelector('ion-label p').textContent).toContain('[语音]');
    chats.items.set([
      {
        ...testChat,
        kind: GroupKind.dm,
        peer: { uid: 2, username: '小花', gender: 0 },
        lastMessage: { ...lastMessage, isDeleted: true },
      },
    ]);
    fixture.detectChanges();
    expect((conversationRow().componentInstance as ChatListItem).entry()).toMatchObject({
      title: '小花',
      sender: undefined,
    });
    expect(conversationRow().nativeElement.querySelector('ion-label p').textContent.trim()).toBe('消息已删除');
  });

  it.each([false, true])('hides delivery status when a draft replaces the preview (thread: %s)', (inThread) => {
    const own = { ...testMessage, sender: testUser, mentions: [] };
    if (inThread) {
      preferences.showThreadsInMessages.set(true);
      chats.items.set([]);
      threads.items.set([{ ...thread, chatKind: GroupKind.dm, lastReply: own, peerLastReadMessageId: own.id }]);
    } else {
      chats.items.set([{ ...testChat, kind: GroupKind.dm, lastMessage: own, peerLastReadMessageId: own.id }]);
    }
    TestBed.inject(DraftStore).save(testChat.id, inThread ? thread.threadRootMessage.id : undefined, 'not sent yet');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('not sent yet');
    expect(fixture.nativeElement.querySelector('app-message-status')).toBeNull();
    TestBed.inject(DraftStore).clear(testChat.id, inThread ? thread.threadRootMessage.id : undefined);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-message-status')).not.toBeNull();
  });

  it.each([false, true])(
    'previews forward drafts and restores the last message on removal (thread: %s)',
    (inThread) => {
      const own = { ...testMessage, sender: testUser, mentions: [], message: '已发送的消息' };
      if (inThread) {
        preferences.showThreadsInMessages.set(true);
        chats.items.set([]);
        threads.items.set([{ ...thread, lastReply: own }]);
      } else {
        chats.items.set([{ ...testChat, lastMessage: own }]);
      }
      const drafts = TestBed.inject(DraftStore);
      const threadId = inThread ? thread.threadRootMessage.id : undefined;
      const preview = () =>
        fixture.nativeElement.querySelector('app-chat-list-item[data-row-key] ion-label p').textContent;
      drafts.setForward(testChat.id, threadId, [{ ...testMessage, message: '**待转发内容**' }]);
      fixture.detectChanges();
      expect(preview()).toContain('草稿：');
      expect(preview()).toContain('待转发内容');
      expect(preview()).not.toContain('已发送的消息');
      expect(fixture.nativeElement.querySelector('app-message-status')).toBeNull();
      drafts.setForward(testChat.id, threadId, [testMessage, testMessage]);
      fixture.detectChanges();
      expect(preview()).toContain('转发 2 条消息');
      drafts.save(testChat.id, threadId, '附言');
      fixture.detectChanges();
      expect(preview()).toContain('附言');
      drafts.clear(testChat.id, threadId);
      drafts.setForward(testChat.id, threadId);
      fixture.detectChanges();
      expect(preview()).toContain('已发送的消息');
      expect(preview()).not.toContain('草稿：');
      expect(fixture.nativeElement.querySelector('app-message-status')).not.toBeNull();
    },
  );

  it('labels delivery only after my own last message and reads the DM receipt', () => {
    const own = { ...testMessage, sender: testUser, mentions: [] };
    const dm = {
      ...testChat,
      kind: GroupKind.dm,
      peer: { uid: 2, username: '小花', gender: 0 },
      lastMessage: own,
    };
    chats.items.set([dm]);
    fixture.detectChanges();
    const sent = (conversationRow().componentInstance as ChatListItem).entry();
    expect(sent.delivery).toBe(MessageDelivery.Sent);
    expect(sent.read).toBeUndefined();

    chats.items.set([{ ...dm, peerLastReadMessageId: own.id }]);
    fixture.detectChanges();
    const read = (conversationRow().componentInstance as ChatListItem).entry();
    expect(read.delivery).toBe(MessageDelivery.Sent);
    expect(read.read).toBe(true);

    chats.items.set([{ ...dm, lastMessage: { ...own, sender: { uid: 2, name: '小花', gender: 0 } } }]);
    fixture.detectChanges();
    expect((conversationRow().componentInstance as ChatListItem).entry().delivery).toBeUndefined();

    outbox.items.set([
      {
        chatId: testChat.id,
        cancelled: () => false,
        delivery: () => MessageDelivery.Sending,
        message: () => own,
      } as unknown as OutgoingMessage,
    ]);
    fixture.detectChanges();
    expect((conversationRow().componentInstance as ChatListItem).entry().delivery).toBe(MessageDelivery.Sending);
  });

  it.each([false, true])('uses the receipt for a confirmed outbox preview (thread: %s)', (inThread) => {
    const own = { ...testMessage, sender: testUser, mentions: [], createdAt: '2026-10-23T12:00:00Z' };
    if (inThread) {
      preferences.showThreadsInMessages.set(true);
      chats.items.set([]);
      threads.items.set([{ ...thread, chatKind: GroupKind.dm, peerLastReadMessageId: own.id }]);
    } else {
      chats.items.set([{ ...testChat, kind: GroupKind.dm, peerLastReadMessageId: own.id }]);
    }
    const delivery = signal(MessageDelivery.Sent);
    outbox.items.set([
      {
        chatId: testChat.id,
        threadId: inThread ? thread.threadRootMessage.id : undefined,
        cancelled: () => false,
        delivery,
        message: () => own,
      } as unknown as OutgoingMessage,
    ]);
    fixture.detectChanges();
    const status = fixture.debugElement.query(By.directive(MessageStatus)).componentInstance as MessageStatus;
    expect(status.delivery()).toBe(MessageDelivery.Sent);
    expect(status.read()).toBe(true);
    delivery.set(MessageDelivery.Sending);
    fixture.detectChanges();
    expect(status.delivery()).toBe(MessageDelivery.Sending);
    expect(status.read()).toBe(false);
  });

  it('returns a reselected conversation to its latest message', () => {
    (conversationRow().componentInstance as ChatListItem).selected.emit();
    expect(navigation.goTo).toHaveBeenCalledWith(testChat.id, { type: ConversationTargetKind.Latest });
  });

  describe('friend request rows', () => {
    beforeEach(async () => {
      chats.items.set([]);
      requests.items.set([incoming]);
      fixture.detectChanges();
      await fixture.whenStable();
    });

    function requestList() {
      return fixture.debugElement.query(By.css('ion-list'));
    }

    function button(label: string) {
      return requestList()
        .queryAll(By.directive(IonButton))
        .find(
          (item) =>
            item.nativeElement.getAttribute('title')?.startsWith(label) ||
            item.nativeElement.textContent.trim() === label,
        )!;
    }

    it.each([
      ['接受', FriendRequestAction.Accept],
      ['拒绝', FriendRequestAction.Reject],
      ['归档', FriendRequestAction.Archive],
    ] as const)('submits %s for an incoming pending request', async (label, action) => {
      expect(requestList().nativeElement.textContent).toContain('小李');
      expect(requestList().nativeElement.textContent).toContain('一起聊天吧');
      button(label).triggerEventHandler('click', new Event('click'));
      await fixture.whenStable();
      expect(inbox.decideRequest).toHaveBeenCalledWith(incoming.id, action);
    });

    it('uses shared two-line rows with the peer, verification preview and status or actions', async () => {
      history.items.set([
        { ...incoming, status: FriendRequestStatus.archived, question: '你是谁？', message: '同学' },
        {
          ...incoming,
          id: encodeId('2'),
          direction: FriendRequestDirection.outgoing,
          message: undefined,
          from: incoming.to,
          to: { uid: 3, username: '小王', gender: 0 },
        },
        { ...incoming, id: encodeId('3'), status: FriendRequestStatus.accepted },
        { ...incoming, id: encodeId('4'), status: FriendRequestStatus.rejected },
      ]);
      fixture.componentRef.setInput('selection', { ...fixture.componentInstance['list'](), requestHistory: true });
      fixture.detectChanges();
      await fixture.whenStable();
      expect(requestList().nativeElement.textContent).toContain('小王');
      expect(requestList().nativeElement.textContent).toContain('好友请求已发送');
      expect(requestList().nativeElement.textContent).toContain('等待通过');
      expect(requestList().nativeElement.textContent).toContain('问：你是谁？ · 答：同学');
      expect(requestList().nativeElement.textContent).toContain('已接受');
      expect(requestList().nativeElement.textContent).toContain('已拒绝');
      const rows = requestList().queryAll(By.directive(ChatListItem));
      expect(rows).toHaveLength(4);
      expect(fixture.nativeElement.querySelectorAll('ion-list')).toHaveLength(1);
      for (const row of rows) {
        expect(row.nativeElement.querySelector('ion-item').getAttribute('href')).toBeNull();
        expect(row.nativeElement.querySelectorAll('ion-label h3')).toHaveLength(1);
        expect(row.nativeElement.querySelectorAll('ion-label p')).toHaveLength(1);
        expect(row.nativeElement.querySelector('ion-avatar')).not.toBeNull();
        expect(row.nativeElement.querySelector('.meta')).toBeNull();
      }
      expect(
        requestList()
          .queryAll(By.directive(IonButton))
          .map((item) => item.nativeElement.getAttribute('title')),
      ).toEqual(['接受来自 小李 的好友请求', '拒绝来自 小李 的好友请求']);
      button('接受').triggerEventHandler('click', new Event('click'));
      await fixture.whenStable();
      expect(inbox.decideRequest).toHaveBeenCalledWith(incoming.id, FriendRequestAction.Accept);
    });

    it('prevents duplicate actions and allows retry after a failure', async () => {
      let rejectRequest!: (reason: Error) => void;
      inbox.decideRequest.mockImplementationOnce(
        () => new Promise<void>((_resolve, reject) => (rejectRequest = reject)),
      );
      button('接受').triggerEventHandler('click', new Event('click'));
      button('拒绝').triggerEventHandler('click', new Event('click'));
      fixture.detectChanges();
      await expect.poll(() => inbox.decideRequest.mock.calls.length).toBe(1);
      expect((button('接受').componentInstance as IonButton).disabled).toBe(true);
      rejectRequest(new Error('network failure'));
      await expect
        .poll(() => {
          fixture.detectChanges();
          return fixture.nativeElement.querySelector('ion-label[color="danger"]')?.textContent;
        })
        .toContain('操作失败');
      expect((button('接受').componentInstance as IonButton).disabled).toBe(false);
      button('接受').triggerEventHandler('click', new Event('click'));
      await fixture.whenStable();
      expect(inbox.decideRequest).toHaveBeenCalledTimes(2);
      expect(fixture.nativeElement.querySelector('ion-label[color="danger"]')).toBeNull();
    });

    it('keeps auxiliary load failures silent until the next normal update', async () => {
      counts.chats.value.set(12);
      counts.chats.error.set(true);
      requests.error.set(true);
      fixture.detectChanges();
      expect(fixture.componentInstance['archivedUnreadCount']()).toBe(12);
      expect(requestList().nativeElement.textContent).toContain('小李');
      expect(fixture.nativeElement.querySelector('ion-label[color="danger"]')).toBeNull();
      expect(fixture.nativeElement.textContent).not.toContain('重试');

      requests.items.set([]);
      fixture.detectChanges();
      expect(requestList().nativeElement.textContent).not.toContain('小李');
      expect(button('接受')).toBeUndefined();

      fixture.debugElement.query(By.css('ion-refresher')).triggerEventHandler('ionRefresh', new Event('ionRefresh'));
      expect(requests.refresh).toHaveBeenCalledOnce();
      expect(counts.chats.refresh).toHaveBeenCalledOnce();
      counts.chats.value.set(15);
      counts.chats.error.set(false);
      requests.items.set([incoming]);
      requests.error.set(false);
      fixture.detectChanges();
      expect(fixture.componentInstance['archivedUnreadCount']()).toBe(15);
      expect(requestList().nativeElement.textContent).toContain('小李');

      history.error.set(true);
      fixture.componentRef.setInput('selection', { ...fixture.componentInstance['list'](), requestHistory: true });
      await fixture.whenStable();
      expect(requestList().nativeElement.textContent).not.toContain('小李');
      expect(button('接受')).toBeUndefined();
      expect(fixture.nativeElement.querySelector('ion-label[color="danger"]')).toBeNull();
    });
  });

  describe('topic rows', () => {
    beforeEach(async () => {
      fixture.componentRef.setInput('selection', { ...fixture.componentInstance['list'](), tab: ListTab.Threads });
      threads.items.set([thread]);
      fixture.detectChanges();
      await fixture.whenStable();
    });

    function threadRow() {
      return fixture.debugElement
        .queryAll(By.directive(ChatListItem))
        .find((row) => (row.componentInstance as ChatListItem).entry().link?.includes('thread'))!;
    }

    function threadEntry() {
      return (threadRow().componentInstance as ChatListItem).entry();
    }

    it.each([GroupKind.group, GroupKind.dm])(
      'renders %s topic mentions when parent metadata is unavailable, preserving the badge when it arrives',
      async (kind) => {
        chatInfo.set(undefined);
        metadata.ensure.mockRejectedValueOnce(new Error('offline'));
        threads.items.set([{ ...thread, chatKind: kind, unreadMentions: 2, archived: true }]);
        await fixture.whenStable();
        expect(threadEntry()).toMatchObject({ unreadMentions: kind === GroupKind.group ? 2 : 0, muted: true });
        const badge = threadRow().nativeElement.querySelector('ion-badge');
        if (kind === GroupKind.group) {
          expect(badge.textContent.trim()).toBe('@');
          expect(badge.color).toBe('medium');
        } else {
          expect(threadRow().nativeElement.textContent).not.toContain('@');
        }
        chatInfo.set({ ...testChat, kind });
        await fixture.whenStable();
        expect(threadRow().nativeElement.querySelector('ion-badge')).toBe(badge);
        expect(threadEntry().unreadMentions).toBe(kind === GroupKind.group ? 2 : 0);
      },
    );

    it('loads chat metadata once per chat when several visible topics share it', async () => {
      metadata.ensure.mockClear();
      threads.items.set([
        thread,
        { ...thread, threadRootMessage: { ...thread.threadRootMessage, id: encodeId('9007199254741010') } },
      ]);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(metadata.ensure).toHaveBeenCalledExactlyOnceWith(testChat.id);
      metadata.ensure.mockClear();
      fixture.componentRef.setInput('selection', { ...fixture.componentInstance['list'](), tab: ListTab.Messages });
      threads.items.set([]);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(metadata.ensure).not.toHaveBeenCalled();
    });

    it('uses the shared two-line row with group avatar and root author badge even with two participants', () => {
      const entry = threadEntry();
      expect(entry).toMatchObject({
        sender: '小花',
        avatar: 'https://example.com/group.jpg',
        badgeAvatar: 'https://example.com/root-author.jpg',
        badgeName: '发起人',
        time: testMessage.createdAt,
        unreadCount: 3,
        link: ['/chats/chat', decodeId(testChat.id), 'thread', decodeId(testMessage.id)],
      });
      expect(entry.badgeIcon).toBeUndefined();
      const element: HTMLElement = threadRow().nativeElement;
      expect(element.querySelector('ion-item')?.getAttribute('href')).toBe(
        '/chats/chat/9007199254740993/thread/9007199254741003',
      );
      expect(fixture.nativeElement.querySelectorAll('app-thread-list-item')).toHaveLength(0);
      expect(element.querySelectorAll('ion-label h3')).toHaveLength(1);
      expect(element.querySelectorAll('ion-label p')).toHaveLength(1);
      expect(element.querySelector('ion-label h3')?.textContent?.trim()).toBe('话题开头');
      expect(element.querySelector('ion-label p')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('小花: 最新回复');
      expect(element.querySelector('app-chat-avatar > ion-avatar img')?.getAttribute('src')).toBe(entry.avatar);
      expect(element.querySelector('.avatar-badge img')?.getAttribute('src')).toBe(entry.badgeAvatar);
    });

    it('uses the verified DM peer avatar and topic icon without a sender prefix', () => {
      threads.items.set([{ ...thread, chatKind: GroupKind.dm }]);
      chatInfo.set({
        ...testChat,
        kind: GroupKind.dm,
        peer: { uid: 2, username: '小花', gender: 0, avatarUrl: 'https://example.com/peer.jpg' },
      });
      fixture.detectChanges();
      expect(threadEntry()).toMatchObject({
        avatarName: '小花',
        avatar: 'https://example.com/peer.jpg',
        badgeIcon: chatbubbles,
        sender: undefined,
      });
      expect(threadEntry().badgeAvatar).toBeUndefined();
      const element: HTMLElement = threadRow().nativeElement;
      expect(element.querySelector('ion-label p')?.textContent?.trim()).toBe('最新回复');
      expect(element.querySelector('.avatar-badge ion-icon')).not.toBeNull();
      chatInfo.set({ ...testChat, kind: GroupKind.dm, peer: undefined });
      fixture.detectChanges();
      expect(threadEntry().avatar).toBe('https://example.com/participant.jpg');
    });

    it('uses the supplied group kind before metadata arrives and formats non-text or deleted previews', () => {
      chatInfo.set(undefined);
      threads.items.set([
        {
          ...thread,
          threadRootMessage: { ...thread.threadRootMessage, isDeleted: true },
          lastReply: { ...thread.lastReply!, message: '', messageType: MessageType.audio },
        },
      ]);
      fixture.detectChanges();
      expect(threadEntry()).toMatchObject({
        avatar: thread.chatAvatar,
        sender: '小花',
      });
      expect(threadEntry().badgeIcon).toBeUndefined();
      expect(threadEntry().badgeAvatar).toBe(thread.threadRootMessage.sender.avatarUrl);
      expect(threadRow().nativeElement.querySelector('ion-label h3').textContent.trim()).toBe('消息已删除');
      expect(threadRow().nativeElement.querySelector('ion-label p').textContent.replace(/\s+/g, ' ').trim()).toBe(
        '小花: [语音]',
      );
    });

    it('offers mark-read only for unread topics and sends the latest reply or root ID', async () => {
      const shared = threadRow().componentInstance as ChatListItem;
      expect(shared.startActions()?.map((action) => action.label)).toEqual(['标为已读']);
      expect(shared.endActions()?.map((action) => action.label)).toEqual(['归档']);
      await shared['perform'](shared.startActions()![0], new Event('click'));
      expect(inbox.markThreadRead).toHaveBeenCalledWith(testChat.id, testMessage.id, thread.lastReply!.id);
      threads.items.set([{ ...thread, lastReply: undefined }]);
      fixture.detectChanges();
      await shared['perform'](shared.startActions()![0], new Event('click'));
      expect(inbox.markThreadRead).toHaveBeenLastCalledWith(testChat.id, testMessage.id, testMessage.id);
      threads.items.set([{ ...thread, unreadCount: 0 }]);
      fixture.detectChanges();
      expect(shared.startActions()).toEqual([]);
      expect(fixture.nativeElement.querySelector('ion-item-options[side="start"]')).toBeNull();
      expect(shared.endActions()?.map((action) => action.label)).toEqual(['归档']);
    });

    it('keeps reselect and archive scoped to this topic while the shared row handles failures', async () => {
      const shared = threadRow().componentInstance as ChatListItem;
      const navigate = vi.spyOn(TestBed.inject(ConversationNavigation), 'goTo');
      shared.selected.emit();
      expect(navigate).toHaveBeenCalledWith(testChat.id, { type: ConversationTargetKind.Latest }, testMessage.id);
      await shared['perform'](shared.endActions()![0], new Event('click'));
      expect(inbox.setThreadArchived).toHaveBeenCalledWith(testChat.id, testMessage.id, true);
      threads.items.set([{ ...thread, archived: true }]);
      fixture.detectChanges();
      expect(shared.endActions()?.map((action) => action.label)).toEqual(['取消归档']);
      await shared['perform'](shared.endActions()![0], new Event('click'));
      expect(inbox.setThreadArchived).toHaveBeenLastCalledWith(testChat.id, testMessage.id, false);
      inbox.setThreadArchived.mockRejectedValue(new Error('unavailable'));
      await shared['perform'](shared.endActions()![0], new Event('click'));
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelector('ion-label[color="danger"]').textContent).toContain('操作失败');
    });
  });

  it('previews pending thread replies in an inactive mixed list without changing the parent chat', async () => {
    preferences.showThreadsInMessages.set(true);
    chats.items.set([{ ...testChat, lastMessageAt: '2026-09-05T12:10:00Z', lastMessage }]);
    threads.items.set([thread]);
    await fixture.whenStable();
    fixture.componentRef.setInput('active', false);
    await fixture.whenStable();
    const pending = { ...testMessage, createdAt: '2026-09-05T12:30:00Z', message: '待发话题回复' };
    outbox.items.set([
      {
        chatId: testChat.id,
        threadId: thread.threadRootMessage.id,
        cancelled: () => false,
        delivery: () => MessageDelivery.Sending,
        message: () => pending,
      } as unknown as OutgoingMessage,
    ]);
    fixture.detectChanges();
    expect(fixture.componentInstance['rows']().map((row) => row.key)).toEqual([
      thread.threadRootMessage.id,
      testChat.id,
    ]);
    expect(fixture.componentInstance['threadRows']()[0].preview?.message).toBe('待发话题回复');
    expect(fixture.componentInstance['threadRows']()[0].entry.time).toBe(pending.createdAt);
    expect(fixture.componentInstance['conversationRows']()[0].preview).toBe(lastMessage);
    expect(fixture.nativeElement.textContent).toContain('待发话题回复');
    expect(threads.refresh).not.toHaveBeenCalled();
  });

  it('lifts a row and previews a submitted message before the summary echoes it', () => {
    const otherId = encodeId('9007199254741999');
    chats.items.set([
      { ...testChat, id: otherId, lastMessageAt: '2026-09-05T12:00:00Z', lastMessage },
      { ...testChat, lastMessageAt: '2026-09-05T11:00:00Z', lastMessage },
    ]);
    const pending = {
      ...testMessage,
      createdAt: '2026-09-05T12:30:00Z',
      message: '刚发出的消息',
    };
    outbox.items.set([
      {
        chatId: testChat.id,
        cancelled: () => false,
        delivery: () => MessageDelivery.Sending,
        message: () => pending,
      } as unknown as OutgoingMessage,
    ]);
    fixture.detectChanges();
    const rows = fixture.componentInstance['rows']();
    expect(rows.map((row) => row.key)).toEqual([testChat.id, otherId]);
    const updated = fixture.componentInstance['conversationRows']().find((row) => row.key === testChat.id)!;
    expect(updated.preview?.message).toBe('刚发出的消息');
    expect(fixture.nativeElement.textContent).toContain('刚发出的消息');
  });
});
