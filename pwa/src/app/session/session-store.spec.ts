import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import type { UserGroupTagInfo } from '../../generated/models';
import { authInterceptor } from '../api/auth.interceptor';
import { jsonInterceptor } from '../api/json.interceptor';
import { testUser } from '../api/testing';
import { SessionStore } from './session-store';

const TOKEN_KEY = 'chahua.auth.token';

describe('SessionStore', () => {
  let session: SessionStore;
  let http: HttpTestingController;
  beforeEach(() => {
    document.cookie = `${TOKEN_KEY}=; Path=/; Max-Age=0`;
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
    document.cookie = `${TOKEN_KEY}=; Path=/; Max-Age=0`;
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

  it('removes the URL token, refreshes it, and uses the new token for the current user', async () => {
    const login = session.initialize();
    expect(location.search).toBe('');
    const refresh = http.expectOne('/_api/auth/refresh');
    expect(refresh.request.headers.get('Authorization')).toBe('Bearer test-link-token');
    refresh.flush({ token: 'test-refreshed-token' });
    await Promise.resolve();
    const me = http.expectOne('/_api/users/me');
    expect(me.request.headers.get('Authorization')).toBe('Bearer test-refreshed-token');
    me.flush(testUser);
    const userGroup = { groupId: 3, name: '三水', chatGroupColor: '#4087d2', chatGroupColorDark: '#72a7de' };
    await profile(userGroup);
    await login;
    expect(session.user()).toEqual({ ...testUser, userGroup });
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe('test-refreshed-token');
    expect(document.cookie).toContain(`${TOKEN_KEY}=test-refreshed-token`);
    TestBed.inject(HttpClient).get('/assets/example.json').subscribe();
    const asset = http.expectOne('/assets/example.json');
    expect(asset.request.headers.has('Authorization')).toBe(false);
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
      if (cookieToken) document.cookie = `${TOKEN_KEY}=${cookieToken}; Path=/`;
      const startup = session.initialize();
      const refresh = http.expectOne('/_api/auth/refresh');
      expect(refresh.request.headers.get('Authorization')).toBe(`Bearer ${expected}`);
      expect(localStorage.getItem(TOKEN_KEY)).toBe(expected);
      expect(document.cookie).toContain(`${TOKEN_KEY}=${expected}`);
      refresh.flush({ token: 'refreshed-token' });
      await Promise.resolve();
      http.expectOne('/_api/users/me').flush(testUser);
      await profile();
      await startup;
      expect(session.user()).toEqual(testUser);
      expect(localStorage.getItem(TOKEN_KEY)).toBe('refreshed-token');
      expect(document.cookie).toContain(`${TOKEN_KEY}=refreshed-token`);
    },
  );

  it('retains a token for network retry and clears an expired token', async () => {
    let login = session.initialize();
    http.expectOne('/_api/auth/refresh').flush('', { status: 503, statusText: 'Unavailable' });
    await expect(login).rejects.toMatchObject({ status: 503 });
    expect(session.token()).toBe('test-link-token');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('test-link-token');
    expect(document.cookie).toContain(`${TOKEN_KEY}=test-link-token`);
    login = session.initialize();
    http.expectOne('/_api/auth/refresh').flush('', { status: 401, statusText: 'Unauthorized' });
    await expect(login).rejects.toMatchObject({ status: 401 });
    expect(session.token()).toBeUndefined();
    expect(session.user()).toBeUndefined();
    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(document.cookie).not.toContain(`${TOKEN_KEY}=`);
    await session.initialize();
    http.expectNone(() => true);
  });

  it('keeps login usable when the optional group lookup fails', async () => {
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

  it('learns current own identity from HTTP replies while leaving saved snapshots and other users alone', async () => {
    const group = { groupId: 3, name: '三水' };
    session.user.set({ ...testUser, userGroup: group });
    const client = TestBed.inject(HttpClient);
    client.get('/_api/chats/example/messages').subscribe();
    http.expectOne('/_api/chats/example/messages').flush({
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
      http
        .expectOne(url)
        .flush({ messages: [{ sender: { uid: testUser.uid, name: '旧名字', gender: 1, userGroup: group } }] });
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

  it('does not start authenticated requests without a URL or stored token', async () => {
    history.replaceState(null, '', '/chats');
    await session.initialize();
    http.expectNone(() => true);
    expect(session.user()).toBeUndefined();
  });

  it('clears both stores on logout so the cookie cannot sign the user back in', async () => {
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
    expect(document.cookie).not.toContain(`${TOKEN_KEY}=`);
    await session.initialize();
    http.expectNone(() => true);
  });
});
