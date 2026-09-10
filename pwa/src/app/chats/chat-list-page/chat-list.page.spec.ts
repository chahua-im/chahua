import { Component, input, output, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { beforeAll, afterAll, vi } from 'vitest';
import { Connection } from '../../api/connection';
import { mockRealtime } from '../../api/testing';
import { routes } from '../../app.routes';
import { PushNotifications } from '../../pwa/push-notifications';
import { SessionStore } from '../../session/session-store';
import { Preferences } from '../../settings/preferences';
import { ChatListStore } from '../chat-list-store';
import { ChatListContent } from '../chat-list-content/chat-list-content';
import { ChatList } from '../chat-list/chat-list';
import { ChatStore } from '../chat-store';
import { ListTab, type ListSelection } from '../list-tabs';
import { ChatListPage } from './chat-list.page';

beforeAll(() => {
  Element.prototype.scrollTo = vi.fn();
});
afterAll(() => Reflect.deleteProperty(Element.prototype, 'scrollTo'));

beforeEach(() => vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false })));
afterEach(() => vi.unstubAllGlobals());

@Component({ selector: 'app-chat-list', template: '' })
class ListStub {
  readonly active = input(true);
  readonly selection = input();
  readonly openList = output<ListSelection>();
}

describe('ChatListPage', () => {
  it('passes route selection to the list with false defaults for missing flags', async () => {
    await TestBed.configureTestingModule({
      imports: [ChatListPage],
      providers: [
        { provide: Connection, useValue: mockRealtime() },
        provideRouter(routes, withComponentInputBinding()),
      ],
    })
      .overrideComponent(ChatListPage, { remove: { imports: [ChatList] }, add: { imports: [ListStub] } })
      .compileComponents();
    const harness = await RouterTestingHarness.create();
    for (const [url, selection] of [
      ['/chats', { tab: ListTab.Messages, archived: false, requestHistory: false }],
      ['/chats/threads', { tab: ListTab.Threads, archived: false, requestHistory: false }],
      ['/chats/groups', { tab: ListTab.Groups, archived: false, requestHistory: false }],
      ['/chats/groups/archived', { tab: ListTab.Groups, archived: true, requestHistory: false }],
      ['/chats/friends/archived-requests', { tab: ListTab.Friends, archived: false, requestHistory: true }],
    ] as const) {
      const page = await harness.navigateByUrl(url, ChatListPage);
      expect(page['selection']()).toEqual(selection);
    }
  });
  it('reads current child selection even when Ionic retains an older route snapshot', async () => {
    const proxy = { snapshot: {} as ActivatedRoute['snapshot'] };
    await TestBed.configureTestingModule({
      imports: [ChatListPage],
      providers: [provideRouter(routes), { provide: ActivatedRoute, useValue: proxy }],
    })
      .overrideComponent(ChatListPage, { set: { template: '' } })
      .compileComponents();
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/chats/groups');
    proxy.snapshot = router.routerState.snapshot.root.firstChild!;
    const fixture = TestBed.createComponent(ChatListPage);
    await fixture.whenStable();
    expect(fixture.componentInstance['selection']().tab).toBe(ListTab.Groups);
    await router.navigateByUrl('/chats/friends');
    await fixture.whenStable();
    expect(fixture.componentInstance['selection']().tab).toBe(ListTab.Friends);
    await router.navigateByUrl('/chats/groups');
    await fixture.whenStable();
    expect(fixture.componentInstance['selection']().tab).toBe(ListTab.Groups);
    await router.navigateByUrl('/chats/friends/archived-requests');
    await fixture.whenStable();
    expect(fixture.componentInstance['selection']()).toEqual({
      tab: ListTab.Groups,
      archived: false,
      requestHistory: false,
    });
  });

  it('creates the mobile list only while the viewport is narrow', async () => {
    const media = Object.assign(new EventTarget(), { matches: true });
    vi.stubGlobal('matchMedia', () => media);
    await TestBed.configureTestingModule({ imports: [ChatListPage] })
      .overrideComponent(ChatListPage, { remove: { imports: [ChatList] }, add: { imports: [ListStub] } })
      .compileComponents();
    const fixture = TestBed.createComponent(ChatListPage);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-chat-list')).toBeNull();
    media.dispatchEvent(Object.assign(new Event('change'), { matches: false }));
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-chat-list')).not.toBeNull();
    media.dispatchEvent(Object.assign(new Event('change'), { matches: true }));
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-chat-list')).toBeNull();
  });

  it('places the mobile list alongside the desktop conversation placeholder', async () => {
    await TestBed.configureTestingModule({ imports: [ChatListPage] })
      .overrideComponent(ChatListPage, { remove: { imports: [ChatList] }, add: { imports: [ListStub] } })
      .compileComponents();
    const fixture = TestBed.createComponent(ChatListPage);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('app-chat-list')).not.toBeNull();
    expect(element.querySelector(':scope > ion-content, :scope > ion-header')).toBeNull();
    expect(element.querySelector('ion-content')?.parentElement?.classList.contains('ion-hide-md-down')).toBe(true);
    expect(element.textContent).toContain('从左侧选择一个会话');
  });
});

// Cached Ionic pages are detached instead of destroyed, so leaving must release their query consumers.
describe('ChatListPage query lifecycle', () => {
  it('releases queries from a detached page and reactivates them on return', async () => {
    const release = vi.fn();
    const query = {
      items: signal([]),
      loading: signal(false),
      error: signal(false),
      activate: vi.fn(() => release),
    };
    await TestBed.configureTestingModule({
      imports: [ChatListPage],
      providers: [
        { provide: Connection, useValue: mockRealtime() },
        provideRouter([]),
        { provide: PushNotifications, useValue: { requestSettingsPermission: vi.fn() } },
        {
          provide: ChatListStore,
          useValue: {
            chats: () => query,
            friendRequests: () => query,
            threads: () => query,
            archivedUnread: { chats: query, threads: query },
          },
        },
        { provide: ChatStore, useValue: {} },
        { provide: SessionStore, useValue: { user: signal(undefined) } },
        { provide: Preferences, useValue: { showThreadsInMessages: () => true } },
      ],
    })
      .overrideComponent(ChatListContent, { set: { template: '' } })
      .compileComponents();
    const fixture = TestBed.createComponent(ChatListPage);
    await fixture.whenStable();
    expect(query.activate).toHaveBeenCalledTimes(5);
    fixture.componentRef.changeDetectorRef.detach();
    fixture.componentInstance.ionViewDidLeave();
    expect(release).toHaveBeenCalledTimes(5);
    fixture.componentRef.changeDetectorRef.reattach();
    fixture.componentInstance.ionViewDidEnter();
    await fixture.whenStable();
    expect(query.activate).toHaveBeenCalledTimes(10);
    fixture.destroy();
    expect(release).toHaveBeenCalledTimes(10);
  });
});
