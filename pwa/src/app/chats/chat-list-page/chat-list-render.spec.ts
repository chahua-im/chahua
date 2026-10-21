import { ListTab } from '../list-tabs';
import { ChangeDetectorRef, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { vi } from 'vitest';
import { Connection } from '../../api/connection';
import { encodeId } from '../../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser } from '../../api/testing';
import { MessageOutbox } from '../../messages/message-outbox';
import { PushNotifications } from '../../pwa/push-notifications';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { ChatListStore } from '../chat-list-store';
import { ChatStore } from '../chat-store';
import { ChatListPage } from './chat-list.page';

@Component({ template: '<app-chats />', imports: [ChatListPage] })
class Host {}

it('flushes the real cached list hierarchy before returning, without activating queries', async () => {
  vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
  Element.prototype.scrollTo = vi.fn();
  const message = { ...testMessage, mentions: [], message: 'old preview' };
  const older = { ...testChat, lastMessage: message, lastMessageAt: message.createdAt };
  const newer = { ...older, id: encodeId('9007199254740994'), lastMessageAt: '2026-09-06T12:00:00Z' };
  const chats = signal([newer, older]);
  const activate = vi.fn(() => () => {});
  const common = {
    loading: signal(false),
    loadingMore: signal(false),
    hasMore: signal(false),
    loadedThrough: signal(-Infinity),
    error: signal(undefined),
    activate,
  };
  const query = { ...common, items: chats };
  const empty = { ...common, items: signal([]) };
  const count = { ...common, value: signal(0) };
  try {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        { provide: Connection, useValue: mockRealtime() },
        { provide: PushNotifications, useValue: {} },
        { provide: MessageOutbox, useValue: { items: signal([]) } },
        { provide: SessionStore, useValue: { user: signal(testUser) } },
        { provide: Preferences, useValue: { showThreadsInMessages: signal(false), showAllAvatars: signal(false) } },
        { provide: ChatStore, useValue: { isMuted: () => false } },
        {
          provide: ChatListStore,
          useValue: {
            chats: () => query,
            threads: () => empty,
            friendRequests: () => empty,
            unread: count,
            selection: signal({ tab: ListTab.Messages, archived: false, requestHistory: false }),
            summary: () => undefined,
            viewUnread: { activate: () => () => {}, refresh: vi.fn() },
            threadUnread: count,
            archivedUnread: { chats: count, threads: count },
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const page = fixture.debugElement.query(By.directive(ChatListPage));
    const detector = page.injector.get(ChangeDetectorRef);
    const instance = page.componentInstance as ChatListPage;
    const rows = () =>
      Array.from(fixture.nativeElement.querySelectorAll('[data-tab="messages"] [data-row-key]')) as HTMLElement[];
    const originalNodes = rows();
    expect(originalNodes.map((row) => row.dataset['rowKey'])).toEqual([String(newer.id), String(older.id)]);
    detector.detach();
    instance.ionViewDidLeave();
    activate.mockClear();
    chats.set([
      newer,
      {
        ...older,
        lastMessageAt: '2026-09-07T12:00:00Z',
        lastMessage: {
          ...message,
          createdAt: '2026-09-07T12:00:00Z',
          message: 'new preview',
        },
      },
    ]);
    await fixture.whenStable();
    expect(rows()[1].textContent).toContain('old preview');
    detector.reattach();
    instance.ionViewWillEnter();
    expect(rows()[0]).toBe(originalNodes[1]);
    expect(rows()[0].textContent).toContain('new preview');
    expect(activate).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(Element.prototype, 'scrollTo');
  }
});
