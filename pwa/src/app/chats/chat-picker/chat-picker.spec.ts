import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular';
import { GroupKind } from '../../../generated/models';
import { ChatListStore } from '../chat-list-store';
import { ChatStore } from '../chat-store';
import { testChat } from '../../api/testing';
import { encodeId } from '../../api/snowflake-id';
import { provideRpcTesting, RpcTestPeer } from '../../api/rpc-testing';
import { RpcErrorCode } from '../../api/rpc-error';
import { ChatPicker, ChatPickerScope, type ChooseChat } from './chat-picker';

function query<T>(rows: T[]) {
  const revision = signal(0);
  const release = vi.fn();
  return {
    items: signal(rows),
    loading: signal(false),
    loadingMore: signal(false),
    listError: signal<string | undefined>(undefined),
    hasMore: signal(false),
    loadedThrough: signal(-Infinity),
    loadMore: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    activate: vi.fn(() => {
      revision();
      return release;
    }),
    release,
    revision,
  };
}

describe('Shared chat picker scopes', () => {
  let peer: RpcTestPeer;
  const makeLists = () => {
    const active = query([testChat]);
    const archived = query([{ ...testChat, id: encodeId('98'), name: 'Archived group', archived: true }]);
    const threads = query([]);
    return {
      active,
      archived,
      threads,
      chats: vi.fn((archivedFlag: boolean) => (archivedFlag ? archived : active)),
      threadQueries: vi.fn(() => threads),
    };
  };
  let lists: ReturnType<typeof makeLists>;
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
    lists = makeLists();
    TestBed.configureTestingModule({
      providers: [
        provideIonicAngular({ animated: false }),
        provideRpcTesting(),
        { provide: ChatListStore, useValue: { chats: lists.chats, threads: lists.threadQueries } },
        { provide: ChatStore, useValue: { get: () => testChat } },
      ],
    });
    TestBed.overrideComponent(ChatPicker, { set: { template: '' } });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
  });
  afterEach(() => {
    try {
      peer.verify();
    } finally {
      TestBed.resetTestingModule();
      vi.unstubAllGlobals();
    }
  });
  function setup(scope: ChatPickerScope) {
    const fixture = TestBed.createComponent(ChatPicker);
    const choose = vi.fn<ChooseChat>(() => true);
    fixture.componentRef.setInput('scope', scope);
    fixture.componentRef.setInput('title', 'Choose');
    fixture.componentRef.setInput('choose', choose);
    fixture.detectChanges();
    return { fixture, picker: fixture.componentInstance, choose };
  }
  it('offers private and group chats including archives, without loading threads', async () => {
    lists.active.items.set([{ ...testChat, kind: GroupKind.dm, name: 'Friend' }]);
    const { picker, fixture, choose } = setup(ChatPickerScope.Chats);
    expect(lists.chats.mock.calls).toEqual([[false], [true]]);
    expect(lists.threadQueries).not.toHaveBeenCalled();
    expect(picker['targets']().map((row) => row.kind)).toEqual([GroupKind.dm, GroupKind.group]);
    expect(picker['targets']().some((row) => row.name === 'Archived group')).toBe(true);
    await picker['select'](picker['targets']()[0]);
    expect(choose).toHaveBeenCalledOnce();
    expect(picker.open()).toBe(false);
    fixture.destroy();
    expect(lists.active.release).toHaveBeenCalledOnce();
    expect(lists.archived.release).toHaveBeenCalledOnce();
  });
  it('preserves forwarding scope and does not reactivate queries when their internal signals change', () => {
    const { fixture } = setup(ChatPickerScope.ChatsAndThreads);
    expect(lists.chats.mock.calls).toEqual([[false]]);
    expect(lists.threadQueries).toHaveBeenCalledWith(false);
    lists.active.revision.set(1);
    fixture.detectChanges();
    expect(lists.active.activate).toHaveBeenCalledOnce();
    expect(lists.active.release).not.toHaveBeenCalled();
    expect(lists.archived.activate).not.toHaveBeenCalled();
  });
  it('excludes the source group from both recent and archived destinations', () => {
    const { fixture, picker } = setup(ChatPickerScope.Chats);
    fixture.componentRef.setInput('excludedId', testChat.id);
    fixture.detectChanges();
    expect(picker['targets']().map((row) => row.chatId)).toEqual([encodeId('98')]);
  });
  it('searches all joined groups on the server without requiring a conversation or speaking permission', async () => {
    const { picker, fixture, choose } = setup(ChatPickerScope.JoinedGroups);
    peer
      .expect('groups.list', { q: '', mode: 'submitted', scope: 'joined', limit: 50 })
      .flush({ groups: [{ id: '7', name: 'Old group' }] });
    await fixture.whenStable();
    picker['query'].set('Archived');
    fixture.detectChanges();
    const search = peer.expect('groups.list', { q: 'Archived', mode: 'submitted', scope: 'joined', limit: 50 });
    expect(picker['targets']()[0].name).toBe('Old group');
    search.flush({ groups: [{ id: '8', name: 'Archived group' }] });
    await fixture.whenStable();
    await picker['select'](picker['targets']()[0]);
    expect(choose.mock.calls[0][0]).toMatchObject({ chatId: encodeId('8'), kind: GroupKind.group });
    expect(lists.chats).not.toHaveBeenCalled();
    expect(lists.threadQueries).not.toHaveBeenCalled();
  });
  it('ignores stale group search responses and retries failed pagination at its original cursor', async () => {
    const { fixture, picker } = setup(ChatPickerScope.JoinedGroups);
    const first = peer.expect('groups.list');
    picker['query'].set('new');
    fixture.detectChanges();
    peer.expect('groups.list').flush({ groups: [{ id: '8', name: 'new' }], nextCursor: '8' });
    first.flush({ groups: [{ id: '7', name: 'old' }] });
    await fixture.whenStable();
    expect(picker['targets']().map((row) => row.name)).toEqual(['new']);
    const pending = picker['more']();
    expect(picker['manualPaging']()).toBe(true);
    expect(picker['pending']()).toBe(false);
    peer
      .expect('groups.list', { q: 'new', mode: 'submitted', scope: 'joined', limit: 50, after: '8' })
      .error(RpcErrorCode.Unavailable);
    await pending;
    expect(picker['targets']().map((row) => row.name)).toEqual(['new']);
    const retry = picker['loadGroups'](picker['groupsFailedMore']);
    expect(picker['pending']()).toBe(true);
    peer
      .expect('groups.list', { q: 'new', mode: 'submitted', scope: 'joined', limit: 50, after: '8' })
      .flush({ groups: [{ id: '9', name: 'new two' }] });
    await retry;
    expect(picker['targets']().map((row) => row.name)).toEqual(['new', 'new two']);
  });
  it('blocks old-cursor pagination before and during a replacement search, including after a failed first page', async () => {
    const { fixture, picker } = setup(ChatPickerScope.JoinedGroups);
    peer.expect('groups.list').flush({ groups: [{ id: '100', name: 'Old group' }], nextCursor: '100' });
    await fixture.whenStable();
    picker['query'].set('new');
    expect(picker['moreAvailable']()).toBe(false);
    await picker['more']();
    peer.expectNone('groups.list');
    fixture.detectChanges();
    const first = peer.expect('groups.list', { q: 'new', mode: 'submitted', scope: 'joined', limit: 50 });
    const complete = vi.fn();
    await picker['more']({ target: { complete } } as unknown as Parameters<(typeof picker)['more']>[0]);
    expect(complete).toHaveBeenCalledOnce();
    peer.expectNone('groups.list');
    expect(picker['targets']().map((row) => row.name)).toEqual(['Old group']);
    first.error(RpcErrorCode.Unavailable);
    await fixture.whenStable();
    expect(picker['groupsError']()).toBe(true);
    await picker['more']();
    peer.expectNone('groups.list');
    const retry = picker['loadGroups'](picker['groupsFailedMore']);
    peer
      .expect('groups.list', { q: 'new', mode: 'submitted', scope: 'joined', limit: 50 })
      .flush({ groups: [{ id: '50', name: 'New first page' }], nextCursor: '50' });
    await retry;
    const more = picker['more']();
    peer
      .expect('groups.list', { q: 'new', mode: 'submitted', scope: 'joined', limit: 50, after: '50' })
      .flush({ groups: [{ id: '51', name: 'New second page' }] });
    await more;
    expect(picker['targets']().map((row) => row.name)).toEqual(['New first page', 'New second page']);
  });

  it('allows new-query pagination while an old page is pending and ignores its late response and cleanup', async () => {
    const { fixture, picker } = setup(ChatPickerScope.JoinedGroups);
    peer.expect('groups.list').flush({ groups: [{ id: '100', name: 'Old group' }], nextCursor: '100' });
    await fixture.whenStable();
    const oldMore = picker['more']();
    const oldPage = peer.expect('groups.list');
    picker['query'].set('new');
    fixture.detectChanges();
    peer
      .expect('groups.list', { q: 'new', mode: 'submitted', scope: 'joined', limit: 50 })
      .flush({ groups: [{ id: '50', name: 'New first page' }], nextCursor: '50' });
    await fixture.whenStable();
    const newMore = picker['more']();
    const newPage = peer.expect('groups.list', {
      q: 'new',
      mode: 'submitted',
      scope: 'joined',
      limit: 50,
      after: '50',
    });
    oldPage.flush({ groups: [{ id: '101', name: 'Old second page' }] });
    await oldMore;
    expect(picker['targets']().map((row) => row.name)).toEqual(['New first page']);
    expect(picker['paging']()).toBe(true);
    expect(picker['manualPaging']()).toBe(true);
    const overlapping = picker['more']();
    peer.expectNone('groups.list');
    newPage.flush({ groups: [{ id: '51', name: 'New second page' }] });
    await Promise.all([newMore, overlapping]);
    expect(picker['targets']().map((row) => row.name)).toEqual(['New first page', 'New second page']);
    expect(picker['paging']()).toBe(false);
  });

  it('shows recent private contacts including archives, deduplicates users and emits without sending', async () => {
    const alice = { uid: 1, username: 'Alice', gender: 0, avatarUrl: '/alice.png' };
    const bob = { uid: 2, username: 'Bob', gender: 0 };
    lists.active.items.set([
      testChat,
      { ...testChat, id: encodeId('91'), kind: GroupKind.dm, peer: alice, lastMessageAt: '2026-01-01T00:00:00Z' },
    ]);
    lists.archived.items.set([
      {
        ...testChat,
        id: encodeId('92'),
        name: 'Bob',
        archived: true,
        kind: GroupKind.dm,
        peer: bob,
        lastMessageAt: '2026-01-03T00:00:00Z',
      },
      {
        ...testChat,
        id: encodeId('91'),
        name: 'Alice',
        archived: true,
        kind: GroupKind.dm,
        peer: alice,
        lastMessageAt: '2026-01-01T00:00:00Z',
      },
    ]);
    const { fixture, picker, choose } = setup(ChatPickerScope.Users);
    expect(picker['targets']().map((row) => row.name)).toEqual(['Bob', 'Alice']);
    const chosen = vi.fn();
    picker.userSelected.subscribe(chosen);
    await picker['select'](picker['targets']()[0]);
    expect(chosen).toHaveBeenCalledExactlyOnceWith(bob);
    expect(choose).not.toHaveBeenCalled();
    peer.expectNone('users.search');
    expect(lists.threadQueries).not.toHaveBeenCalled();
    fixture.destroy();
    expect(lists.active.release).toHaveBeenCalledOnce();
    expect(lists.archived.release).toHaveBeenCalledOnce();
  });
  it('keeps contact pagination and errors separate from user search and restores contacts on clearing', async () => {
    const alice = { uid: 1, username: 'Alice', gender: 0 };
    lists.active.items.set([{ ...testChat, kind: GroupKind.dm, peer: alice }]);
    lists.active.hasMore.set(true);
    lists.active.loadedThrough.set(0);
    lists.archived.listError.set('offline');
    const { fixture, picker } = setup(ChatPickerScope.Users);
    expect(picker['failed']()).toBe(true);
    expect(picker['moreAvailable']()).toBe(true);
    await picker['more']();
    expect(lists.active.loadMore).toHaveBeenCalledOnce();
    picker['query'].set('someone');
    fixture.detectChanges();
    const search = peer.expect('users.search');
    expect(picker['failed']()).toBe(false);
    expect(picker['moreAvailable']()).toBe(false);
    expect(picker['visibleSources']()).toEqual([]);
    picker['query'].set('');
    fixture.detectChanges();
    expect(picker['targets']().map((row) => row.name)).toEqual(['Alice']);
    expect(picker['failed']()).toBe(true);
    search.flush({ members: [{ uid: 2, username: 'Other', gender: 0 }] });
    await fixture.whenStable();
    expect(picker['targets']().map((row) => row.name)).toEqual(['Alice']);
    expect(lists.active.activate).toHaveBeenCalledOnce();
    expect(lists.archived.activate).toHaveBeenCalledOnce();
  });
  it('searches users without requiring a private chat and emits the selected user', async () => {
    const { fixture, picker, choose } = setup(ChatPickerScope.Users);
    const chosen = vi.fn();
    picker.userSelected.subscribe(chosen);
    peer.expectNone('users.search');
    picker['query'].set('alice');
    fixture.detectChanges();
    const user = { uid: 123, username: 'Alice', gender: 0, avatarUrl: '/alice.png' };
    peer.expect('users.search', { q: 'alice', limit: 40 }).flush({ members: [user] });
    await fixture.whenStable();
    expect(picker['targets']()[0].avatar.avatar).toBe('/alice.png');
    await picker['select'](picker['targets']()[0]);
    expect(chosen).toHaveBeenCalledExactlyOnceWith(user);
    expect(choose).not.toHaveBeenCalled();
    expect(picker.open()).toBe(false);
    expect(lists.chats.mock.calls).toEqual([[false], [true]]);
    expect(lists.threadQueries).not.toHaveBeenCalled();
    peer.expectNone('groups.list');
  });
  it('retries user search, preserves known results, and ignores stale and cancelled responses', async () => {
    const { fixture, picker } = setup(ChatPickerScope.Users);
    picker['query'].set('old');
    fixture.detectChanges();
    const old = peer.expect('users.search');
    picker['query'].set('new');
    fixture.detectChanges();
    peer.expect('users.search').error(RpcErrorCode.Unavailable);
    await fixture.whenStable();
    expect(picker['usersError']()).toBe(true);
    const retry = picker['loadUsers']();
    peer.expect('users.search', { q: 'new', limit: 40 }).flush({ members: [{ uid: 2, username: 'New', gender: 0 }] });
    await retry;
    old.flush({ members: [{ uid: 1, username: 'Old', gender: 0 }] });
    await fixture.whenStable();
    expect(picker['targets']().map((row) => row.name)).toEqual(['New']);
    picker['query'].set('later');
    fixture.detectChanges();
    const later = peer.expect('users.search');
    expect(picker['targets']().map((row) => row.name)).toEqual(['New']);
    picker['query'].set('');
    fixture.detectChanges();
    expect(picker['targets']()).toEqual([]);
    later.flush({ members: [{ uid: 3, username: 'Later', gender: 0 }] });
    await fixture.whenStable();
    expect(picker['targets']()).toEqual([]);
    picker['query'].set('closed');
    fixture.detectChanges();
    const closed = peer.expect('users.search');
    picker['close']();
    closed.flush({ members: [{ uid: 4, username: 'Closed', gender: 0 }] });
    await fixture.whenStable();
    expect(picker['targets']()).toEqual([]);
  });
});
