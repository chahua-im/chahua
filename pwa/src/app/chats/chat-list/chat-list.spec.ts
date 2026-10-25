import { Component, input, output, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
import { NavController } from '@ionic/angular';
import { beforeAll, afterAll, vi } from 'vitest';
import { Connection } from '../../api/connection';
import { encodeId } from '../../api/snowflake-id';
import { mockRealtime, testChat, testUser } from '../../api/testing';
import WaveSurfer from 'wavesurfer.js';
import { VoicePlayback, type VoiceDock } from '../../messages/voice-player/voice-playback';
import { VoicePlayer } from '../../messages/voice-player/voice-player';
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
  const summaries = signal<
    Record<
      string,
      {
        unreadConversationCount: number;
        unreadUnmutedConversationCount: number;
        unreadAttentionCount: number;
        unreadUnmutedAttentionCount: number;
      }
    >
  >({});
  beforeEach(async () => {
    summaries.set({
      messages: {
        unreadConversationCount: 12,
        unreadUnmutedConversationCount: 2,
        unreadAttentionCount: 0,
        unreadUnmutedAttentionCount: 0,
      },
      'messages-with-threads': {
        unreadConversationCount: 15,
        unreadUnmutedConversationCount: 5,
        unreadAttentionCount: 0,
        unreadUnmutedAttentionCount: 0,
      },
      threads: {
        unreadConversationCount: 13,
        unreadUnmutedConversationCount: 3,
        unreadAttentionCount: 0,
        unreadUnmutedAttentionCount: 0,
      },
    });
    vi.stubGlobal('matchMedia', (query: string) =>
      Object.assign(new EventTarget(), { matches: query === '(prefers-reduced-motion: reduce)' }),
    );
    await TestBed.configureTestingModule({
      imports: [ChatList],
      providers: [
        {
          provide: ChatListStore,
          useValue: {
            selection: signal({ tab: ListTab.Messages, archived: false, requestHistory: false }),
            summary: (view: { key: string }) => summaries()[view.key],
            tabBadges: (showThreads: boolean) => {
              const badge = (key: string) => {
                const summary = summaries()[key];
                return {
                  count: summary?.unreadUnmutedConversationCount ?? 0,
                  mention: !!summary?.unreadUnmutedAttentionCount,
                };
              };
              return {
                messages: badge(showThreads ? 'messages-with-threads' : 'messages'),
                groups: badge('groups'),
                friends: badge('friends'),
                threads: badge('threads'),
              };
            },
            viewUnread: { activate: vi.fn(() => vi.fn()) },
            unread: { value: signal({ unreadChatCount: 2 }), activate: vi.fn(() => vi.fn()) },
            threadUnread: { value: signal({ unreadThreadCount: 3 }), activate: vi.fn(() => vi.fn()) },
            chats: () => ({ items: signal([]) }),
            threads: () => ({ items: signal([]) }),
          },
        },
        { provide: Preferences, useValue: { showThreadsInMessages: signal(true), showMembershipMessages: () => true } },
        provideRouter([{ path: 'chats/chat/:id', children: [] }]),
        { provide: Connection, useValue: mockRealtime() },
        {
          provide: SessionStore,
          useValue: {
            requireChatSettings: SessionStore.prototype.requireChatSettings,
            acceptChatSettings: SessionStore.prototype.acceptChatSettings,
            user: signal(testUser),
          },
        },
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

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    TestBed.inject(VoicePlayback).active.set(undefined);
  });

  it('uses complete mention categories even when none of their rows are loaded', () => {
    summaries.set({
      'messages-with-threads': {
        unreadConversationCount: 11,
        unreadUnmutedConversationCount: 1,
        unreadAttentionCount: 1,
        unreadUnmutedAttentionCount: 1,
      },
      groups: {
        unreadConversationCount: 11,
        unreadUnmutedConversationCount: 1,
        unreadAttentionCount: 1,
        unreadUnmutedAttentionCount: 1,
      },
      threads: {
        unreadConversationCount: 11,
        unreadUnmutedConversationCount: 1,
        unreadAttentionCount: 1,
        unreadUnmutedAttentionCount: 1,
      },
    });
    fixture.componentRef.setInput('selection', { tab: ListTab.Messages, archived: false, requestHistory: false });
    fixture.detectChanges();
    expect(fixture.componentInstance['tabBadges']()).toEqual({
      messages: { count: 1, mention: true },
      groups: { count: 1, mention: true },
      friends: { count: 0, mention: false },
      threads: { count: 1, mention: true },
    });
  });

  it('excludes muted conversations from every tab and prioritizes unmuted attention', async () => {
    summaries.set({
      'messages-with-threads': {
        unreadConversationCount: 14,
        unreadUnmutedConversationCount: 4,
        unreadAttentionCount: 9,
        unreadUnmutedAttentionCount: 0,
      },
      groups: {
        unreadConversationCount: 13,
        unreadUnmutedConversationCount: 3,
        unreadAttentionCount: 7,
        unreadUnmutedAttentionCount: 0,
      },
      friends: {
        unreadConversationCount: 12,
        unreadUnmutedConversationCount: 2,
        unreadAttentionCount: 0,
        unreadUnmutedAttentionCount: 0,
      },
      threads: {
        unreadConversationCount: 11,
        unreadUnmutedConversationCount: 1,
        unreadAttentionCount: 2,
        unreadUnmutedAttentionCount: 0,
      },
    });
    await fixture.whenStable();
    expect(
      [...fixture.nativeElement.querySelectorAll('ion-segment ion-badge')].map((node) =>
        (node as HTMLElement).textContent?.trim(),
      ),
    ).toEqual(['4', '3', '2', '1']);
    expect(Object.values(fixture.componentInstance['tabBadges']()).map((badge) => badge.mention)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(fixture.componentInstance['tabBadges']().messages.count).toBe(4);
    summaries.update((value) => ({ ...value, groups: { ...value['groups'], unreadUnmutedAttentionCount: 1 } }));
    await fixture.whenStable();
    expect(fixture.componentInstance['tabBadges']().groups.mention).toBe(true);
    expect(
      [...fixture.nativeElement.querySelectorAll('ion-segment ion-badge')].map((node) =>
        (node as HTMLElement).textContent?.trim(),
      ),
    ).toEqual(['4', '@', '2', '1']);
    summaries.update((value) =>
      Object.fromEntries(
        Object.entries(value).map(([key, summary]) => [
          key,
          { ...summary, unreadUnmutedConversationCount: 0, unreadUnmutedAttentionCount: 0 },
        ]),
      ),
    );
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('ion-segment ion-badge')).toHaveLength(0);
  });

  it('shows the playing voice bar in the header and releases it on dismissal', () => {
    vi.stubGlobal(
      'Audio',
      class {
        preload = 'none';
        play = vi.fn(async () => {});
        pause = vi.fn();
        addEventListener = () => {};
        removeEventListener = () => {};
        removeAttribute = () => {};
      },
    );
    vi.spyOn(WaveSurfer, 'create').mockReturnValue({
      on: () => {},
      load: () => Promise.resolve(),
      destroy: () => {},
    } as unknown as WaveSurfer);
    const dock: VoiceDock = {
      messageId: encodeId('9007199254741003'),
      chatId: testChat.id,
      label: '张三',
      createdAt: '2026-10-16T10:00:00Z',
    };
    const player = TestBed.createComponent(VoicePlayer);
    player.componentRef.setInput('src', '/voice.ogg');
    player.componentRef.setInput('dock', dock);
    player.detectChanges();
    expect(fixture.nativeElement.querySelector('.voice-bar')).toBeNull();
    player.componentInstance.toggle();
    fixture.detectChanges();
    const bar: HTMLElement = fixture.nativeElement.querySelector('.voice-bar');
    expect(bar).not.toBeNull();
    expect(bar.querySelector('.voice-name')?.textContent).toBe('张三');
    (bar.querySelector('ion-button') as HTMLElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.voice-bar')).toBeNull();
    expect(TestBed.inject(VoicePlayback).active()).toBeUndefined();
  });

  it('hides the voice bar for the desktop sidebar instance', () => {
    vi.stubGlobal(
      'Audio',
      class {
        preload = 'none';
        play = vi.fn(async () => {});
        pause = vi.fn();
        addEventListener = () => {};
        removeEventListener = () => {};
        removeAttribute = () => {};
      },
    );
    vi.spyOn(WaveSurfer, 'create').mockReturnValue({
      on: () => {},
      load: () => Promise.resolve(),
      destroy: () => {},
    } as unknown as WaveSurfer);
    const player = TestBed.createComponent(VoicePlayer);
    player.componentRef.setInput('src', '/voice.ogg');
    player.componentRef.setInput('dock', {
      messageId: encodeId('9007199254741003'),
      chatId: testChat.id,
      label: '张三',
      createdAt: '2026-10-16T10:00:00Z',
    });
    player.detectChanges();
    player.componentInstance.toggle();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.voice-bar')).not.toBeNull();
    fixture.componentRef.setInput('sidebar', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.voice-bar')).toBeNull();
  });

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

  it('publishes only the active list selection, retaining it while a conversation is open', async () => {
    const selected = TestBed.inject(ChatListStore).selection;
    fixture.componentRef.setInput('selection', { tab: ListTab.Friends, archived: false, requestHistory: false });
    await fixture.whenStable();
    expect(selected().tab).toBe(ListTab.Friends);
    fixture.componentRef.setInput('active', false);
    fixture.componentRef.setInput('selection', { tab: ListTab.Threads, archived: false, requestHistory: false });
    await fixture.whenStable();
    expect(selected().tab).toBe(ListTab.Friends);
    fixture.componentRef.setInput('active', true);
    await fixture.whenStable();
    expect(selected().tab).toBe(ListTab.Threads);
  });

  it('opens the avatar menu without navigating or requesting notification permission', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    const menu = fixture.nativeElement.querySelectorAll('ion-popover')[1];
    const present = vi.spyOn(menu, 'present').mockResolvedValue(undefined);
    fixture.debugElement
      .query(By.css('ion-buttons[slot="start"] ion-button'))
      .triggerEventHandler('click', new MouseEvent('click'));
    expect(present).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
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
      expect(back.text).toBeUndefined();
      back.click();
      await fixture.whenStable();
      expect(opened).toHaveBeenLastCalledWith(normal);
      expect(navigateBack).not.toHaveBeenCalled();
      expect(router.url).toBe('/chats/chat/123');
    }
  });
});
