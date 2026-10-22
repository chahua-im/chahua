import { DestroyRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import {
  ServerWsMessageType,
  type ConversationState,
  type ServerWsMessage,
  type MeResponse,
} from '../../generated/models';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { Connection } from '../api/connection';
import { SessionStore } from '../session/session-store';
import { mockRealtime, testUser, testChat, testMessage, wireChat, wireMessage } from '../api/testing';
import { jsonInterceptor } from '../api/json.interceptor';
import { encodeId } from '../api/snowflake-id';
import { ChatListStore } from './chat-list-store';
import { ChatStore } from './chat-store';
import { conversationStates } from './conversation-states';

describe('explicit conversation state watches', () => {
  const watch = vi.fn<Connection['watchConversationStates']>();
  const user = signal<MeResponse | undefined>(testUser);
  const connected = signal(true);
  let events: Subject<ServerWsMessage>;
  let http: HttpTestingController;
  const row = (count = 1): ConversationState => ({
    chatId: testChat.id,
    accessible: true,
    unreadCount: count,
    unreadMentions: 0,
    unreadReactions: 0,
  });
  const requestId = () => watch.mock.calls.at(-1)![0];
  const publish = (states = [row()], full = true, id = requestId()) =>
    events.next({ type: ServerWsMessageType.conversationStates, payload: { requestId: id, full, states } });
  const settle = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
    TestBed.tick();
  };
  beforeEach(() => {
    watch.mockReset();
    user.set(testUser);
    connected.set(true);
    events = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        {
          provide: Connection,
          useValue: { ...mockRealtime({ events$: events, connected }), watchConversationStates: watch },
        },
        { provide: SessionStore, useValue: { user } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  it('shares duplicate scopes, rejects old subscriptions, and restores a full snapshot after reconnect', () => {
    const accept = vi.fn();
    const state = TestBed.runInInjectionContext(() =>
      conversationStates(TestBed.inject(Connection), TestBed.inject(SessionStore), TestBed.inject(DestroyRef), accept),
    );
    const leave = state.watch([{ chatId: testChat.id }]);
    TestBed.tick();
    const first = requestId();
    const duplicate = state.watch([{ chatId: testChat.id }]);
    TestBed.tick();
    expect(watch).toHaveBeenCalledOnce();
    publish();
    expect(state.ready(row())).toBe(true);
    connected.set(false);
    TestBed.tick();
    expect(state.ready(row())).toBe(false);
    connected.set(true);
    TestBed.tick();
    publish([row(9)], false, first);
    publish([row(9)], false);
    expect(accept).toHaveBeenCalledOnce();
    publish([row(0)]);
    expect(accept).toHaveBeenLastCalledWith([row(0)]);
    user.set({ ...testUser, uid: 2 });
    TestBed.tick();
    publish([row(7)], true, first);
    expect(accept).toHaveBeenCalledTimes(2);
    leave();
    duplicate();
    TestBed.tick();
    expect(watch.mock.calls.at(-1)![1]).toEqual([]);
  });

  it('limits the shared scope set and leaves overflow eligible for HTTP', () => {
    const state = TestBed.runInInjectionContext(() =>
      conversationStates(TestBed.inject(Connection), TestBed.inject(SessionStore), TestBed.inject(DestroyRef), vi.fn()),
    );
    state.watch(Array.from({ length: 513 }, (_, i) => ({ chatId: encodeId(String(i + 1)) })));
    TestBed.tick();
    expect(watch.mock.calls.at(-1)![1]).toHaveLength(512);
  });

  it('updates a loaded row from WS without a per-message unread GET and removes revoked membership', async () => {
    const lists = TestBed.inject(ChatListStore);
    const query = lists.chats(false);
    query.activate();
    http.expectOne('/_api/chats?limit=50').flush(structuredClone({ chats: [wireChat] }));
    await settle();
    publish([row(2)]);
    events.next({
      type: ServerWsMessageType.message,
      payload: { ...testMessage, sender: { ...testMessage.sender, uid: 2 } },
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    http.expectNone(() => true);
    publish([row(3)], false);
    expect(query.items()[0].unreadCount).toBe(3);
    publish([{ ...row(0), accessible: false }], false);
    expect(query.items()).toEqual([]);
  });

  it('reuses watched thread counters after message invalidation without fetching read-state', async () => {
    const store = TestBed.inject(ChatStore);
    const threadId = encodeId('100');
    store.watchReadStates([{ chatId: testChat.id, threadId }]);
    TestBed.tick();
    publish([{ ...row(4), threadId }]);
    store.invalidateThreadReads([threadId]);
    expect((await store.getThreadReadState(testChat.id, threadId)).unreadCount).toBe(4);
    http.expectNone(() => true);
  });

  it('uses a new watch barrier after local reads so a late snapshot cannot undo them', async () => {
    vi.useFakeTimers();
    const store = TestBed.inject(ChatStore);
    store.watchReadStates([{ chatId: testChat.id }]);
    TestBed.tick();
    publish([row(3)]);
    const old = requestId();
    const reading = store.markRead(testChat.id, testMessage.id);
    await vi.advanceTimersByTimeAsync(1000);
    http
      .expectOne(`/_api/chats/${wireChat.id}/read`)
      .flush({ lastReadMessageId: wireMessage.id, unreadCount: 0, unreadMentions: 0, unreadReactions: 0 });
    await reading;
    expect(requestId()).not.toBe(old);
    publish([row(3)], false, old);
    expect(store.unreadCount(testChat.id)).toBe(0);
    publish([{ ...row(0), lastReadMessageId: testMessage.id }]);
    http.expectNone(() => true);
  });
});
