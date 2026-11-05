import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { RpcErrorCode, RpcTransportError } from './rpc-error';
import { RpcTestPeer, provideRpcTesting } from './rpc-testing';
import { RpcConnectionState, RpcTransport } from './rpc-transport';

const OPEN_RESULT = { protocolVersion: 1, authenticated: true as const, uid: 1, clientId: 'fixture-client' };

function configure(autoLifecycle = true) {
  TestBed.configureTestingModule({
    providers: [provideChahuaBaseUrl('/_api'), provideRpcTesting({ autoLifecycle })],
  });
  return { transport: TestBed.inject(RpcTransport), peer: TestBed.inject(RpcTestPeer) };
}

function openAuthenticated(transport: RpcTransport, peer: RpcTestPeer, token = 'fixture-token') {
  const received = vi.fn();
  transport.open({ token, appVersion: 'test' }).subscribe({ next: received, error: received });
  peer.open();
  peer.expect('session.open', { protocolVersion: 1, token, appVersion: 'test' }).flush(OPEN_RESULT);
  return received;
}

describe('RpcTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps a successfully opened authenticated socket alive after the open observable completes', () => {
    const { transport, peer } = configure();
    const received = openAuthenticated(transport, peer);

    expect(received).toHaveBeenCalledWith(OPEN_RESULT);
    expect(peer.latest.readyState).toBe(1);
    expect(transport.state()).toBe(RpcConnectionState.Authenticated);
    peer.verify();
  });

  it('permits only development bootstrap on an anonymous negotiated session', () => {
    const { transport, peer } = configure();
    transport.open({ appVersion: 'test' }).subscribe();
    peer.open();
    peer.expect('session.open', { protocolVersion: 1, appVersion: 'test' }).flush({
      protocolVersion: 1,
      authenticated: false,
    });

    expect(transport.state()).toBe(RpcConnectionState.Anonymous);
    const rejected = vi.fn();
    transport.call('messages.list', { chatId: '1' }).subscribe({ error: rejected });
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ kind: 'disconnected' }));
    const created = vi.fn();
    transport.call('auth.createDevSession', { uid: 1, clientId: 'fixture-client' }).subscribe(created);
    peer.expect('auth.createDevSession', { uid: 1, clientId: 'fixture-client' }).flush({ token: 'new-token' });
    expect(created).toHaveBeenCalledWith({ token: 'new-token' });
    expect(transport.state()).toBe(RpcConnectionState.Authenticated);
    peer.verify();
  });

  it('correlates out-of-order results and ignores a cancelled call late reply', () => {
    const { transport, peer } = configure();
    openAuthenticated(transport, peer);
    const first = vi.fn();
    const second = vi.fn();
    transport.call('messages.list', { chatId: '1' }).subscribe(first);
    transport.call('messages.list', { chatId: '2' }).subscribe(second);
    const one = peer.expect('messages.list', { chatId: '1' });
    const two = peer.expect('messages.list', { chatId: '2' });

    two.flush({ chatId: '2' });
    one.flush({ chatId: '1' });
    expect(first).toHaveBeenCalledWith({ chatId: '1' });
    expect(second).toHaveBeenCalledWith({ chatId: '2' });

    const late = vi.fn();
    const subscription = transport.call('messages.get', { chatId: '1', messageId: '2' }).subscribe(late);
    const cancelled = peer.expect('messages.get');
    subscription.unsubscribe();
    cancelled.flush({ id: '2' });
    expect(late).not.toHaveBeenCalled();
    peer.verify();
  });

  it('fails a correlated malformed response and closes rather than leaving it pending', () => {
    const { transport, peer } = configure();
    openAuthenticated(transport, peer);
    const failed = vi.fn();
    transport.call('messages.get', { chatId: '1', messageId: '2' }).subscribe({ error: failed });
    const request = peer.expect('messages.get');
    peer.latest.receiveRaw(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: 'wrong' } }));
    request.flush(null);
    peer.verify();

    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'protocol' }));
    expect(transport.state()).toBe(RpcConnectionState.Closed);
  });

  it('fails pending calls on loss and never replays a mutation after reconnect', () => {
    const { transport, peer } = configure();
    const notifications = vi.fn();
    transport.notifications$.subscribe(notifications);
    openAuthenticated(transport, peer, 'old-token');
    const failed = vi.fn();
    transport.call('messages.send', { chatId: '1', message: 'one' }).subscribe({ error: failed });
    const mutation = peer.expect('messages.send');
    const oldSocket = peer.latest;
    transport.setReconnectToken('replacement-token');
    peer.disconnect();

    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'disconnected' }));
    mutation.flush({ id: 'late' });
    oldSocket.receive({ jsonrpc: '2.0', method: 'events.message', params: { id: 'stale' } });
    expect(notifications).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    peer.open();
    peer
      .expect('session.open', { protocolVersion: 1, token: 'replacement-token', appVersion: 'test' })
      .flush(OPEN_RESULT);
    peer.expectNone('messages.send');
    expect(transport.state()).toBe(RpcConnectionState.Authenticated);
    peer.verify();
  });

  it('advances reconnect backoff once per closed handshake and resets it after authentication', () => {
    const { transport, peer } = configure();
    openAuthenticated(transport, peer);
    peer.disconnect();
    for (const delay of [1_000, 2_000, 4_000]) {
      const previous = peer.latest;
      vi.advanceTimersByTime(delay - 1);
      expect(peer.latest).toBe(previous);
      vi.advanceTimersByTime(1);
      expect(peer.latest).not.toBe(previous);
      peer.open();
      const handshake = peer.expect('session.open');
      if (delay === 4_000) handshake.flush(OPEN_RESULT);
      else {
        peer.disconnect();
        handshake.flush(OPEN_RESULT); // A closed attempt cannot authenticate the new connection.
        expect(transport.state()).toBe(RpcConnectionState.Reconnecting);
      }
    }
    expect(transport.state()).toBe(RpcConnectionState.Authenticated);
    const authenticated = peer.latest;
    peer.disconnect();
    vi.advanceTimersByTime(1_000);
    expect(peer.latest).not.toBe(authenticated);
    peer.open();
    peer.expect('session.open').flush(OPEN_RESULT);
    peer.verify();
  });

  it.each([false, true])('stops queued writes before clearing a malformed response, cancelled: %s', (cancelled) => {
    const { transport, peer } = configure();
    openAuthenticated(transport, peer);
    const failed = vi.fn();
    const reads = Array.from({ length: 16 }, () => transport.call('messages.list').subscribe({ error: failed }));
    const requests = peer.match('messages.list');
    if (cancelled) reads[0].unsubscribe();
    transport.call('messages.send', { chatId: '1', message: 'queued' }).subscribe({ error: failed });
    requests[0].deliver({ jsonrpc: '2.0', id: requests[0].id, error: { code: 'invalid' } });
    expect(transport.state()).toBe(RpcConnectionState.Closed);
    peer.expectNone('messages.send');
    expect(failed).toHaveBeenCalledTimes(cancelled ? 16 : 17);
    for (const [error] of failed.mock.calls) expect(error).toMatchObject({ kind: 'protocol' });
    for (const request of requests) request.flush(null);
    vi.advanceTimersByTime(120_000);
    peer.expectNone('session.open');
    peer.verify();
  });

  it('stops queued development authentication on a malformed binding result', () => {
    const { transport, peer } = configure();
    transport.open({ appVersion: 'test' }).subscribe();
    peer.open();
    peer.expect('session.open').flush({ protocolVersion: 1, authenticated: false });
    const failed = vi.fn();
    transport.call('auth.createDevSession', { uid: 1 }).subscribe({ error: failed });
    const binding = peer.expect('auth.createDevSession');
    transport.call('auth.createDevSession', { uid: 2 }).subscribe({ error: failed });
    binding.flush({});
    peer.expectNone('auth.createDevSession');
    expect(failed).toHaveBeenCalledTimes(2);
    expect(transport.state()).toBe(RpcConnectionState.Closed);
    peer.verify();
  });

  it('does not invalidate a replacement session opened synchronously while closing a revoked session', () => {
    const { transport, peer } = configure();
    openAuthenticated(transport, peer);
    const invalidated = vi.fn();
    transport.sessionInvalidated$.subscribe(invalidated);
    const failed = vi.fn(() => transport.open({ token: 'replacement', appVersion: 'test' }).subscribe());
    transport.call('messages.list').subscribe({ error: failed });
    const request = peer.expect('messages.list');
    peer.notify('session.invalidated', { reason: 'revoked' });
    expect(failed).toHaveBeenCalledOnce();
    expect(invalidated).not.toHaveBeenCalled();
    request.flush(null);
    peer.open();
    peer.expect('session.open', { protocolVersion: 1, token: 'replacement', appVersion: 'test' }).flush(OPEN_RESULT);
    expect(transport.state()).toBe(RpcConnectionState.Authenticated);
    peer.verify();
  });

  it('keeps cancelled sent calls in the admission budget until their replies arrive', () => {
    const { transport, peer } = configure();
    openAuthenticated(transport, peer);
    const subscriptions = Array.from({ length: 16 }, (_, slot) => transport.call('messages.get', { slot }).subscribe());
    const held = peer.match('messages.get');
    expect(held).toHaveLength(16);
    for (const subscription of subscriptions) subscription.unsubscribe();

    transport.call('messages.get', { slot: 16 }).subscribe();
    peer.expectNone('messages.get');
    held[0].flush({ slot: 0 });
    const admitted = peer.expect('messages.get', { slot: 16 });
    admitted.flush({ slot: 16 });
    for (const request of held.slice(1)) request.flush(null);
    peer.verify();
  });

  it('bounds ordinary queueing, deadline wait, and serialized-byte admission', () => {
    const { transport, peer } = configure();
    openAuthenticated(transport, peer);
    const errors: unknown[] = [];
    for (let index = 0; index < 16; index++)
      transport.call('messages.list', { index }).subscribe({ error: (error) => errors.push(error) });
    const timeout = vi.fn();
    transport.call('messages.search', { chatId: '1', query: 'queued' }).subscribe({ error: timeout });
    for (let index = 0; index < 63; index++)
      transport.call('messages.list', { index: index + 16 }).subscribe({ error: (error) => errors.push(error) });
    transport.call('messages.list', { index: 80 }).subscribe({ error: (error) => errors.push(error) });

    const initiallySent = peer.match('messages.list');
    expect(initiallySent).toHaveLength(16);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RpcTransportError);
    expect((errors[0] as RpcTransportError).kind).toBe('overloaded');

    vi.advanceTimersByTime(30_001);
    expect(timeout).toHaveBeenCalledWith(expect.objectContaining({ kind: 'timeout' }));
    for (const request of [...initiallySent, ...peer.match('messages.list'), ...peer.match('messages.search')])
      request.flush(null);

    const oversized = vi.fn();
    const oversizedQuery = '€'.repeat(Math.ceil((64 * 1024 * 1024) / 3));
    transport.call('messages.search', { query: oversizedQuery }).subscribe({ error: oversized });
    expect(oversized).toHaveBeenCalledWith(expect.objectContaining({ kind: 'overloaded' }));
    peer.verify();
  });

  it('distinguishes revocation from transient authentication unavailability', () => {
    const { transport, peer } = configure();
    const notifications = vi.fn();
    transport.notifications$.subscribe(notifications);
    openAuthenticated(transport, peer);
    const revokedSocket = peer.latest;
    peer.notify('session.invalidated', { reason: 'revoked' });
    expect(notifications).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      method: 'session.invalidated',
      params: { reason: 'revoked' },
    });
    expect(transport.state()).toBe(RpcConnectionState.Closed);
    vi.advanceTimersByTime(30_000);
    expect(peer.latest).toBe(revokedSocket);

    openAuthenticated(transport, peer, 'retained-token');
    peer.notify('session.unavailable', { reason: 'authLookupUnavailable' });
    expect(transport.state()).toBe(RpcConnectionState.Reconnecting);
    vi.advanceTimersByTime(1_000);
    peer.open();
    peer.expect('session.open', { protocolVersion: 1, token: 'retained-token', appVersion: 'test' }).flush(OPEN_RESULT);
    expect(transport.state()).toBe(RpcConnectionState.Authenticated);
    peer.verify();
  });

  it('keeps heartbeat control serial while ordinary reads continue independently', () => {
    const { transport, peer } = configure(false);
    openAuthenticated(transport, peer);
    peer.expect('session.setAppState').flush(null);

    vi.advanceTimersByTime(10_000);
    const ping = peer.expect('session.ping', { state: 'active' });
    transport.call('messages.list', { chatId: '1' }).subscribe();
    const read = peer.expect('messages.list', { chatId: '1' });
    vi.advanceTimersByTime(10_000);
    peer.expectNone('session.ping');
    read.flush({ messages: [] });
    ping.flush(null);
    peer.verify();
  });

  it('does not let event traffic mask a missing heartbeat reply', () => {
    const { transport, peer } = configure(false);
    openAuthenticated(transport, peer);
    peer.expect('session.setAppState').flush(null);
    vi.advanceTimersByTime(10_000);
    const ping = peer.expect('session.ping');
    peer.notify('events.message', { id: 'event-traffic' });
    vi.advanceTimersByTime(90_001);

    expect(transport.state()).toBe(RpcConnectionState.Reconnecting);
    ping.flush(null);
    peer.verify();
  });

  it.each([
    ['presence.watch', { requestId: 3, userIds: [], chatIds: [] }],
    ['conversations.watchStates', { requestId: 3, conversations: [] }],
    ['conversations.watchUnread', { requestId: 3, views: [], appBadge: false }],
    ['session.setAppState', { state: 'inactive' }],
  ])('replaces only unsent %s controls and preserves the final empty scope', (method, latest) => {
    const { transport, peer } = configure(false);
    openAuthenticated(transport, peer);
    peer.expect('session.setAppState').flush(null);
    const firstParams = { ...latest, requestId: 1 };
    transport.call(method, firstParams).subscribe();
    const first = peer.expect(method, firstParams);
    const superseded = { next: vi.fn(), complete: vi.fn() };
    transport.call(method, { ...latest, requestId: 2 }).subscribe(superseded);
    transport.call(method, latest).subscribe();
    expect(superseded.complete).toHaveBeenCalledOnce();
    expect(superseded.next).not.toHaveBeenCalled();
    peer.expectNone(method);
    first.flush(null);
    peer.expect(method, latest).flush(null);
    peer.expectNone(method);
    peer.verify();
  });

  it('admits a heartbeat during repeated watch updates without reordering controls', () => {
    const { transport, peer } = configure(false);
    openAuthenticated(transport, peer);
    const held = peer.expect('session.setAppState');
    const errors = vi.fn();
    for (let requestId = 1; requestId <= 20; requestId++) {
      for (const method of ['presence.watch', 'conversations.watchStates', 'conversations.watchUnread'])
        transport.call(method, { requestId }).subscribe({ error: errors });
      transport.call('session.setAppState', { state: 'active' }).subscribe({ error: errors });
    }
    vi.advanceTimersByTime(10_000);
    held.flush(null);
    for (const method of ['presence.watch', 'conversations.watchStates', 'conversations.watchUnread'])
      peer.expect(method, { requestId: 20 }).flush(null);
    peer.expect('session.setAppState', { state: 'active' }).flush(null);
    peer.expect('session.ping').flush(null);
    expect(errors).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    peer.expect('session.ping').flush(null);
    expect(transport.state()).toBe(RpcConnectionState.Authenticated);
    peer.verify();
  });

  it('retries heartbeat after local admission rejection once capacity is available', () => {
    const { transport, peer } = configure(false);
    openAuthenticated(transport, peer);
    peer.expect('session.setAppState').flush(null);
    for (let index = 0; index < 8; index++) transport.call('session.ping').subscribe();
    vi.advanceTimersByTime(10_000); // The internal heartbeat cannot enter the full control queue.
    for (let index = 0; index < 8; index++) peer.expect('session.ping').flush(null);
    vi.advanceTimersByTime(10_000);
    peer.expect('session.ping', { state: 'active' }).flush(null);
    expect(transport.state()).toBe(RpcConnectionState.Authenticated);
    peer.verify();
  });

  it('retries heartbeat after a server error', () => {
    const { transport, peer } = configure(false);
    openAuthenticated(transport, peer);
    peer.expect('session.setAppState').flush(null);
    vi.advanceTimersByTime(10_000);
    peer.expect('session.ping').error(RpcErrorCode.Unavailable);
    vi.advanceTimersByTime(10_000);
    peer.expect('session.ping').flush(null);
    peer.verify();
  });

  it('reconnects when a cancelled sent control times out and ignores its late reply', () => {
    const { transport, peer } = configure(false);
    openAuthenticated(transport, peer);
    peer.expect('session.setAppState').flush(null);
    const subscription = transport.call('presence.watch', { requestId: 1 }).subscribe();
    const held = peer.expect('presence.watch');
    subscription.unsubscribe();
    vi.advanceTimersByTime(30_000);
    expect(transport.state()).toBe(RpcConnectionState.Reconnecting);
    held.flush(null);
    vi.advanceTimersByTime(1_000);
    peer.open();
    peer.expect('session.open').flush(OPEN_RESULT);
    peer.expect('session.setAppState').flush(null);
    peer.expectNone('presence.watch');
    vi.advanceTimersByTime(10_000);
    peer.expect('session.ping').flush(null);
    peer.verify();
  });

  it('surfaces an old-backend negotiation failure without legacy fallback', () => {
    const { transport, peer } = configure(false);
    const error = vi.fn();
    transport.open({ token: 'fixture-token', appVersion: 'test' }).subscribe({ error });
    peer.open();
    const handshake = peer.expect('session.open');
    peer.disconnect();
    handshake.flush(null);

    expect(error).toHaveBeenCalledWith(expect.objectContaining({ kind: 'disconnected' }));
    expect(transport.state()).toBe(RpcConnectionState.Closed);
    peer.expectNone('auth');
    peer.verify();
  });

  it('uses one handshake deadline across socket establishment and session.open', () => {
    const { transport, peer } = configure(false);
    const neverOpened = vi.fn();
    transport.open({ token: 'fixture-token', appVersion: 'test' }).subscribe({ error: neverOpened });
    vi.advanceTimersByTime(30_000);
    expect(neverOpened).toHaveBeenCalledWith(expect.objectContaining({ kind: 'timeout' }));

    const delayed = vi.fn();
    transport.open({ token: 'fixture-token', appVersion: 'test' }).subscribe({ error: delayed });
    vi.advanceTimersByTime(10_000);
    peer.open();
    const handshake = peer.expect('session.open');
    vi.advanceTimersByTime(20_000);
    expect(delayed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'timeout' }));
    handshake.flush(null);
    peer.verify();
  });

  it('cleans old lifecycle state before synchronous notification re-entry opens a new session', () => {
    const { transport, peer } = configure();
    openAuthenticated(transport, peer, 'old-token');
    transport.notifications$.subscribe((notification) => {
      if (notification.method === 'session.unavailable')
        transport.open({ token: 'new-token', appVersion: 'test' }).subscribe();
    });

    peer.notify('session.unavailable', { reason: 'authLookupUnavailable' });
    peer.open();
    peer.expect('session.open', { protocolVersion: 1, token: 'new-token', appVersion: 'test' }).flush(OPEN_RESULT);
    expect(transport.state()).toBe(RpcConnectionState.Authenticated);
    peer.verify();
  });

  it('cleans rejected handshakes before an error subscriber synchronously opens a new session', () => {
    const { transport, peer } = configure();
    transport.open({ token: 'old-token', appVersion: 'test' }).subscribe({
      error: () => transport.open({ token: 'new-token', appVersion: 'test' }).subscribe(),
    });
    peer.open();
    peer
      .expect('session.open', { protocolVersion: 1, token: 'old-token', appVersion: 'test' })
      .error(RpcErrorCode.Unauthorized, 'Unauthorized');
    peer.open();
    peer.expect('session.open', { protocolVersion: 1, token: 'new-token', appVersion: 'test' }).flush(OPEN_RESULT);
    expect(transport.state()).toBe(RpcConnectionState.Authenticated);
    peer.verify();
  });

  it('projects server RPC errors without HTTP status compatibility', () => {
    const { transport, peer } = configure();
    openAuthenticated(transport, peer);
    const failed = vi.fn();
    transport.call('messages.send', { chatId: '1', message: 'nope' }).subscribe({ error: failed });
    peer.expect('messages.send').error(RpcErrorCode.Forbidden, 'Forbidden');
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ code: RpcErrorCode.Forbidden, message: 'Forbidden' }),
    );
    peer.verify();
  });
  it.each([false, true])('reclaims stalled ordinary slots through reconnect, cancelled: %s', (cancelled) => {
    const { transport, peer } = configure();
    openAuthenticated(transport, peer);
    const errors = vi.fn();
    const subscriptions = Array.from({ length: 16 }, () =>
      transport.call('messages.list').subscribe({ error: errors }),
    );
    const held = peer.match('messages.list');
    if (cancelled) subscriptions.forEach((subscription) => subscription.unsubscribe());
    vi.advanceTimersByTime(30_000);
    expect(errors).toHaveBeenCalledTimes(cancelled ? 0 : 16);
    expect(transport.state()).toBe(RpcConnectionState.Authenticated);
    vi.advanceTimersByTime(60_000);
    expect(transport.state()).toBe(RpcConnectionState.Reconnecting);
    vi.advanceTimersByTime(1_000);
    peer.open();
    peer.expect('session.open').flush(OPEN_RESULT);
    peer.expectNone('messages.list');
    const received = vi.fn();
    transport.call('messages.list').subscribe(received);
    for (const request of held) request.flush({ obsolete: true });
    expect(received).not.toHaveBeenCalled();
    peer.expect('messages.list').flush({ messages: [] });
    expect(received).toHaveBeenCalledWith({ messages: [] });
    vi.advanceTimersByTime(90_000);
    expect(transport.state()).toBe(RpcConnectionState.Authenticated);
    peer.verify();
  });
});
