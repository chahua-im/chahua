import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { vi } from 'vitest';
import { RpcApi } from '../../generated/rpc-api';
import { authInterceptor } from '../api/auth.interceptor';
import { RpcErrorCode } from '../api/rpc-error';
import { RpcTestPeer, provideRpcTesting } from '../api/rpc-testing';
import { testChat, testUser, wireChat, wireMessage } from '../api/testing';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { ChatSettingsChanged, SessionStore } from './session-store';

const TOKEN_KEY = 'jwt_token';
const COOKIE_KEY = `${TOKEN_KEY}_${encodeURIComponent(window.location.origin)}`;

function sessionToken(uid: number, gen: number, claims: Record<string, unknown> = {}) {
  const payload = btoa(JSON.stringify({ uid, gen, ...claims }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}

function tokenPayload(payload: unknown) {
  return `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify(payload)).replace(/=/g, '')}.signature`;
}

describe('SessionStore', () => {
  let session: SessionStore;
  let peer: RpcTestPeer;
  let http: HttpTestingController;

  beforeEach(() => {
    document.cookie = `${COOKIE_KEY}=; Path=/; Max-Age=0`;
    sessionStorage.clear();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    history.replaceState(null, '', '/?token=test-link-token');
    TestBed.configureTestingModule({
      providers: [
        provideChahuaBaseUrl('/_api'),
        provideRpcTesting(),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    peer = TestBed.inject(RpcTestPeer);
    session = TestBed.inject(SessionStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    try {
      http.verify();
      peer.verify();
    } finally {
      TestBed.resetTestingModule();
      for (const cookie of document.cookie.split('; ')) {
        const key = cookie.split('=')[0];
        if (key.startsWith(TOKEN_KEY) || key.startsWith('chahua.auth.token'))
          document.cookie = `${key}=; Path=/; Max-Age=0`;
      }
      sessionStorage.clear();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      history.replaceState(null, '', '/');
    }
  });

  async function refreshProfile(user = testUser, group = { groupId: 3, name: '三水' }) {
    (await peer.expectAsync('auth.refresh', {})).flush({ token: 'refreshed-token' });
    await Promise.resolve();
    (await peer.expectAsync('users.getMe', {})).flush(user);
    await Promise.resolve();
    (await peer.expectAsync('users.search', { q: String(user.uid), limit: 1 })).flush({
      members: [{ uid: user.uid, userGroup: group }],
      excluded: [],
    });
  }

  async function bootstrap(token = 'test-link-token', user = testUser, group = { groupId: 3, name: '三水' }) {
    peer.open();
    (await peer.expectAsync('session.open', { protocolVersion: 1, token, appVersion: 'PWA2-dev' })).flush({
      protocolVersion: 1,
      authenticated: true,
      uid: user.uid,
      clientId: 'fixture-client',
    });
    await Promise.resolve();
    await refreshProfile(user, group);
  }

  it.each([
    {
      stored: sessionToken(42, 7, { cid: 'old-client' }),
      incoming: sessionToken(42, 7, { ver: 2, cid: 'discuz-client', iat: 1 }),
      key: TOKEN_KEY,
    },
    {
      stored: sessionToken(42, 7, { ver: 2, cid: 'old-client', iat: 2 }),
      incoming: sessionToken(42, 7, { cid: 'discuz-client' }),
      key: 'chahua.auth.token',
    },
  ])(
    'keeps a matching URL identity from either persisted token store and refreshes over RPC',
    async ({ stored, incoming, key }) => {
      localStorage.setItem(key, stored);
      history.replaceState(null, '', `/landing?token=${incoming}&example=preserved#install`);

      session.restoreToken();
      expect(session.token()).toBe(stored);
      expect(location.pathname + location.search + location.hash).toBe('/landing?example=preserved#install');
      expect(localStorage.getItem(TOKEN_KEY)).toBe(stored);
      expect(localStorage.getItem('chahua.auth.token')).toBeNull();
      expect(document.cookie).toContain(`${COOKIE_KEY}=${stored}`);

      const initialize = session.initialize();
      await bootstrap(stored);
      await initialize;
      expect(session.user()).toMatchObject({ ...testUser, userGroup: { groupId: 3 } });
      expect(session.token()).toBe('refreshed-token');
      expect(document.cookie).toContain(`${COOKIE_KEY}=refreshed-token`);
    },
  );

  it('adopts a changed URL identity and clears the prior account before accepting new results', async () => {
    session.user.set({ ...testUser, uid: 1, username: '旧账户' });
    const oldToken = sessionToken(1, 1);
    const nextToken = sessionToken(2, 1);
    session.token.set(oldToken);
    history.replaceState(null, '', `/?token=${nextToken}`);

    session.restoreToken();
    const initialize = session.initialize();
    expect(session.user()).toBeUndefined();
    await bootstrap(nextToken, { ...testUser, uid: 2, username: '新账户' });
    await initialize;
    expect(session.user()).toMatchObject({ uid: 2, username: '新账户' });
  });

  it('retains credentials for unavailable RPC failures and clears only unauthorized credentials', async () => {
    session.restoreToken();
    let initialize = session.initialize();
    peer.open();
    (await peer.expectAsync('session.open')).error(RpcErrorCode.Unavailable);
    await expect(initialize).rejects.toMatchObject({ code: RpcErrorCode.Unavailable });
    expect(session.token()).toBe('test-link-token');

    initialize = session.initialize();
    peer.open();
    (await peer.expectAsync('session.open')).error(RpcErrorCode.Unauthorized);
    await expect(initialize).rejects.toMatchObject({ code: RpcErrorCode.Unauthorized });
    expect(session.token()).toBeUndefined();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(document.cookie).not.toContain(`${COOKIE_KEY}=`);
  });

  it('keeps login usable when optional group hydration is unavailable', async () => {
    session.restoreToken();
    const initialize = session.initialize();
    peer.open();
    (await peer.expectAsync('session.open')).flush({
      protocolVersion: 1,
      authenticated: true,
      uid: testUser.uid,
      clientId: 'fixture-client',
    });
    await Promise.resolve();
    (await peer.expectAsync('auth.refresh', {})).flush({ token: 'refreshed-token' });
    await Promise.resolve();
    (await peer.expectAsync('users.getMe', {})).flush(testUser);
    await Promise.resolve();
    (await peer.expectAsync('users.search', { q: String(testUser.uid), limit: 1 })).error(RpcErrorCode.Unavailable);
    await initialize;

    expect(session.user()).toEqual(testUser);
    expect(session.token()).toBe('refreshed-token');
  });

  it('runs anonymous development bootstrap, persists its reconnect credential before refresh, and retains the client ID', async () => {
    sessionStorage.setItem('uid', '7');
    history.replaceState(null, '', '/chats');
    session.restoreToken();
    const initialize = session.initialize();
    peer.open();
    (await peer.expectAsync('session.open', { protocolVersion: 1, appVersion: 'PWA2-dev' })).flush({
      protocolVersion: 1,
      authenticated: false,
    });
    await Promise.resolve();
    const dev = await peer.expectAsync('auth.createDevSession');
    expect(dev.params).toMatchObject({ uid: 7, clientId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    dev.flush({ token: sessionToken(7, 1) });
    await Promise.resolve();
    (await peer.expectAsync('auth.refresh', {})).flush({ token: 'refreshed-token' });
    await Promise.resolve();
    (await peer.expectAsync('users.getMe', {})).flush({ ...testUser, uid: 7 });
    await Promise.resolve();
    (await peer.expectAsync('users.search', { q: '7', limit: 1 })).flush({ members: [], excluded: [] });
    await initialize;

    expect(session.token()).toBe('refreshed-token');
    expect(localStorage.getItem('chahua.client-id')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('defaults an anonymous development session to UID 1', async () => {
    history.replaceState(null, '', '/chats');
    session.restoreToken();
    const initialize = session.initialize();
    peer.open();
    (await peer.expectAsync('session.open', { protocolVersion: 1, appVersion: 'PWA2-dev' })).flush({
      protocolVersion: 1,
      authenticated: false,
    });
    await Promise.resolve();
    const dev = await peer.expectAsync('auth.createDevSession');
    expect(dev.params?.['uid']).toBe(1);
    dev.flush({ token: sessionToken(1, 1) });
    await Promise.resolve();
    await refreshProfile();
    await initialize;
  });

  it('falls back to an existing credential when development session issuance fails', async () => {
    const fallback = sessionToken(1, 2);
    localStorage.setItem(TOKEN_KEY, fallback);
    history.replaceState(null, '', '/chats');
    session.restoreToken();
    const initialize = session.initialize();
    peer.open();
    (await peer.expectAsync('session.open', { protocolVersion: 1, appVersion: 'PWA2-dev' })).flush({
      protocolVersion: 1,
      authenticated: false,
    });
    await Promise.resolve();
    (await peer.expectAsync('auth.createDevSession')).error(RpcErrorCode.NotFound);
    await Promise.resolve();
    await bootstrap(fallback);
    await initialize;

    expect(session.user()).toMatchObject(testUser);
  });

  it('refreshes a same-account credential without reopening the authenticated socket or clearing known profile data', async () => {
    const token = sessionToken(testUser.uid, 3);
    history.replaceState(null, '', `/?token=${token}`);
    session.restoreToken();
    const first = session.initialize();
    peer.open();
    (await peer.expectAsync('session.open')).flush({
      protocolVersion: 1,
      authenticated: true,
      uid: testUser.uid,
      clientId: 'fixture-client',
    });
    await Promise.resolve();
    (await peer.expectAsync('auth.refresh', {})).flush({ token });
    await Promise.resolve();
    (await peer.expectAsync('users.getMe', {})).flush({ ...testUser, username: '已知资料' });
    await Promise.resolve();
    (await peer.expectAsync('users.search', { q: String(testUser.uid), limit: 1 })).flush({
      members: [{ uid: testUser.uid, userGroup: { groupId: 3, name: '三水' } }],
      excluded: [],
    });
    await first;

    const refresh = session.initialize();
    peer.expectNone('session.open');
    expect(session.user()?.username).toBe('已知资料');
    (await peer.expectAsync('auth.refresh', {})).flush({ token });
    await Promise.resolve();
    (await peer.expectAsync('users.getMe', {})).flush({ ...testUser, username: '已知资料' });
    await Promise.resolve();
    (await peer.expectAsync('users.search', { q: String(testUser.uid), limit: 1 })).error(RpcErrorCode.Unavailable);
    await refresh;
    expect(session.user()?.userGroup).toEqual({ groupId: 3, name: '三水' });

    const hydrated = session.initialize();
    (await peer.expectAsync('auth.refresh', {})).flush({ token });
    await Promise.resolve();
    (await peer.expectAsync('users.getMe', {})).flush({ ...testUser, username: '已知资料' });
    await Promise.resolve();
    (await peer.expectAsync('users.search', { q: String(testUser.uid), limit: 1 })).flush({
      members: [],
      excluded: [],
    });
    await hydrated;
    expect(session.user()?.userGroup).toBeUndefined();
  });

  it('keeps a same-UID authenticated development session live while refreshing its profile', async () => {
    history.replaceState(null, '', '/chats');
    peer.authenticate({ uid: testUser.uid });
    session.token.set(sessionToken(testUser.uid, 6));
    session.user.set({ ...testUser, username: '已知资料' });

    const initialize = session.initialize();
    peer.expectNone('session.open');
    peer.expectNone('auth.createDevSession');
    (await peer.expectAsync('auth.refresh', {})).flush({ token: sessionToken(testUser.uid, 6) });
    await Promise.resolve();
    (await peer.expectAsync('users.getMe', {})).flush({ ...testUser, username: '已知资料' });
    await Promise.resolve();
    (await peer.expectAsync('users.search', { q: String(testUser.uid), limit: 1 })).flush({
      members: [],
      excluded: [],
    });
    await initialize;

    expect(session.user()?.username).toBe('已知资料');
  });

  it('does not let a canceled bootstrap failure clear or rebind a newer attempt', async () => {
    const token = sessionToken(testUser.uid, 4);
    history.replaceState(null, '', `/?token=${token}`);
    session.restoreToken();
    const first = session.initialize();
    peer.open();
    const stale = await peer.expectAsync('session.open');

    const current = session.initialize();
    peer.open();
    (await peer.expectAsync('session.open')).flush({
      protocolVersion: 1,
      authenticated: true,
      uid: testUser.uid,
      clientId: 'fixture-client',
    });
    stale.error(RpcErrorCode.Unauthorized);
    await Promise.resolve();
    (await peer.expectAsync('auth.refresh', {})).flush({ token });
    await Promise.resolve();
    (await peer.expectAsync('users.getMe', {})).flush(testUser);
    await Promise.resolve();
    (await peer.expectAsync('users.search', { q: String(testUser.uid), limit: 1 })).flush({
      members: [],
      excluded: [],
    });
    await current;
    await first;

    expect(session.token()).toBe(token);
    expect(session.user()).toEqual(testUser);
  });

  it('ignores a canceled bootstrap reply after a newer attempt owns the transport', async () => {
    const token = sessionToken(testUser.uid, 5);
    history.replaceState(null, '', `/?token=${token}`);
    session.restoreToken();
    const first = session.initialize();
    peer.open();
    const stale = await peer.expectAsync('session.open');

    const current = session.initialize();
    peer.open();
    (await peer.expectAsync('session.open')).flush({
      protocolVersion: 1,
      authenticated: true,
      uid: testUser.uid,
      clientId: 'fixture-client',
    });
    stale.flush({
      protocolVersion: 1,
      authenticated: true,
      uid: 99,
      clientId: 'stale-client',
    });
    await Promise.resolve();
    (await peer.expectAsync('auth.refresh', {})).flush({ token });
    await Promise.resolve();
    (await peer.expectAsync('users.getMe', {})).flush(testUser);
    await Promise.resolve();
    (await peer.expectAsync('users.search', { q: String(testUser.uid), limit: 1 })).flush({
      members: [],
      excluded: [],
    });
    await current;
    await first;

    expect(session.token()).toBe(token);
    expect(session.user()).toEqual(testUser);
  });
  it('does not open a production socket without credentials', async () => {
    vi.stubGlobal('ngDevMode', false);
    history.replaceState(null, '', '/chats');
    session.restoreToken();

    await session.initialize();

    expect(session.token()).toBeUndefined();
    expect(() => peer.latest).toThrow('No RPC socket has been created');
  });

  it('cancels a timed-out initialization, retains credentials, and permits a clean retry', async () => {
    vi.useFakeTimers();
    session.restoreToken();
    const first = session.initialize();
    peer.open();
    const stalled = await peer.expectAsync('session.open');
    const rejection = expect(first).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    stalled.flush({
      protocolVersion: 1,
      authenticated: true,
      uid: testUser.uid,
      clientId: 'fixture-client',
    });
    expect(session.token()).toBe('test-link-token');
    expect(session.user()).toBeUndefined();

    const retry = session.initialize();
    await bootstrap('test-link-token');
    await retry;
    expect(session.user()).toMatchObject(testUser);
  });

  it('adopts own profiles from decoded RPC events', () => {
    peer.authenticate();
    session.user.set({ ...testUser, username: '旧名字' });

    peer.notify('events.message', {
      ...wireMessage,
      sender: { uid: testUser.uid, name: '事件里的新名字', gender: testUser.gender },
    });

    expect(session.user()?.username).toBe('事件里的新名字');
  });

  it('applies confirmed account-settings writes and rejects stale post-logout responses', async () => {
    peer.authenticate();
    session.user.set(testUser);
    const saving = session.setShowMembershipMessages(false);
    (await peer.expectAsync('users.updateChatSettings', { showMembershipMessages: false })).flush({
      showMembershipMessages: false,
    });
    await saving;
    expect(session.user()?.showMembershipMessages).toBe(false);

    const delayed = session.setShowMembershipMessages(true);
    const request = await peer.expectAsync('users.updateChatSettings', { showMembershipMessages: true });
    const canceled = expect(delayed).rejects.toMatchObject({ kind: 'disconnected' });
    session.logout();
    request.flush({ showMembershipMessages: true });
    await canceled;
    expect(session.user()).toBeUndefined();
  });

  it('preserves account-setting version guards', () => {
    session.user.set(testUser);
    const requested = session.user();
    session.user.set({ ...testUser, showMembershipMessages: false });
    expect(() => session.requireChatSettings({ showMembershipMessages: true }, requested)).toThrow(ChatSettingsChanged);
  });

  it('loads account membership visibility at startup and after refreshing the session', async () => {
    localStorage.setItem('chahua.preferences.showMembershipMessages', 'true');
    session.restoreToken();
    let token = 'test-link-token';
    for (const showMembershipMessages of [false, true]) {
      const initialize = session.initialize();
      await bootstrap(token, { ...testUser, showMembershipMessages });
      await initialize;
      token = 'refreshed-token';
      expect(session.user()?.showMembershipMessages).toBe(showMembershipMessages);
      peer.expectNone('users.updateChatSettings');
    }
  });

  it('applies confirmed membership changes without overwriting newer profile fields or failed writes', async () => {
    peer.authenticate();
    session.user.set(testUser);
    const saving = session.setShowMembershipMessages(false);
    const request = await peer.expectAsync('users.updateChatSettings', { showMembershipMessages: false });
    expect(session.user()?.showMembershipMessages).toBe(true);
    session.user.update((user) => user && { ...user, username: '新名字' });
    request.flush({ showMembershipMessages: false });
    await saving;
    expect(session.user()).toMatchObject({ showMembershipMessages: false, username: '新名字' });
    expect(localStorage.getItem('chahua.preferences.showMembershipMessages')).toBeNull();

    const failed = session.setShowMembershipMessages(true);
    (await peer.expectAsync('users.updateChatSettings', { showMembershipMessages: true })).error(
      RpcErrorCode.Unavailable,
    );
    await expect(failed).rejects.toMatchObject({ code: RpcErrorCode.Unavailable });
    expect(session.user()?.showMembershipMessages).toBe(false);
  });

  it('adopts confirmed membership changes from a later read', async () => {
    peer.authenticate();
    session.user.set(testUser);
    const saving = session.setShowMembershipMessages(false);
    (await peer.expectAsync('users.updateChatSettings', { showMembershipMessages: false })).flush({
      showMembershipMessages: false,
    });
    await saving;
    session.acceptChatSettings({ showMembershipMessages: true }, testUser.uid);
    expect(session.user()?.showMembershipMessages).toBe(true);
  });

  it.each([1, 2])('ignores a delayed membership write after logout and login as UID %s', async (uid) => {
    peer.authenticate();
    session.user.set(testUser);
    const saving = session.setShowMembershipMessages(false);
    const request = await peer.expectAsync('users.updateChatSettings', { showMembershipMessages: false });
    const canceled = expect(saving).rejects.toMatchObject({ kind: 'disconnected' });
    session.logout();
    session.user.set({ ...testUser, uid, showMembershipMessages: true });
    request.flush({ showMembershipMessages: false });
    await canceled;
    expect(session.user()?.showMembershipMessages).toBe(true);
  });

  it('does not issue a development session when a matching URL token retains the stored token', async () => {
    const stored = sessionToken(42, 7, { cid: 'stored-client' });
    const incoming = sessionToken(42, 7, { ver: 2, cid: 'redirect-client', iat: 1 });
    localStorage.setItem(TOKEN_KEY, stored);
    history.replaceState(null, '', `/?token=${incoming}`);
    session.restoreToken();

    const initialize = session.initialize();
    peer.expectNone('auth.createDevSession');
    await bootstrap(stored);
    await initialize;
  });

  it('adopts a URL token when only its generation changes', () => {
    const stored = sessionToken(42, 7);
    const incoming = sessionToken(42, 8);
    localStorage.setItem(TOKEN_KEY, stored);
    history.replaceState(null, '', `/?token=${incoming}`);

    session.restoreToken();

    expect(session.token()).toBe(incoming);
    expect(localStorage.getItem(TOKEN_KEY)).toBe(incoming);
  });

  it('keeps a cookie-only installed-PWA token for a matching URL identity', () => {
    vi.stubGlobal('ngDevMode', false);
    const stored = sessionToken(42, 7, { cid: 'installed-client' });
    const incoming = sessionToken(42, 7, { ver: 2, cid: 'browser-client', iat: 1 });
    history.replaceState(null, '', `/?token=${incoming}`);
    document.cookie = `${TOKEN_KEY}=${stored}; Path=/`;

    session.restoreToken();

    expect(session.token()).toBe(stored);
    expect(localStorage.getItem(TOKEN_KEY)).toBe(stored);
    expect(document.cookie).toContain(`${TOKEN_KEY}=${stored}`);
  });

  it.each([
    'not-a-jwt',
    'header.!.signature',
    tokenPayload({}),
    tokenPayload({ uid: 42, gen: 7.5 }),
    tokenPayload({ uid: Number.MAX_SAFE_INTEGER + 1, gen: 7 }),
  ])('adopts the URL token when the stored token is not comparable (%s)', (stored) => {
    const incoming = sessionToken(42, 7);
    localStorage.setItem(TOKEN_KEY, stored);
    history.replaceState(null, '', `/?token=${incoming}`);

    session.restoreToken();

    expect(session.token()).toBe(incoming);
  });

  it('keeps URL precedence when its payload cannot be compared', () => {
    const stored = sessionToken(42, 7);
    const incoming = 'header.!.signature';
    localStorage.setItem(TOKEN_KEY, stored);
    history.replaceState(null, '', `/?token=${incoming}&example=preserved#install`);

    session.restoreToken();

    expect(session.token()).toBe(incoming);
    expect(location.pathname + location.search + location.hash).toBe('/?example=preserved#install');
  });

  it.each([
    { urlToken: undefined, storedToken: undefined, cookieToken: undefined, expected: 'development-token' },
    { urlToken: undefined, storedToken: undefined, cookieToken: 'cookie-token', expected: 'cookie-token' },
    { urlToken: undefined, storedToken: 'stored-token', cookieToken: undefined, expected: 'stored-token' },
    { urlToken: undefined, storedToken: 'stored-token', cookieToken: 'old-cookie-token', expected: 'stored-token' },
    { urlToken: 'url-token', storedToken: 'stored-token', cookieToken: 'cookie-token', expected: 'url-token' },
  ])(
    'uses URL, localStorage, cookie, then the development fallback (%s)',
    async ({ urlToken, storedToken, cookieToken, expected }) => {
      vi.stubGlobal('CHAHUA_DEV_TOKEN', 'development-token');
      history.replaceState(null, '', urlToken ? `/?token=${urlToken}` : '/chats');
      if (storedToken) localStorage.setItem(TOKEN_KEY, storedToken);
      if (cookieToken) document.cookie = `${COOKIE_KEY}=${cookieToken}; Path=/`;

      session.restoreToken();
      const initialize = session.initialize();
      await bootstrap(expected);
      await initialize;

      expect(session.user()).toEqual(expect.objectContaining(testUser));
      expect(localStorage.getItem(TOKEN_KEY)).toBe('refreshed-token');
      expect(document.cookie).toContain(`${COOKIE_KEY}=refreshed-token`);
    },
  );

  it('does not adopt shared or other-origin development cookies when targeting production', async () => {
    vi.stubGlobal('CHAHUA_DEV_BACKEND', false);
    history.replaceState(null, '', '/chats');
    document.cookie = `${TOKEN_KEY}=unscoped-local-token; Path=/`;
    document.cookie = 'chahua.auth.token=legacy-local-token; Path=/';
    const otherPort = new URL(window.location.origin);
    otherPort.port = otherPort.port === '24443' ? '24444' : '24443';
    const otherProtocol = new URL(window.location.origin);
    otherProtocol.protocol = otherProtocol.protocol === 'http:' ? 'https:' : 'http:';
    for (const origin of [otherPort.origin, otherProtocol.origin])
      document.cookie = `${TOKEN_KEY}_${encodeURIComponent(origin)}=other-origin-token; Path=/`;
    const cookies = document.cookie;

    session.restoreToken();
    await session.initialize();

    expect(session.token()).toBeUndefined();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(() => peer.latest).toThrow('No RPC socket has been created');
    session.logout();
    expect(document.cookie).toBe(cookies);
  });

  it('keeps production cookie restoration and logout compatible with installed PWAs', () => {
    vi.stubGlobal('ngDevMode', false);
    history.replaceState(null, '', '/chats');
    document.cookie = `${TOKEN_KEY}=installed-pwa-token; Path=/`;
    document.cookie = `${COOKIE_KEY}=development-token; Path=/`;

    session.restoreToken();
    expect(session.token()).toBe('installed-pwa-token');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('installed-pwa-token');
    session.logout();
    expect(document.cookie).not.toContain(`${TOKEN_KEY}=`);
    expect(document.cookie).toContain(`${COOKIE_KEY}=development-token`);
  });

  it('saves a landing token synchronously without requests and preserves other URL fields', () => {
    history.replaceState(null, '', '/landing?token=landing-token&example=preserved#install');

    expect(session.restoreToken()).toBeUndefined();
    expect(session.token()).toBe('landing-token');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('landing-token');
    expect(document.cookie).toContain(`${COOKIE_KEY}=landing-token`);
    expect(location.pathname + location.search + location.hash).toBe('/landing?example=preserved#install');
    expect(session.user()).toBeUndefined();
    expect(() => peer.latest).toThrow('No RPC socket has been created');
  });

  it('surfaces a failed development session without refreshing when no stored credential exists', async () => {
    history.replaceState(null, '', '/chats');
    session.restoreToken();
    const initialize = session.initialize();
    peer.open();
    (await peer.expectAsync('session.open', { protocolVersion: 1, appVersion: 'PWA2-dev' })).flush({
      protocolVersion: 1,
      authenticated: false,
    });
    await Promise.resolve();
    (await peer.expectAsync('auth.createDevSession')).error(RpcErrorCode.NotFound);

    await expect(initialize).rejects.toMatchObject({ code: RpcErrorCode.NotFound });
    peer.expectNone('auth.refresh');
    expect(session.token()).toBeUndefined();
  });

  it('clears persistent token stores on logout so a cookie cannot sign the user back in', async () => {
    session.restoreToken();
    const initialize = session.initialize();
    await bootstrap();
    await initialize;

    session.logout();

    expect(session.token()).toBeUndefined();
    expect(session.user()).toBeUndefined();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(document.cookie).not.toContain(`${COOKIE_KEY}=`);
    session.restoreToken();
    expect(session.token()).toBeUndefined();
  });

  it('shares the login deadline with optional hydration and ignores its real late reply', async () => {
    vi.useFakeTimers();
    session.restoreToken();
    const initialize = session.initialize();
    peer.open();
    const opened = await peer.expectAsync('session.open');
    await vi.advanceTimersByTimeAsync(20_000);
    opened.flush({
      protocolVersion: 1,
      authenticated: true,
      uid: testUser.uid,
      clientId: 'fixture-client',
    });
    await Promise.resolve();
    (await peer.expectAsync('auth.refresh', {})).flush({ token: 'refreshed-token' });
    await Promise.resolve();
    (await peer.expectAsync('users.getMe', {})).flush(testUser);
    await Promise.resolve();
    const optional = await peer.expectAsync('users.search', { q: String(testUser.uid), limit: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    await initialize;
    optional.flush({ members: [{ uid: testUser.uid, userGroup: { groupId: 3, name: '迟到分组' } }], excluded: [] });

    expect(session.user()).toEqual(testUser);
  });

  it('adopts current profiles from ordinary RPC replies without accepting saved snapshots', async () => {
    peer.authenticate();
    session.user.set({
      ...testUser,
      userGroup: { groupId: 3, name: '三水' },
      avatarUrl: 'https://example.com/old.jpg',
    });
    const api = TestBed.inject(RpcApi);
    const search = firstValueFrom(api.users.search({ q: '99', limit: 1 }));
    (await peer.expectAsync('users.search', { q: '99', limit: 1 })).flush({
      members: [
        {
          uid: testUser.uid,
          username: '新名字',
          gender: 2,
          avatarUrl: 'https://example.com/new.jpg',
          userGroup: { groupId: 4, name: '四水' },
        },
      ],
      excluded: [],
    });
    await search;
    expect(session.user()).toMatchObject({
      username: '新名字',
      gender: 2,
      avatarUrl: 'https://example.com/new.jpg',
      userGroup: { groupId: 4, name: '四水' },
      permissions: testUser.permissions,
      stickerPackOrder: testUser.stickerPackOrder,
    });

    const current = session.user();
    const other = firstValueFrom(api.users.search({ q: '99', limit: 1 }));
    (await peer.expectAsync('users.search', { q: '99', limit: 1 })).flush({
      members: [{ uid: 99, username: '其他人', gender: 2 }],
      excluded: [],
    });
    await other;
    expect(session.user()).toBe(current);

    const saved = firstValueFrom(api.savedMessages.list());
    (await peer.expectAsync('savedMessages.list', {})).flush({
      savedMessages: [{ sender: { uid: testUser.uid, name: '收藏里的旧名字', gender: 1 } }],
    });
    await saved;
    const savedForChat = firstValueFrom(api.savedMessages.listForChat({ chatId: testChat.id }));
    (await peer.expectAsync('savedMessages.listForChat', { chatId: wireChat.id })).flush({
      savedMessages: [{ sender: { uid: testUser.uid, name: '聊天收藏里的旧名字', gender: 1 } }],
    });
    await savedForChat;
    expect(session.user()?.username).toBe('新名字');
  });

  it('accepts cleared group and avatar fields without clearing absent partial-profile information', () => {
    session.user.set({
      ...testUser,
      userGroup: { groupId: 3, name: '三水' },
      avatarUrl: 'https://example.com/old.jpg',
    });
    session.updateProfile({
      reactions: [{ reactors: [{ uid: testUser.uid, name: '头像表态者', avatarUrl: 'https://example.com/new.jpg' }] }],
    });
    expect(session.user()).toMatchObject({
      username: '头像表态者',
      avatarUrl: 'https://example.com/new.jpg',
      gender: testUser.gender,
      userGroup: { groupId: 3 },
    });
    session.updateProfile(testUser);
    expect(session.user()?.userGroup?.groupId).toBe(3);
    session.updateProfile({
      members: [{ uid: testUser.uid, username: '新名字', gender: 2, avatarUrl: null, userGroup: null }],
    });
    expect(session.user()).toMatchObject({ username: '新名字', gender: 2, avatarUrl: null, userGroup: null });
    session.user.set({ ...testUser, userGroup: { groupId: 3 } });
    session.updateProfile({ sender: { uid: testUser.uid, name: testUser.username, gender: testUser.gender } });
    expect(session.user()?.userGroup).toBeUndefined();
    session.logout();
    session.updateProfile({ sender: { uid: testUser.uid, name: '迟到的响应', gender: 2 } });
    expect(session.user()).toBeUndefined();
  });

  it('keeps bearer and app-version interception only for real same-origin HTTP byte requests', () => {
    session.token.set('upload-token');
    const client = TestBed.inject(HttpClient);
    const body = new FormData();
    body.append('file', new Blob(['sticker']), 'sticker.png');
    client.post('/_api/stickers/packs/1/stickers', body).subscribe();
    const upload = http.expectOne('/_api/stickers/packs/1/stickers');
    expect(upload.request.body).toBe(body);
    expect(upload.request.headers.get('Authorization')).toBe('Bearer upload-token');
    expect(upload.request.headers.get('X-App-Version')).toBe('PWA2-dev');
    upload.flush({});

    client.get('/assets/example.json').subscribe();
    const asset = http.expectOne('/assets/example.json');
    expect(asset.request.headers.has('Authorization')).toBe(false);
    expect(asset.request.headers.has('X-App-Version')).toBe(false);
    asset.flush({});
  });
});
