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
import { ForwardPicker } from './forward-picker';
import { ForwardPlaceholder } from '../forward-placeholder';
import type { ForwardSource } from '../forwarding';
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
  function setup(messages: readonly ForwardSource[] = [testMessage]) {
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
    TestBed.configureTestingModule({
      providers: [
        { provide: ChatListStore, useValue: { chats: () => chats, threads: () => threads } },
        { provide: ChatStore, useValue: { get: () => testChat } },
        { provide: MessageOutbox, useValue: { enqueueForward } },
        { provide: Connection, useValue: { changes$: changes } },
        { provide: ToastController, useValue: { create: vi.fn().mockResolvedValue({ present: vi.fn() }) } },
      ],
    });
    TestBed.overrideComponent(ForwardPicker, { set: { template: '' } });
    const fixture = TestBed.createComponent(ForwardPicker);
    fixture.componentRef.setInput('messages', messages);
    fixture.detectChanges();
    return { fixture, picker: fixture.componentInstance, enqueueForward, chats, threads };
  }
  it.each([1, 2])(
    'offers topics for %s selected messages and submits once without changing the source selection',
    async (count) => {
      const sources = Array.from({ length: count }, (_, index) => ({
        ...testMessage,
        id: encodeId(String(100 + index)),
      }));
      const { picker, enqueueForward, fixture, chats, threads } = setup(sources);
      const topic = picker['targets']().find((target) => target.threadId === threadId)!;
      expect(topic).toBeDefined();
      await picker['select'](topic);
      await picker['select'](topic);
      expect(enqueueForward).toHaveBeenCalledExactlyOnceWith(testChat.id, threadId, sources, {
        allowPlaceholders: false,
        placeholders: new Map(),
      });
      fixture.destroy();
      expect(chats.release).toHaveBeenCalledOnce();
      expect(threads.release).toHaveBeenCalledOnce();
    },
  );
  it('rejects a source recalled while the target picker is open without silently changing modes', async () => {
    const { picker, enqueueForward } = setup([testMessage, { ...testMessage, id: encodeId('100') }]);
    changes.next({ type: ServerWsMessageType.messageDeleted, payload: { ...testMessage, isDeleted: true } });
    await picker['select'](picker['targets']()[0]);
    expect(picker['invalid']()).toBe(true);
    expect(enqueueForward).not.toHaveBeenCalled();
  });
  it('requires explicit consent for a nested card in a merge and keeps the picker open on cancellation', () => {
    const nested = {
      ...testMessage,
      messageType: MessageType.forwarded,
      forwardedPreview: { total: 2, containsForwardedMessages: true, messages: [] },
    };
    const sources = [nested, { ...testMessage, id: encodeId('100') }];
    const { picker, enqueueForward } = setup(sources);
    const target = picker['targets']()[0];
    picker['select'](target);
    expect(enqueueForward).not.toHaveBeenCalled();
    expect(picker['confirmation']()?.prompt).toBe('messages.forward.confirmNested');
    picker['confirm'](new CustomEvent('dismiss', { detail: { role: 'cancel' } }));
    expect(picker['open']()).toBe(true);
    expect(enqueueForward).not.toHaveBeenCalled();
    picker['select'](target);
    picker['confirm'](new CustomEvent('dismiss', { detail: { role: 'confirm' } }));
    expect(enqueueForward).toHaveBeenCalledExactlyOnceWith(testChat.id, threadId, sources, {
      allowPlaceholders: true,
      placeholders: new Map([[nested.id, ForwardPlaceholder.NestedForward]]),
    });
  });
  it('forwards a single nested card without replacement confirmation', () => {
    const nested = {
      ...testMessage,
      messageType: MessageType.forwarded,
      forwardedPreview: { total: 2, containsForwardedMessages: true, messages: [] },
    };
    const { picker, enqueueForward } = setup([nested]);
    picker['select'](picker['targets']()[0]);
    expect(picker['confirmation']()).toBeUndefined();
    expect(enqueueForward).toHaveBeenCalledWith(testChat.id, threadId, [nested], {
      allowPlaceholders: false,
      placeholders: new Map(),
    });
  });
  it('reads the latest audio publication after asking for placeholder confirmation', () => {
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
    const { picker, enqueueForward } = setup([source]);
    picker['select'](picker['targets']()[0]);
    expect(picker['confirmation']()?.prompt).toBe('messages.forward.confirmPendingAudio');
    expect(enqueueForward).not.toHaveBeenCalled();
    source.published.set(true);
    picker['confirm'](new CustomEvent('dismiss', { detail: { role: 'confirm' } }));
    expect(enqueueForward).toHaveBeenCalledWith(testChat.id, threadId, [audio], {
      allowPlaceholders: true,
      placeholders: new Map(),
    });
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
