import { encodeId } from './snowflake-id';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { testChat, testMessage, testUser, wireChat, wireMessage } from './testing';
import { Connection } from './connection';
import { SessionStore } from '../session/session-store';

class TestSocket {
  static readonly OPEN = 1;
  static instances: TestSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });
  constructor(readonly url: URL) {
    TestSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent<string>);
  }
}

describe('Connection', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('authenticates, sends heartbeats, reconnects, and closes on logout', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', TestSocket);
    TestSocket.instances = [];
    const user = signal<typeof testUser | undefined>(testUser);
    TestBed.configureTestingModule({
      providers: [
        provideChahuaBaseUrl('/_api'),
        { provide: SessionStore, useValue: { token: signal('test-jwt'), user } },
      ],
    });
    const realtime = TestBed.inject(Connection);
    const message = vi.fn();
    const events = vi.fn();
    const resync = vi.fn();
    realtime.messages$.subscribe(message);
    realtime.events$.subscribe(events);
    realtime.resync$.subscribe(resync);
    TestBed.tick();
    const socket = TestSocket.instances[0];
    expect(socket.url.pathname).toBe('/_api/ws');
    socket.open();
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'auth', ticket: 'test-jwt' }));
    socket.receive({ type: 'presenceUpdate', payload: { activeConnections: 1 } });
    realtime.accept(testMessage);
    socket.receive({ type: 'message', payload: wireMessage });
    socket.receive({
      type: 'message',
      payload: { ...wireMessage, id: '9007199254741004', replyRootId: wireMessage.id, sticker: null },
    });
    expect(message).toHaveBeenCalledTimes(2);
    expect(message).toHaveBeenNthCalledWith(1, testMessage);
    expect(message).toHaveBeenNthCalledWith(2, {
      ...testMessage,
      id: encodeId('9007199254741004'),
      replyRootId: testMessage.id,
      sticker: undefined,
    });
    expect(Object.hasOwn(message.mock.calls[1][0], 'sticker')).toBe(true);
    socket.receive({ type: 'messagesBulkDeleted', payload: { chatId: wireChat.id, messageIds: [wireMessage.id] } });
    expect(events).toHaveBeenLastCalledWith({
      type: 'messagesBulkDeleted',
      payload: { chatId: testChat.id, messageIds: [testMessage.id] },
    });
    socket.receive({
      type: 'chatArchiveStateChanged',
      payload: { chatId: wireChat.id, archived: false, mutedUntil: null },
    });
    expect(events).toHaveBeenLastCalledWith({
      type: 'chatArchiveStateChanged',
      payload: { chatId: testChat.id, archived: false, mutedUntil: undefined },
    });
    expect(resync).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10000);
    expect(socket.send.mock.calls.at(-1)?.[0]).toContain('"type":"ping"');
    socket.close();
    vi.advanceTimersByTime(1200);
    expect(TestSocket.instances).toHaveLength(2);
    const replacement = TestSocket.instances[1];
    replacement.open();
    replacement.receive({ type: 'presenceUpdate', payload: { activeConnections: 1 } });
    expect(resync).toHaveBeenCalledTimes(2);
    user.set(undefined);
    TestBed.tick();
    expect(replacement.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(30000);
    expect(TestSocket.instances).toHaveLength(2);
  });

  it('notifies foreground resync once regardless of socket readiness and stops listening after logout', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', TestSocket);
    TestSocket.instances = [];
    let hidden = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const user = signal<typeof testUser | undefined>(testUser);
    TestBed.configureTestingModule({
      providers: [
        provideChahuaBaseUrl('/_api'),
        { provide: SessionStore, useValue: { token: signal('test-jwt'), user } },
      ],
    });
    const resync = vi.fn();
    TestBed.inject(Connection).resync$.subscribe(resync);
    TestBed.tick();
    const socket = TestSocket.instances[0];
    for (const readyState of [0, 1, 3]) {
      socket.readyState = readyState;
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      resync.mockClear();
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      expect(resync).toHaveBeenCalledOnce();
    }
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'appState', state: 'active' }));
    user.set(undefined);
    TestBed.tick();
    resync.mockClear();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(resync).not.toHaveBeenCalled();
  });
  it('publishes accepted edits and withdrawals without deduplicating distinct changes to the same message', () => {
    TestBed.configureTestingModule({
      providers: [
        provideChahuaBaseUrl('/_api'),
        { provide: SessionStore, useValue: { token: signal(undefined), user: signal(undefined) } },
      ],
    });
    const realtime = TestBed.inject(Connection);
    const messages = vi.fn();
    const changes = vi.fn();
    realtime.messages$.subscribe(messages);
    realtime.changes$.subscribe(changes);
    realtime.accept(testMessage);
    realtime.accept(testMessage);
    realtime.acceptChange({ type: 'messageUpdated', payload: { ...testMessage, message: 'edited' } });
    realtime.acceptChange({ type: 'messageDeleted', payload: { ...testMessage, isDeleted: true } });
    expect(messages).toHaveBeenCalledOnce();
    expect(changes).toHaveBeenCalledTimes(2);
  });
});
