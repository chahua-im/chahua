import { computed, signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { TranslocoService } from '@jsverse/transloco';
import { ChatPicker } from '../../chats/chat-picker/chat-picker';
import { TestBed } from '@angular/core/testing';
import { AlertController, ToastController } from '@ionic/angular';
import { chatbubbles } from 'ionicons/icons';
import { of, Subject } from 'rxjs';
import { vi } from 'vitest';
import { GroupKind, ServerWsMessageType, type ServerWsMessage } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { RpcApi } from '../../../generated/rpc-api';
import type { MessageResponse } from '../../../generated/models';
import { mockRealtime, testChat, testMessage } from '../../api/testing';
import { encodeId } from '../../api/snowflake-id';
import { ChatListError, ChatListStore } from '../../chats/chat-list-store';
import { MessageOutbox } from '../message-outbox';
import { ChatStore } from '../../chats/chat-store';
import { SessionStore } from '../../session/session-store';
import { ForwardPicker } from './forward-picker';
import { ForwardPanel } from '../forward-panel/forward-panel';
import { ForwardSelectionError, type ForwardSource, type ForwardTopic } from '../forwarding';

function query<T>(items: T[]) {
  const release = vi.fn();
  const error = signal<ChatListError | undefined>(undefined);
  return {
    items: signal(items),
    loading: signal(false),
    loadingMore: signal(false),
    error,
    listError: computed(() => (error() === ChatListError.Unread ? undefined : error())),
    hasMore: signal(false),
    loadedThrough: signal(-Infinity),
    loadMore: vi.fn().mockResolvedValue(undefined),
    activate: vi.fn(() => release),
    refresh: vi.fn(),
    retry: vi.fn().mockResolvedValue(undefined),
    release,
  };
}

describe('ForwardPicker', () => {
  const threadId = encodeId('999');
  const changes = new Subject<ServerWsMessage>();
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });
  function setup(messages: readonly ForwardSource[] = [testMessage], topic?: ForwardTopic) {
    const chats = query([testChat]);
    const threads = query([
      {
        chatId: testChat.id,
        chatKind: GroupKind.group,
        chatName: 'Topic chat',
        chatAvatar: undefined,
        threadRootMessage: { ...testMessage, id: threadId },
        replyCount: 2,
        lastReplyAt: '2026-10-22T00:00:00Z',
      },
    ]);
    const listForwardSources = vi.fn().mockReturnValue(of({ messages: [testMessage] }));
    const toasts = vi.fn().mockResolvedValue({ present: vi.fn(), dismiss: vi.fn(), remove: vi.fn() });
    TestBed.configureTestingModule({
      providers: [
        { provide: MessageOutbox, useValue: { enqueue: vi.fn() } },
        { provide: ChatListStore, useValue: { chats: () => chats, threads: () => threads } },
        {
          provide: ChatStore,
          useValue: {
            get: () => ({ ...testChat, peer: { uid: 2 } }),
            relationship: vi.fn(() => ({
              activate: () => () => {},
              ensure: async () => {},
              error: () => false,
              value: () => ({ canDm: true }),
            })),
            ensureDetails: vi.fn().mockResolvedValue(undefined),
            canSpeak: vi.fn().mockReturnValue(true),
            isAccessible: () => true,
          },
        },
        { provide: Connection, useValue: mockRealtime({ events$: changes }) },
        {
          provide: RpcApi,
          useValue: { threads: { listForwardSources }, messages: { sendForward: vi.fn() } },
        },
        { provide: SessionStore, useValue: { user: () => ({ uid: 1 }) } },
        { provide: AlertController, useValue: {} },
        { provide: ToastController, useValue: { create: toasts } },
      ],
    });
    TestBed.overrideComponent(ChatPicker, {
      set: {
        template: `
          @if (hasSelection()) {
            <ng-container [ngTemplateOutlet]="selectionContent() ?? null" />
          }
        `,
      },
    });
    TestBed.overrideComponent(ForwardPanel, { set: { template: '' } });
    const fixture = TestBed.createComponent(ForwardPicker);
    fixture.componentRef.setInput('messages', messages);
    if (topic) fixture.componentRef.setInput('topic', topic);
    fixture.detectChanges();
    const picker = fixture.debugElement.query(By.directive(ChatPicker)).componentInstance as ChatPicker;
    return {
      fixture,
      picker,
      forward: fixture.componentInstance,
      listForwardSources,
      toasts,
      chats,
      threads,
    };
  }
  it('checks only the chosen destination and leaves the picker open when sending is restricted', async () => {
    const { picker, listForwardSources, toasts } = setup();
    const metadata = TestBed.inject(ChatStore);
    vi.mocked(metadata.canSpeak).mockReturnValue(false);
    const target = picker['targets']().find((item) => item.threadId === threadId)!;
    expect(target.avatar.badgeName).toBe(testMessage.sender.name);
    await picker['select'](target);
    expect(metadata.ensureDetails).toHaveBeenCalledExactlyOnceWith(target.chatId);
    expect(listForwardSources).not.toHaveBeenCalled();
    expect(picker['open']()).toBe(true);
    expect(toasts).toHaveBeenCalledWith(
      expect.objectContaining({
        message: TestBed.inject(TranslocoService).translate(ForwardSelectionError.Restricted),
      }),
    );
  });

  it('selects a known DM topic without requesting group details', async () => {
    const { picker, threads, forward } = setup();
    threads.items.update((items) => items.map((item) => ({ ...item, chatKind: GroupKind.dm })));
    const target = picker['targets']().find((item) => item.threadId === threadId)!;
    expect(target.avatar.badgeIcon).toBe(chatbubbles);
    await picker['select'](target);
    expect(TestBed.inject(ChatStore).ensureDetails).not.toHaveBeenCalled();
    expect(forward['selection']()).toEqual({ target, sources: [testMessage] });
  });

  it('rejects a topic selection recalled while the source read is in flight', async () => {
    const { picker, forward, listForwardSources } = setup([], { chatId: testChat.id, threadId });
    const pending = new Subject<{ messages: MessageResponse[] }>();
    listForwardSources.mockReturnValueOnce(pending);
    const selecting = picker['select'](picker['targets']()[0]);
    await vi.waitFor(() => expect(listForwardSources).toHaveBeenCalledOnce());
    changes.next({ type: ServerWsMessageType.messageDeleted, payload: testMessage });
    pending.next({ messages: [testMessage] });
    await selecting;
    expect(forward['selection']()).toBeUndefined();
  });
  it('rejects a source recalled while the picker is open', async () => {
    const { picker, forward, listForwardSources } = setup([testMessage]);
    changes.next({ type: ServerWsMessageType.messageDeleted, payload: { ...testMessage, isDeleted: true } });
    await picker['select'](picker['targets']()[0]);
    expect(forward['invalid']()).toBe(true);
    expect(listForwardSources).not.toHaveBeenCalled();
  });
  it('retains known targets during refresh and pages the shallower stream', async () => {
    const { picker, chats, threads } = setup();
    const before = picker['targets']();
    chats.loading.set(true);
    threads.loading.set(true);
    expect(picker['targets']()).toEqual(before);
    chats.hasMore.set(true);
    threads.hasMore.set(true);
    chats.loadedThrough.set(20);
    threads.loadedThrough.set(10);
    const complete = vi.fn();
    await picker['more']({ target: { complete } } as unknown as Parameters<(typeof picker)['more']>[0]);
    expect(chats.loadMore).toHaveBeenCalledOnce();
    expect(threads.loadMore).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
  });
  it('keeps chats available while topics are uninitialized or failed and pages the healthy stream', async () => {
    const { picker, chats, threads } = setup();
    threads.items.set([]);
    threads.loadedThrough.set(Infinity);
    threads.loading.set(true);
    expect(picker['targets']().map((target) => target.chatId)).toEqual([testChat.id]);
    threads.loading.set(false);
    threads.error.set(ChatListError.Load);
    chats.hasMore.set(true);
    chats.loadedThrough.set(10);
    expect(picker['targets']()).toHaveLength(1);
    expect(picker['moreAvailable']()).toBe(true);
    await picker['more']();
    expect(chats.loadMore).toHaveBeenCalledOnce();
    expect(threads.loadMore).not.toHaveBeenCalled();
  });
  it('shares one page between an empty search and overlapping infinite scroll', async () => {
    const { picker, chats } = setup();
    picker['query'].set('Older friend');
    chats.hasMore.set(true);
    expect(picker['targets']()).toEqual([]);
    let resolve!: () => void;
    chats.loadMore.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const pending = picker['more']();
    expect(picker['paging']()).toBe(true);
    const complete = vi.fn();
    const infinite = picker['more']({ target: { complete } } as unknown as Parameters<(typeof picker)['more']>[0]);
    expect(picker['manualPaging']()).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    expect(chats.loadMore).toHaveBeenCalledOnce();
    chats.items.update((items) => [...items, { ...testChat, id: encodeId('123'), name: 'Older friend' }]);
    chats.hasMore.set(false);
    resolve();
    await Promise.all([pending, infinite]);
    expect(complete).toHaveBeenCalledOnce();
    expect(picker['manualPaging']()).toBe(false);
    expect(picker['query']()).toBe('Older friend');
    expect(picker['targets']().map((target) => target.name)).toEqual(['Older friend']);
    expect(picker['paging']()).toBe(false);
  });

  it('does not confuse an empty search during refresh with the initial load', () => {
    const { picker, chats, threads } = setup();
    picker['query'].set('not found');
    chats.loading.set(true);
    expect(picker['initialLoading']()).toBe(false);
    expect(picker['pending']()).toBe(false);
    threads.items.set([]);
    threads.loadedThrough.set(Infinity);
    threads.loading.set(true);
    expect(picker['initialLoading']()).toBe(false);
    expect(picker['pending']()).toBe(true);
    expect(picker['incomplete']()).toBe(true);
    chats.items.set([]);
    expect(picker['initialLoading']()).toBe(true);
  });

  it('switches targets in the same panel and blocks dismissal while sending', async () => {
    const { fixture, picker, forward, listForwardSources } = setup([], { chatId: testChat.id, threadId });
    const [original, alternate] = picker['targets']();
    await picker['select'](original);
    fixture.detectChanges();
    const panel = forward['panel']()!;
    panel['comment'].set('keep this');
    panel['requestTargetChange']();
    await picker['select'](alternate);
    fixture.detectChanges();
    expect(forward['panel']()).toBe(panel);
    expect(panel['target']()).toEqual(alternate);
    expect(panel['comment']()).toBe('keep this');
    panel.sending.set(true);
    fixture.detectChanges();
    expect(picker['canDismiss']()).toBe(false);
    expect(listForwardSources).toHaveBeenCalledExactlyOnceWith({ chatId: testChat.id, threadRootId: threadId });
  });

  it('does not block either target stream on an unread-only error', async () => {
    const { picker, chats, threads } = setup();
    chats.error.set(ChatListError.Unread);
    threads.error.set(ChatListError.Unread);
    chats.hasMore.set(true);
    threads.hasMore.set(true);
    expect(picker['failed']()).toBe(false);
    expect(picker['moreAvailable']()).toBe(true);
    await picker['more']();
    expect(chats.loadMore).toHaveBeenCalledOnce();
    expect(threads.loadMore).toHaveBeenCalledOnce();
  });

  it('retains row order during a press while applying removals immediately', () => {
    const { picker, chats, threads } = setup();
    const original = picker['targets']().map((target) => target.threadId ?? target.chatId);
    picker['press'](picker['targets']()[1]);
    chats.items.update((items) => items.map((chat) => ({ ...chat, lastMessageAt: '2026-12-01T00:00:00Z' })));
    expect(picker['targets']().map((target) => target.threadId ?? target.chatId)).toEqual(original);
    picker['pressed'].set(undefined);
    expect(picker['targets']()[0].threadId).toBeUndefined();
    picker['press'](picker['targets']()[0]);
    threads.items.set([]);
    expect(picker['targets']()).toHaveLength(1);
    chats.items.set([]);
    expect(picker['targets']()).toHaveLength(0);
  });

  it('uses the query retry contract and keeps its pending feedback until completion', async () => {
    const { picker, chats } = setup();
    let resolve!: () => void;
    chats.retry.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const pending = picker['retry'](chats);
    await picker['retry'](chats);
    expect(chats.retry).toHaveBeenCalledOnce();
    expect(chats.refresh).not.toHaveBeenCalled();
    expect(picker['pending']()).toBe(true);
    resolve();
    await pending;
    expect(picker['pending']()).toBe(false);
  });

  it('locates variable-height visible rows with bounded measurements after distant scroll jumps', () => {
    const { picker } = setup();
    const viewport = document.createElement('div');
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 300, 400));
    let offset = 0;
    const offsets: number[] = [];
    let measurements = 0;
    const rows = Array.from({ length: 1000 }, (_, index) => {
      const element = document.createElement('ion-item');
      const top = offset;
      const height = index % 2 ? 72 : 48;
      offsets.push(top);
      offset += height;
      vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => {
        measurements++;
        return new DOMRect(0, 100 + top - viewport.scrollTop, 300, height);
      });
      return element;
    });
    picker['rows'] = rows;
    picker['viewport'].set(viewport);
    for (const first of [0, 800, 20, 999]) {
      viewport.scrollTop = offsets[first] + 10;
      measurements = 0;
      picker['rememberPosition']();
      const expected = rows.filter((_, index) => index >= first && offsets[index] < viewport.scrollTop + 400);
      expect(picker['anchors'].map((anchor) => anchor.element)).toEqual(expected);
      expect(picker['anchors'][0].offset).toBe(offsets[first]);
      expect(measurements).toBeLessThan(25);
    }
    picker['rows'] = [];
    picker['rememberPosition']();
    expect(picker['anchors']).toEqual([]);
  });
});
