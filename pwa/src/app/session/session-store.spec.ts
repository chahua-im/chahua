import { jsonInterceptor } from '../api/json.interceptor';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { authInterceptor } from '../api/auth.interceptor';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { testUser } from '../api/testing';
import { SessionStore } from './session-store';

describe('SessionStore', () => {
  let session: SessionStore;
  let http: HttpTestingController;
  beforeEach(() => {
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
    http.verify();
    vi.unstubAllGlobals();
    history.replaceState(null, '', '/');
  });

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
    await login;
    expect(session.user()).toEqual(testUser);
    expect(window.localStorage.getItem('chahua.auth.token')).toBe('test-refreshed-token');
    TestBed.inject(HttpClient).get('/assets/example.json').subscribe();
    const asset = http.expectOne('/assets/example.json');
    expect(asset.request.headers.has('Authorization')).toBe(false);
    asset.flush({});
  });

  it.each([
    { urlToken: undefined, storedToken: undefined, expected: 'development-token' },
    { urlToken: undefined, storedToken: 'stored-token', expected: 'stored-token' },
    { urlToken: 'url-token', storedToken: 'stored-token', expected: 'url-token' },
  ])('uses URL, storage, then the development fallback ($expected)', async ({ urlToken, storedToken, expected }) => {
    vi.stubGlobal('CHAHUA_DEV_TOKEN', 'development-token');
    history.replaceState(null, '', urlToken ? `/?token=${urlToken}` : '/chats');
    if (storedToken) localStorage.setItem('chahua.auth.token', storedToken);
    const startup = session.initialize();
    const refresh = http.expectOne('/_api/auth/refresh');
    expect(refresh.request.headers.get('Authorization')).toBe(`Bearer ${expected}`);
    refresh.flush({ token: 'refreshed-token' });
    await Promise.resolve();
    http.expectOne('/_api/users/me').flush(testUser);
    await startup;
    expect(session.user()).toEqual(testUser);
    expect(localStorage.getItem('chahua.auth.token')).toBe('refreshed-token');
  });

  it('retains a token for network retry and clears an expired token', async () => {
    let login = session.initialize();
    http.expectOne('/_api/auth/refresh').flush('', { status: 503, statusText: 'Unavailable' });
    await expect(login).rejects.toMatchObject({ status: 503 });
    expect(session.token()).toBe('test-link-token');
    login = session.initialize();
    http.expectOne('/_api/auth/refresh').flush('', { status: 401, statusText: 'Unauthorized' });
    await expect(login).rejects.toMatchObject({ status: 401 });
    expect(session.token()).toBeUndefined();
    expect(session.user()).toBeUndefined();
    expect(window.localStorage.getItem('chahua.auth.token')).toBeNull();
  });

  it('does not start authenticated requests without a URL or stored token', async () => {
    history.replaceState(null, '', '/chats');
    await session.initialize();
    http.expectNone(() => true);
    expect(session.user()).toBeUndefined();
  });

  it('starts from the stored token when the URL has none', async () => {
    history.replaceState(null, '', '/chats');
    localStorage.setItem('chahua.auth.token', 'stored-token');
    const startup = session.initialize();
    const refresh = http.expectOne('/_api/auth/refresh');
    expect(refresh.request.headers.get('Authorization')).toBe('Bearer stored-token');
    refresh.flush({ token: 'refreshed-token' });
    await Promise.resolve();
    http.expectOne('/_api/users/me').flush(testUser);
    await startup;
    expect(session.user()).toEqual(testUser);
  });
});
