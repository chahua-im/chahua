import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import type { UserGroupTagInfo } from '../../generated/models';
import { authInterceptor } from '../api/auth.interceptor';
import { jsonInterceptor } from '../api/json.interceptor';
import { testUser } from '../api/testing';
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
        provideHttpClient(withInterceptors([authInterceptor, jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
      ],
    });
    session = TestBed.inject(SessionStore);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    for (const cookie of document.cookie.split('; ')) {
      const key = cookie.split('=')[0];
      if (key.startsWith(TOKEN_KEY) || key.startsWith('chahua.auth.token')) {
        document.cookie = `${key}=; Path=/; Max-Age=0`;
      }
    }
    sessionStorage.clear();
    http.verify();
    vi.unstubAllGlobals();
    history.replaceState(null, '', '/');
  });

  async function profile(userGroup?: UserGroupTagInfo) {
    await Promise.resolve();
    const request = http.expectOne(`/_api/users/search?q=${testUser.uid}&limit=1`);
    expect(request.request.headers.get('Authorization')).toBe(`Bearer ${session.token()}`);
    request.flush({ members: [{ uid: testUser.uid, userGroup }], excluded: [] });
  }

  it('loads account membership visibility at startup and after refreshing the session', async () => {
    localStorage.setItem('chahua.preferences.showMembershipMessages', 'true');
    session.restoreToken();
    for (const showMembershipMessages of [false, true]) {
      const initializing = session.initialize();
      http.expectOne('/_api/auth/refresh').flush({ token: 'refreshed-token' });
      await Promise.resolve();
      http.expectOne('/_api/users/me').flush({ ...testUser, showMembershipMessages });
      await profile();
      await initializing;
      expect(session.user()?.showMembershipMessages).toBe(showMembershipMessages);
      http.expectNone('/_api/users/me/chat-settings');
    }
  });

  it('applies a saved membership preference only after confirmation and preserves other account fields', async () => {
    session.user.set({ ...testUser });
    const saving = session.setShowMembershipMessages(false);
    const request = http.expectOne('/_api/users/me/chat-settings');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ showMembershipMessages: false });
    expect(session.user()?.showMembershipMessages).toBe(true);
    session.user.update((user) => user && { ...user, username: 'new name' });
    request.flush({ showMembershipMessages: false });
    await saving;
    expect(session.user()?.showMembershipMessages).toBe(false);
    expect(session.user()?.username).toBe('new name');
    expect(localStorage.getItem('chahua.preferences.showMembershipMessages')).toBeNull();
    const failed = session.setShowMembershipMessages(true);
    const rejection = expect(failed).rejects.toBeDefined();
    http.expectOne('/_api/users/me/chat-settings').flush('', { status: 503, statusText: 'Unavailable' });
    await rejection;
    expect(session.user()?.showMembershipMessages).toBe(false);
  });

  it('applies confirmed saves and learns changes from another device on a later read', async () => {
    session.user.set(testUser);
    const saving = session.setShowMembershipMessages(false);
    http.expectOne('/_api/users/me/chat-settings').flush({ showMembershipMessages: false });
    await saving;
    expect(session.user()?.showMembershipMessages).toBe(false);
    session.acceptChatSettings({ showMembershipMessages: true }, testUser.uid);
    expect(session.user()?.showMembershipMessages).toBe(true);
  });

  it('rejects a page started before the local preference changed', async () => {
    session.user.set(testUser);
    const requestedUser = session.user();
    const saving = session.setShowMembershipMessages(false);
    http.expectOne('/_api/users/me/chat-settings').flush({ showMembershipMessages: false });
    await saving;
    expect(() => session.requireChatSettings({ showMembershipMessages: true }, requestedUser)).toThrow(
      ChatSettingsChanged,
    );
    expect(session.user()?.showMembershipMessages).toBe(false);
  });

  it.each([1, 2])('ignores a delayed settings response after logout and login as UID %s', async (uid) => {
    session.user.set({ ...testUser });
    const saving = session.setShowMembershipMessages(false);
    const request = http.expectOne('/_api/users/me/chat-settings');
    session.logout();
    session.user.set({ ...testUser, uid, showMembershipMessages: true });
    request.flush({ showMembershipMessages: false });
    await saving;
    expect(session.user()?.showMembershipMessages).toBe(true);
  });

  it('does not adopt shared or other-origin development cookies when targeting production', async () => {
    vi.stubGlobal('CHAHUA_DEV_BACKEND', false);
    history.replaceState(null, '', '/chats');
    document.cookie = `${TOKEN_KEY}=unscoped-local-token; Path=/`;
    document.cookie = 'chahua.auth.token=legacy-local-token; Path=/';
    const otherPort = new URL(window.location.origin);
    otherPort.port = otherPort.port === '24443' ? '24444' : '24443';
    const otherProtocol = new URL(window.location.origin);
    otherProtocol.protocol = otherProtocol.protocol === 'http:' ? 'https:' : 'http:';
    for (const origin of [otherPort.origin, otherProtocol.origin]) {
      document.cookie = `${TOKEN_KEY}_${encodeURIComponent(origin)}=other-origin-token; Path=/`;
    }
    const cookies = document.cookie;
    session.restoreToken();
    await session.initialize();
    expect(session.token()).toBeUndefined();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    http.expectNone(() => true);
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
    expect(document.cookie).toContain(`${TOKEN_KEY}=installed-pwa-token`);
    session.logout();
    expect(document.cookie).not.toContain(`${TOKEN_KEY}=`);
    expect(document.cookie).toContain(`${COOKIE_KEY}=development-token`);
    http.expectNone(() => true);
  });

  it('saves a landing token synchronously without requests and preserves the other URL fields', () => {
    history.replaceState(null, '', '/landing?token=landing-token&example=preserved#install');
    expect(session.restoreToken()).toBeUndefined();
    expect(session.token()).toBe('landing-token');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('landing-token');
    expect(document.cookie).toContain(`${COOKIE_KEY}=landing-token`);
    expect(location.pathname + location.search + location.hash).toBe('/landing?example=preserved#install');
    expect(session.user()).toBeUndefined();
    http.expectNone(() => true);
  });

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
  ])('keeps the existing token for a matching URL identity', ({ stored, incoming, key }) => {
    localStorage.setItem(key, stored);
    history.replaceState(null, '', `/landing?token=${incoming}&example=preserved#install`);

    session.restoreToken();

    expect(session.token()).toBe(stored);
    expect(localStorage.getItem(TOKEN_KEY)).toBe(stored);
    expect(localStorage.getItem('chahua.auth.token')).toBeNull();
    expect(location.pathname + location.search + location.hash).toBe('/landing?example=preserved#install');
  });

  it('does not issue a development session when a matching URL token retains the stored token', async () => {
    const stored = sessionToken(42, 7, { cid: 'stored-client' });
    const incoming = sessionToken(42, 7, { ver: 2, cid: 'redirect-client', iat: 1 });
    localStorage.setItem(TOKEN_KEY, stored);
    history.replaceState(null, '', `/?token=${incoming}`);
    session.restoreToken();

    const startup = session.initialize();

    http.expectNone('/_api/auth/dev-session');
    const refresh = http.expectOne('/_api/auth/refresh');
    expect(refresh.request.headers.get('Authorization')).toBe(`Bearer ${stored}`);
    refresh.flush({ token: 'refreshed-token' });
    await Promise.resolve();
    http.expectOne('/_api/users/me').flush(testUser);
    await profile();
    await startup;
  });

  it.each([
    { stored: sessionToken(42, 7), incoming: sessionToken(43, 7), reason: 'UID changes' },
    { stored: sessionToken(42, 7), incoming: sessionToken(42, 8), reason: 'generation changes' },
  ])('adopts the URL token when the $reason', ({ stored, incoming }) => {
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

  it('removes the URL token, refreshes it, and uses the new token for the current user', async () => {
    session.restoreToken();
    const login = session.initialize();
    expect(location.search).toBe('');
    const refresh = http.expectOne('/_api/auth/refresh');
    expect(refresh.request.headers.get('Authorization')).toBe('Bearer test-link-token');
    expect(refresh.request.headers.get('X-App-Version')).toBe('PWA2-dev');
    refresh.flush({ token: 'test-refreshed-token' });
    await Promise.resolve();
    const me = http.expectOne('/_api/users/me');
    expect(me.request.headers.get('Authorization')).toBe('Bearer test-refreshed-token');
    expect(me.request.headers.get('X-App-Version')).toBe('PWA2-dev');
    me.flush(testUser);
    const userGroup = { groupId: 3, name: '三水', chatGroupColor: '#4087d2', chatGroupColorDark: '#72a7de' };
    await profile(userGroup);
    await login;
    expect(session.user()).toEqual({ ...testUser, userGroup });
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe('test-refreshed-token');
    expect(document.cookie).toContain(`${COOKIE_KEY}=test-refreshed-token`);
    TestBed.inject(HttpClient).get('/assets/example.json').subscribe();
    const asset = http.expectOne('/assets/example.json');
    expect(asset.request.headers.has('Authorization')).toBe(false);
    expect(asset.request.headers.has('X-App-Version')).toBe(false);
    asset.flush({});
  });

  it.each([
    { urlToken: undefined, storedToken: undefined, cookieToken: undefined, expected: 'development-token' },
    { urlToken: undefined, storedToken: undefined, cookieToken: 'cookie-token', expected: 'cookie-token' },
    { urlToken: undefined, storedToken: 'stored-token', cookieToken: undefined, expected: 'stored-token' },
    { urlToken: undefined, storedToken: 'stored-token', cookieToken: 'old-cookie-token', expected: 'stored-token' },
    { urlToken: 'url-token', storedToken: 'stored-token', cookieToken: 'cookie-token', expected: 'url-token' },
  ])(
    'uses URL, localStorage, cookie, then the development fallback ($expected)',
    async ({ urlToken, storedToken, cookieToken, expected }) => {
      vi.stubGlobal('CHAHUA_DEV_TOKEN', 'development-token');
      history.replaceState(null, '', urlToken ? `/?token=${urlToken}` : '/chats');
      if (storedToken) localStorage.setItem(TOKEN_KEY, storedToken);
      if (cookieToken) document.cookie = `${COOKIE_KEY}=${cookieToken}; Path=/`;
      session.restoreToken();
      const startup = session.initialize();
      const refresh = http.expectOne('/_api/auth/refresh');
      expect(refresh.request.headers.get('Authorization')).toBe(`Bearer ${expected}`);
      expect(localStorage.getItem(TOKEN_KEY)).toBe(expected);
      expect(document.cookie).toContain(`${COOKIE_KEY}=${expected}`);
      refresh.flush({ token: 'refreshed-token' });
      await Promise.resolve();
      http.expectOne('/_api/users/me').flush(testUser);
      await profile();
      await startup;
      expect(session.user()).toEqual(testUser);
      expect(localStorage.getItem(TOKEN_KEY)).toBe('refreshed-token');
      expect(document.cookie).toContain(`${COOKIE_KEY}=refreshed-token`);
    },
  );

  it('retains a token for network retry and clears an expired token', async () => {
    session.restoreToken();
    let login = session.initialize();
    http.expectOne('/_api/auth/refresh').flush('', { status: 503, statusText: 'Unavailable' });
    await expect(login).rejects.toMatchObject({ status: 503 });
    expect(session.token()).toBe('test-link-token');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('test-link-token');
    expect(document.cookie).toContain(`${COOKIE_KEY}=test-link-token`);
    login = session.initialize();
    http.expectOne('/_api/auth/refresh').flush('', { status: 401, statusText: 'Unauthorized' });
    await expect(login).rejects.toMatchObject({ status: 401 });
    expect(session.token()).toBeUndefined();
    expect(session.user()).toBeUndefined();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(document.cookie).not.toContain(`${COOKIE_KEY}=`);
    session.restoreToken();
    expect(session.token()).toBeUndefined();
  });

  it('keeps login usable when the optional group lookup fails', async () => {
    session.restoreToken();
    const login = session.initialize();
    http.expectOne('/_api/auth/refresh').flush({ token: 'refreshed-token' });
    await Promise.resolve();
    http.expectOne('/_api/users/me').flush(testUser);
    await Promise.resolve();
    http
      .expectOne(`/_api/users/search?q=${testUser.uid}&limit=1`)
      .flush('', { status: 503, statusText: 'Unavailable' });
    await login;
    expect(session.user()).toEqual(testUser);
    expect(session.token()).toBe('refreshed-token');
  });

  it('cancels a timed-out request, retains credentials, and permits a clean retry', async () => {
    vi.useFakeTimers();
    try {
      session.restoreToken();
      const login = session.initialize();
      const rejection = expect(login).rejects.toMatchObject({ name: 'TimeoutError' });
      const stalled = http.expectOne('/_api/auth/refresh');
      await vi.advanceTimersByTimeAsync(30000);
      await rejection;
      expect(stalled.cancelled).toBe(true);
      expect(session.token()).toBe('test-link-token');
      expect(session.user()).toBeUndefined();

      const retry = session.initialize();
      http.expectOne('/_api/auth/refresh').flush({ token: 'retry-token' });
      await Promise.resolve();
      http.expectOne('/_api/users/me').flush(testUser);
      await profile();
      await retry;
      expect(session.user()).toEqual(testUser);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares the login deadline across requests and tolerates an optional lookup timeout', async () => {
    vi.useFakeTimers();
    try {
      session.restoreToken();
      const login = session.initialize();
      const refresh = http.expectOne('/_api/auth/refresh');
      await vi.advanceTimersByTimeAsync(20000);
      refresh.flush({ token: 'refreshed-token' });
      await Promise.resolve();
      http.expectOne('/_api/users/me').flush(testUser);
      await Promise.resolve();
      const optional = http.expectOne(`/_api/users/search?q=${testUser.uid}&limit=1`);
      await vi.advanceTimersByTimeAsync(10000);
      await login;
      expect(optional.cancelled).toBe(true);
      expect(session.user()).toEqual(testUser);
    } finally {
      vi.useRealTimers();
    }
  });

  it('learns current own identity from HTTP replies while leaving saved snapshots and other users alone', async () => {
    const group = { groupId: 3, name: '三水' };
    session.user.set({ ...testUser, userGroup: group });
    const client = TestBed.inject(HttpClient);
    client.get('/_api/chats/example/messages').subscribe();
    http.expectOne('/_api/chats/example/messages').flush({
      chatSettings: { showMembershipMessages: true },
      messages: [
        { sender: { uid: 99, name: '其他人', gender: 2 } },
        {
          sender: {
            uid: testUser.uid,
            name: '新名字',
            gender: 2,
            avatarUrl: 'https://example.com/new.jpg',
            userGroup: { groupId: 4, name: '四水' },
          },
        },
      ],
    });
    expect(session.user()).toMatchObject({
      username: '新名字',
      gender: 2,
      avatarUrl: 'https://example.com/new.jpg',
      userGroup: { groupId: 4, name: '四水' },
      permissions: testUser.permissions,
      stickerPackOrder: testUser.stickerPackOrder,
    });
    const fresh = session.user();
    for (const url of ['/_api/saved-messages', '/_api/chats/example/saved-messages']) {
      client.get(url).subscribe();
      http.expectOne(url).flush({
        chatSettings: { showMembershipMessages: true },
        messages: [{ sender: { uid: testUser.uid, name: '旧名字', gender: 1, userGroup: group } }],
      });
    }
    client.get('/_api/users/search?q=99').subscribe();
    http.expectOne('/_api/users/search?q=99').flush({ members: [{ uid: 99, username: '其他人', gender: 2 }] });
    expect(session.user()).toBe(fresh);
  });

  it('accepts cleared group and avatar fields without clearing information absent from partial profiles', () => {
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

  it('issues a development session without a token using the stored UID', async () => {
    sessionStorage.setItem('uid', '7');
    history.replaceState(null, '', '/chats');
    session.restoreToken();
    const login = session.initialize();
    const devSession = http.expectOne('/_api/auth/dev-session');
    expect(devSession.request.body).toEqual({ uid: 7 });
    expect(devSession.request.headers.get('X-Client-Id')).toMatch(/^[0-9a-f]{32}$/);
    devSession.flush({ token: 'development-token' });
    await Promise.resolve();
    const refresh = http.expectOne('/_api/auth/refresh');
    expect(refresh.request.headers.get('Authorization')).toBe('Bearer development-token');
    refresh.flush({ token: 'refreshed-token' });
    await Promise.resolve();
    http.expectOne('/_api/users/me').flush(testUser);
    await profile();
    await login;
    expect(session.user()).toEqual(testUser);
    expect(localStorage.getItem(TOKEN_KEY)).toBe('refreshed-token');
  });

  it('defaults the development session UID to 1', async () => {
    history.replaceState(null, '', '/chats');
    session.restoreToken();
    const login = session.initialize();
    const devSession = http.expectOne('/_api/auth/dev-session');
    expect(devSession.request.body).toEqual({ uid: 1 });
    devSession.flush({ token: 'development-token' });
    await Promise.resolve();
    http.expectOne('/_api/auth/refresh').flush({ token: 'refreshed-token' });
    await Promise.resolve();
    http.expectOne('/_api/users/me').flush(testUser);
    await profile();
    await login;
  });

  it('surfaces a failed development session without refreshing', async () => {
    history.replaceState(null, '', '/chats');
    session.restoreToken();
    const login = session.initialize();
    http.expectOne('/_api/auth/dev-session').flush('', { status: 404, statusText: 'Not Found' });
    await expect(login).rejects.toMatchObject({ status: 404 });
    http.expectNone('/_api/auth/refresh');
    expect(session.token()).toBeUndefined();
  });

  it('clears both stores on logout so the cookie cannot sign the user back in', async () => {
    session.restoreToken();
    const login = session.initialize();
    http.expectOne('/_api/auth/refresh').flush({ token: 'refreshed-token' });
    await Promise.resolve();
    http.expectOne('/_api/users/me').flush(testUser);
    await profile();
    await login;
    session.logout();
    expect(session.token()).toBeUndefined();
    expect(session.user()).toBeUndefined();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(document.cookie).not.toContain(`${COOKIE_KEY}=`);
    session.restoreToken();
    expect(session.token()).toBeUndefined();
  });
});
