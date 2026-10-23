import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ToastController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { MessageType, ServerWsMessageType, type ServerWsMessage } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { testChat, testMessage } from '../../api/testing';
import { encodeId } from '../../api/snowflake-id';
import { ChatListStore } from '../../chats/chat-list-store';
import { ChatStore } from '../../chats/chat-store';
import { MessageOutbox } from '../message-outbox';
import { ConversationNavigation } from '../../conversations/conversation-navigation';
import { ForwardPicker } from './forward-picker';
import { ForwardSelectionError, type ForwardSource, type ForwardSourcesLoader } from '../forwarding';
import { MessageDelivery } from '../message-delivery';
import type { OutgoingMessage } from '../message-outbox';

function query<T>(items: T[]) {
  const release = vi.fn();
  return {
    items: signal(items),
    loading: signal(false),
    error: signal(false),
    hasMore: signal(false),
    loadedThrough: signal(-Infinity),
    loadMore: vi.fn().mockResolvedValue(undefined),
    activate: vi.fn(() => release),
    refresh: vi.fn(),
    release,
  };
}

describe('ForwardPicker', () => {
  const threadId = encodeId('999');
  const changes = new Subject<ServerWsMessage>();
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
  });
  function setup(messages: readonly ForwardSource[] = [testMessage], load?: ForwardSourcesLoader) {
    const chats = query([testChat]);
    const threads = query([
      {
        chatId: testChat.id,
        chatName: 'Topic chat',
        chatAvatar: undefined,
        threadRootMessage: { ...testMessage, id: threadId },
        replyCount: 2,
        lastReplyAt: '2026-10-22T00:00:00Z',
      },
    ]);
    const enqueueForward = vi.fn();
    const prepareForward = vi.fn().mockResolvedValue(true);
    const toasts = vi.fn().mockResolvedValue({ present: vi.fn() });
    TestBed.configureTestingModule({
      providers: [
        { provide: ChatListStore, useValue: { chats: () => chats, threads: () => threads } },
        { provide: ChatStore, useValue: { get: () => testChat } },
        { provide: MessageOutbox, useValue: { enqueueForward } },
        { provide: ConversationNavigation, useValue: { prepareForward } },
        { provide: Connection, useValue: { changes$: changes } },
        { provide: ToastController, useValue: { create: toasts } },
      ],
    });
    TestBed.overrideComponent(ForwardPicker, { set: { template: '' } });
    const fixture = TestBed.createComponent(ForwardPicker);
    fixture.componentRef.setInput('messages', messages);
    if (load) fixture.componentRef.setInput('load', load);
    fixture.detectChanges();
    return { fixture, picker: fixture.componentInstance, prepareForward, enqueueForward, toasts, chats, threads };
  }
  it.each([1, 2])('opens the selected topic with %s sources without sending', async (count) => {
    const sources = Array.from({ length: count }, (_, index) => ({
      ...testMessage,
      id: encodeId(String(100 + index)),
    }));
    const { picker, prepareForward, enqueueForward, fixture, chats, threads } = setup(sources);
    const topic = picker['targets']().find((target) => target.threadId === threadId)!;
    await picker['select'](topic);
    await picker['select'](topic);
    expect(prepareForward).toHaveBeenCalledExactlyOnceWith(testChat.id, threadId, sources);
    expect(enqueueForward).not.toHaveBeenCalled();
    fixture.destroy();
    expect(chats.release).toHaveBeenCalledOnce();
    expect(threads.release).toHaveBeenCalledOnce();
  });
  it('reads the whole topic when a target is chosen and stages that selection', async () => {
    const selection = [testMessage, { ...testMessage, id: encodeId('100') }];
    const load = vi.fn<ForwardSourcesLoader>().mockResolvedValue({ sources: selection });
    const { picker, prepareForward, enqueueForward } = setup([], load);
    await picker['select'](picker['targets']()[0]);
    expect(load).toHaveBeenCalledOnce();
    expect(prepareForward).toHaveBeenCalledExactlyOnceWith(testChat.id, threadId, selection);
    expect(enqueueForward).not.toHaveBeenCalled();
  });
  it('reports a failed or oversized topic read and leaves another target choice possible', async () => {
    const load = vi
      .fn<ForwardSourcesLoader>()
      .mockResolvedValueOnce({ error: ForwardSelectionError.LoadFailed })
      .mockResolvedValueOnce({ error: ForwardSelectionError.TooMany })
      .mockResolvedValueOnce({ sources: [testMessage] });
    const { picker, prepareForward, toasts } = setup([], load);
    await picker['select'](picker['targets']()[0]);
    expect(picker['failure']()).toBe(ForwardSelectionError.LoadFailed);
    expect(picker['invalid']()).toBe(false);
    expect(toasts).toHaveBeenCalledOnce();
    await picker['select'](picker['targets']()[0]);
    expect(picker['failure']()).toBe(ForwardSelectionError.TooMany);
    expect(prepareForward).not.toHaveBeenCalled();
    await picker['select'](picker['targets']()[0]);
    expect(prepareForward).toHaveBeenCalledOnce();
  });
  it('rejects a source recalled while the picker is open', async () => {
    const { picker, prepareForward } = setup([testMessage]);
    changes.next({ type: ServerWsMessageType.messageDeleted, payload: { ...testMessage, isDeleted: true } });
    await picker['select'](picker['targets']()[0]);
    expect(picker['invalid']()).toBe(true);
    expect(prepareForward).not.toHaveBeenCalled();
  });
  it('stages nested records without asking for replacement consent before send', async () => {
    const nested = {
      ...testMessage,
      messageType: MessageType.forwarded,
      forwardedPreview: { total: 2, containsForwardedMessages: true, messages: [] },
    };
    const sources = [nested, { ...testMessage, id: encodeId('100') }];
    const { picker, prepareForward, enqueueForward } = setup(sources);
    await picker['select'](picker['targets']()[0]);
    expect(prepareForward).toHaveBeenCalledWith(testChat.id, threadId, sources);
    expect(enqueueForward).not.toHaveBeenCalled();
  });
  it('keeps the live audio source while preparing its destination', async () => {
    const audio = { ...testMessage, messageType: MessageType.audio };
    const source: OutgoingMessage = {
      clientGeneratedId: audio.clientGeneratedId,
      chatId: audio.chatId,
      message: signal(audio),
      confirmed: signal(audio),
      published: signal(false),
      cancelled: signal(false),
      delivery: signal(MessageDelivery.Sent),
      uploads: [],
      body: { clientGeneratedId: audio.clientGeneratedId, messageType: MessageType.audio },
      disposed: false,
    };
    const { picker, prepareForward } = setup([source]);
    await picker['select'](picker['targets']()[0]);
    expect(prepareForward.mock.calls[0][2][0]).toBe(source);
  });
  it('reports failed navigation and allows choosing a target again', async () => {
    const { picker, prepareForward, toasts } = setup();
    prepareForward.mockResolvedValueOnce(false);
    await picker['select'](picker['targets']()[0]);
    expect(picker['submitted']()).toBe(false);
    expect(picker['open']()).toBe(true);
    expect(toasts).toHaveBeenCalledWith(expect.objectContaining({ message: expect.any(String) }));
    await picker['select'](picker['targets']()[0]);
    expect(prepareForward).toHaveBeenCalledTimes(2);
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
    threads.error.set(true);
    chats.hasMore.set(true);
    chats.loadedThrough.set(10);
    expect(picker['targets']()).toHaveLength(1);
    expect(picker['moreAvailable']()).toBe(true);
    await picker['more']();
    expect(chats.loadMore).toHaveBeenCalledOnce();
    expect(threads.loadMore).not.toHaveBeenCalled();
  });
  it('manually loads the next page with an empty search result and coalesces repeated clicks', async () => {
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
    await picker['more']();
    expect(chats.loadMore).toHaveBeenCalledOnce();
    chats.items.update((items) => [...items, { ...testChat, id: encodeId('123'), name: 'Older friend' }]);
    chats.hasMore.set(false);
    resolve();
    await pending;
    expect(picker['query']()).toBe('Older friend');
    expect(picker['targets']().map((target) => target.name)).toEqual(['Older friend']);
    expect(picker['paging']()).toBe(false);
  });
});
