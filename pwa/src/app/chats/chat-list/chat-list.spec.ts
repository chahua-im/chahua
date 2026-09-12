import { Component, input, output, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
import { IonPopover, NavController } from '@ionic/angular';
import { beforeAll, afterAll, vi } from 'vitest';
import { Connection } from '../../api/connection';
import { mockRealtime, testUser } from '../../api/testing';
import { PushNotifications } from '../../pwa/push-notifications';
import { SessionStore } from '../../session/session-store';
import { ChatListContent } from '../chat-list-content/chat-list-content';
import { ListTab, type ListSelection } from '../list-tabs';
import { ChatListStore } from '../chat-list-store';
import { Preferences } from '../../settings/preferences';
import { ChatList } from './chat-list';

beforeAll(() => {
  Element.prototype.scrollTo = vi.fn();
});
afterAll(() => Reflect.deleteProperty(Element.prototype, 'scrollTo'));

@Component({ selector: 'app-chat-list-content', template: '' })
class ContentStub {
  readonly selection = input.required<ListSelection>();
  readonly active = input(true);
  readonly openList = output<ListSelection>();
}

describe('ChatList', () => {
  let fixture: ComponentFixture<ChatList>;
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatList],
      providers: [
        {
          provide: ChatListStore,
          useValue: {
            unread: { value: signal({ unreadChatCount: 2 }), activate: vi.fn(() => vi.fn()) },
            threadUnread: { value: signal({ unreadThreadCount: 3 }), activate: vi.fn(() => vi.fn()) },
          },
        },
        { provide: Preferences, useValue: { showThreadsInMessages: signal(true) } },
        provideRouter([{ path: 'chats/chat/:id', children: [] }]),
        { provide: Connection, useValue: mockRealtime() },
        { provide: PushNotifications, useValue: { requestSettingsPermission: vi.fn() } },
        { provide: SessionStore, useValue: { user: signal(testUser) } },
      ],
    })
      .overrideComponent(ChatList, {
        remove: { imports: [ChatListContent] },
        add: { imports: [ContentStub] },
      })
      .compileComponents();
    fixture = TestBed.createComponent(ChatList);
    fixture.componentRef.setInput('selection', { tab: ListTab.Messages, archived: false, requestHistory: false });
    await fixture.whenStable();
  });

  afterEach(() => vi.restoreAllMocks());

  it('shows authoritative chat and thread counts and follows the thread display preference', async () => {
    const badges = () =>
      [...fixture.nativeElement.querySelectorAll('ion-segment ion-badge')].map((node) =>
        (node as HTMLElement).textContent?.trim(),
      );
    expect(badges()).toEqual(['5', '3']);
    const preferences = TestBed.inject(Preferences);
    (preferences.showThreadsInMessages as ReturnType<typeof signal<boolean>>).set(false);
    await fixture.whenStable();
    expect(badges()).toEqual(['2', '3']);
  });

  it('requests settings permission in the avatar click before navigation', () => {
    const notifications = TestBed.inject(PushNotifications);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockImplementation(async () => {
      expect(notifications.requestSettingsPermission).toHaveBeenCalledOnce();
      return true;
    });
    fixture.debugElement.query(By.css('ion-buttons[slot="start"] ion-button')).triggerEventHandler('click');
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate.mock.calls[0][1]).toEqual({ browserUrl: '/settings', state: { settingsEntry: true } });
  });

  it('keeps the add menu available while its icon indicates a pending connection', async () => {
    const connection = TestBed.inject(Connection);
    connection.connected.set(false);
    await fixture.whenStable();
    const button = fixture.debugElement.query(By.css('ion-toolbar ion-buttons[slot="end"] ion-button'));
    const popover = fixture.debugElement.query(By.directive(IonPopover)).componentInstance as IonPopover;
    const present = vi.spyOn(popover, 'present').mockResolvedValue();
    expect(fixture.nativeElement.querySelector('ion-toolbar > ion-spinner')).toBeNull();
    expect(button.nativeElement.querySelector('ion-spinner')).not.toBeNull();
    expect(button.componentInstance.disabled).toBe(false);
    const event = new MouseEvent('click');
    button.triggerEventHandler('click', event);
    expect(present).toHaveBeenCalledWith(event);
    connection.connected.set(true);
    await fixture.whenStable();
    expect(button.nativeElement.querySelector('ion-spinner')).toBeNull();
    expect(button.nativeElement.querySelector('ion-icon')).not.toBeNull();
  });

  it('connects native segment buttons to distinct contents in each list instance', async () => {
    const second = TestBed.createComponent(ChatList);
    second.componentRef.setInput('selection', { tab: ListTab.Groups, archived: false, requestHistory: false });
    await second.whenStable();
    const ids: string[] = [];
    for (const instance of [fixture, second]) {
      const element: HTMLElement = instance.nativeElement;
      const views = element.querySelectorAll('ion-segment-view');
      expect(views.length).toBe(1);
      for (const button of element.querySelectorAll('ion-segment-button')) {
        const content = views[0].querySelector(`[id="${button.contentId}"]`);
        expect(content).not.toBeNull();
        ids.push(button.contentId!);
      }
    }
    expect(new Set(ids).size).toBe(8);
    second.destroy();
  });

  it('activates only the selected content and delegates selection without changing the conversation route', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/chats/chat/123');
    const opened = vi.fn();
    fixture.componentInstance.openList.subscribe(opened);
    const contents = fixture.debugElement
      .queryAll(By.directive(ContentStub))
      .map((item) => item.componentInstance as ContentStub);
    const activeTabs = () => contents.filter((content) => content.active()).map((content) => content.selection().tab);
    expect(activeTabs()).toEqual([ListTab.Messages]);
    const segment: HTMLIonSegmentElement = fixture.nativeElement.querySelector('ion-segment');
    segment.dispatchEvent(new CustomEvent('ionChange', { detail: { value: ListTab.Friends } }));
    const friends = { tab: ListTab.Friends, archived: false, requestHistory: false };
    expect(opened).toHaveBeenCalledExactlyOnceWith(friends);
    expect(fixture.componentInstance.selection().tab).toBe(ListTab.Messages);
    fixture.componentRef.setInput('selection', friends);
    await fixture.whenStable();
    expect(activeTabs()).toEqual([ListTab.Friends]);
    expect(fixture.nativeElement.querySelector('ion-segment')).toBe(segment);
    fixture.componentRef.setInput('active', false);
    await fixture.whenStable();
    expect(activeTabs()).toEqual([]);
    expect(router.url).toBe('/chats/chat/123');
  });

  it('returns from archived chats or request history in the sidebar without navigating away from the conversation', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/chats/chat/123');
    const navigateBack = vi.spyOn(TestBed.inject(NavController), 'navigateBack');
    const opened = vi.fn();
    fixture.componentInstance.openList.subscribe(opened);
    const normal = { tab: ListTab.Friends, archived: false, requestHistory: false };
    for (const selection of [
      { ...normal, archived: true },
      { ...normal, requestHistory: true },
    ]) {
      fixture.componentRef.setInput('selection', selection);
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelector('ion-segment-view')).toBeNull();
      const contents = fixture.debugElement.queryAll(By.directive(ContentStub));
      expect(contents.length).toBe(1);
      expect(contents[0].componentInstance.selection()).toEqual(selection);
      const back: HTMLIonBackButtonElement = fixture.nativeElement.querySelector('ion-back-button');
      expect(back.text).toBe('返回');
      back.click();
      await fixture.whenStable();
      expect(opened).toHaveBeenLastCalledWith(normal);
      expect(navigateBack).not.toHaveBeenCalled();
      expect(router.url).toBe('/chats/chat/123');
    }
  });
});
