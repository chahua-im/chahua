import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { createEnvironmentInjector, EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { GroupKind, GroupRole, type ServerWsMessage } from '../../generated/models';
import { Connection } from '../api/connection';
import { jsonInterceptor } from '../api/json.interceptor';
import { decodeId } from '../api/snowflake-id';
import { mockRealtime, testChat, wireChat } from '../api/testing';
import { ChatStore } from './chat-store';

describe('ChatStore', () => {
  let store: ChatStore;
  let http: HttpTestingController;
  let scope: EnvironmentInjector;
  let resync: Subject<void>;
  const url = `/_api/group/${decodeId(testChat.id)}`;
  const response = {
    id: wireChat.id,
    kind: 'group',
    name: '小群',
    description: '群介绍',
    myRole: 'admin',
    visibility: 'private',
    createdAt: '2026-09-05T12:00:00Z',
  };

  beforeEach(() => {
    resync = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        {
          provide: Connection,
          useValue: mockRealtime({ resync$: resync, events$: new Subject<ServerWsMessage>() }),
        },
      ],
    });
    scope = createEnvironmentInjector([ChatStore], TestBed.inject(EnvironmentInjector));
    store = scope.get(ChatStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    scope.destroy();
    vi.useRealTimers();
    http.verify();
  });

  it('retains projected chat information independently of later list results', async () => {
    store.remember([testChat]);
    store.remember([]);
    await store.ensure(testChat.id);
    expect(store.get(testChat.id)).toEqual({
      kind: testChat.kind,
      name: testChat.name,
      avatar: testChat.avatar,
      peer: testChat.peer,
    });
    http.expectNone(url);
  });

  it('deduplicates detail requests and retains the fields used by the info panel', async () => {
    const first = store.ensure(testChat.id);
    expect(store.ensure(testChat.id)).toBe(first);
    http.expectOne(url).flush(response);
    await first;
    expect(store.get(testChat.id)).toEqual({
      kind: GroupKind.group,
      name: '小群',
      avatar: undefined,
      peer: undefined,
      myRole: GroupRole.admin,
      description: response.description,
      visibility: response.visibility,
      mutedUntil: undefined,
    });
    await store.ensure(testChat.id);
    http.expectNone(url);
  });

  it('keeps displayed metadata during invalidation and fetches it only when requested', async () => {
    store.remember([testChat]);
    resync.next();
    expect(store.get(testChat.id)?.name).toBe(testChat.name);
    http.expectNone(url);
    const refresh = store.ensure(testChat.id);
    http.expectOne(url).flush({ ...response, name: '新名字' });
    await refresh;
    expect(store.get(testChat.id)?.name).toBe('新名字');
  });

  it('does not replace a newer ingested list value with an older pending lookup', async () => {
    const request = store.ensure(testChat.id);
    const old = http.expectOne(url);
    store.remember([{ ...testChat, name: '列表里的新名字' }]);
    old.flush(response);
    await request;
    expect(store.get(testChat.id)?.name).toBe('列表里的新名字');
  });

  it('revalidates after a reconnect during the first lookup instead of committing that old response', async () => {
    const request = store.ensure(testChat.id);
    const old = http.expectOne(url);
    resync.next();
    expect(store.ensure(testChat.id)).toBe(request);
    old.flush(response);
    await Promise.resolve();
    http.expectOne(url).flush({ ...response, name: '重连后的名字' });
    await request;
    expect(store.get(testChat.id)?.name).toBe('重连后的名字');
  });

  it('loads permissions despite a fresh list entry and preserves them when the list updates', async () => {
    store.remember([testChat]);
    await store.ensure(testChat.id);
    http.expectNone(url);
    expect(store.get(testChat.id)?.myRole).toBeUndefined();

    const details = store.ensureDetails(testChat.id);
    expect(store.ensureDetails(testChat.id)).toBe(details);
    http.expectOne(url).flush(response);
    await details;
    expect(store.get(testChat.id)?.name).toBe(response.name);
    expect(store.get(testChat.id)?.myRole).toBe(GroupRole.admin);
    store.remember([{ ...testChat, name: '新的列表名称' }]);
    expect(store.get(testChat.id)?.name).toBe('新的列表名称');
    expect(store.get(testChat.id)?.description).toBe(response.description);
    expect(store.get(testChat.id)?.visibility).toBe(response.visibility);
    expect(store.get(testChat.id)?.myRole).toBe(GroupRole.admin);
    await store.ensureDetails(testChat.id);
    http.expectNone(url);
  });

  it('shares a details lookup with display loading and refreshes permissions after invalidation', async () => {
    const display = store.ensure(testChat.id);
    expect(store.ensureDetails(testChat.id)).toBe(display);
    http.expectOne(url).flush(response);
    await display;
    resync.next();
    store.remember([testChat]);
    const details = store.ensureDetails(testChat.id);
    http.expectOne(url).flush({ ...response, myRole: GroupRole.member });
    await details;
    expect(store.get(testChat.id)?.myRole).toBe(GroupRole.member);
  });

  it('allows retry after failure and cancels the retry when the service is destroyed', async () => {
    const first = store.ensure(testChat.id);
    const failed = expect(first).rejects.toBeDefined();
    http.expectOne(url).flush('', { status: 503, statusText: 'Unavailable' });
    await failed;
    const retry = store.ensure(testChat.id);
    const cancelled = expect(retry).rejects.toBeDefined();
    const pending = http.expectOne(url);
    scope.destroy();
    expect(pending.cancelled).toBe(true);
    await cancelled;
    scope = createEnvironmentInjector([ChatStore], TestBed.inject(EnvironmentInjector));
    expect(scope.get(ChatStore).get(testChat.id)).toBeUndefined();
  });
});

describe('mute expiry', () => {
  it('expires an active mute without discarding unread data or fetching message history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T10:00:00Z'));
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: Connection, useValue: mockRealtime() }],
    });
    const store = TestBed.inject(ChatStore);
    const http = TestBed.inject(HttpTestingController);
    store.acceptChats([{ ...testChat, mutedUntil: '2026-09-08T10:00:02Z' }], store.snapshot());
    TestBed.tick();
    expect(store.isMuted(testChat.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(2001);
    TestBed.tick();
    expect(store.isMuted(testChat.id)).toBe(false);
    expect(store.chat(testChat.id).unreadCount).toBe(testChat.unreadCount);
    http.expectNone(() => true);
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });
});
