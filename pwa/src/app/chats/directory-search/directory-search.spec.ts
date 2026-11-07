import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RpcErrorCode } from '../../api/rpc-error';
import { provideRpcTesting, RpcTestPeer } from '../../api/rpc-testing';
import { testUser, wireChat } from '../../api/testing';
import { SessionStore } from '../../session/session-store';
import { DirectorySearch } from './directory-search';

describe('DirectorySearch combined results', () => {
  let peer: RpcTestPeer;
  const code = 'abcdefghij';
  const group = { ...wireChat, name: code };
  const person = { uid: 12345678, username: code, gender: 0 };
  const preview = {
    alreadyMember: false,
    canJoin: false,
    chat: wireChat,
    invite: { id: '100', chatId: wireChat.id, code, inviteType: 'targeted', createdAt: '' },
  };
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRpcTesting(),
        provideRouter([]),
        { provide: SessionStore, useValue: { user: signal(testUser) } },
      ],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
  });
  afterEach(() => {
    peer.verify();
    vi.restoreAllMocks();
  });
  function search(query: string, usersOnly = false) {
    const fixture = TestBed.createComponent(DirectorySearch);
    fixture.componentRef.setInput('query', query);
    fixture.componentRef.setInput('usersOnly', usersOnly);
    fixture.detectChanges();
    return fixture;
  }
  async function settle(fixture: ReturnType<typeof search>) {
    await vi.waitFor(() => expect(fixture.componentInstance['loading']()).toBe(false));
    fixture.detectChanges();
  }

  it('shows all three categories without fetching the invitation card twice', async () => {
    const fixture = search(code);
    peer.expect('groups.list', (p) => p['q'] === code && p['scope'] === 'joined').flush({ groups: [group] });
    peer.expect('users.search', { q: code, limit: 40 }).flush({ members: [person] });
    peer.expect('invites.getByCode', { inviteCode: code }).flush(preview);
    await settle(fixture);
    expect(fixture.nativeElement.querySelectorAll('ion-list-header')).toHaveLength(3);
    expect(fixture.nativeElement.querySelector('app-invite-card')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain(String(person.uid));
    expect(fixture.nativeElement.textContent).not.toContain('未受邀');
    peer.expectNone('invites.getByCode');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture.nativeElement.querySelector('.invite-result').click();
    expect(navigate).toHaveBeenCalledWith(['/chats/join', code]);
    peer.expectNone('invites.redeem');
  });

  it('keeps numeric username, UID and group matches when no invitation exists', async () => {
    const q = '12345678';
    const fixture = search(q);
    peer.expect('groups.list').flush({ groups: [group] });
    peer.expect('users.search', { q, limit: 40 }).flush({ members: [person, { uid: 42, username: q, gender: 0 }] });
    peer.expect('invites.getByCode', { inviteCode: q }).error(RpcErrorCode.NotFound);
    await settle(fixture);
    expect(fixture.componentInstance['groups']()).toHaveLength(1);
    expect(fixture.componentInstance['people']()).toHaveLength(2);
    expect(fixture.componentInstance['error']()).toBe(false);
    expect(fixture.nativeElement.querySelector('app-invite-card')).toBeNull();
  });

  it.each(['groups', 'people', 'invitation'] as const)(
    'shows %s as soon as it arrives while the other searches are pending',
    async (source) => {
      const fixture = search(code);
      const requests = {
        groups: peer.expect('groups.list'),
        people: peer.expect('users.search'),
        invitation: peer.expect('invites.getByCode'),
      };
      const responses = {
        groups: { groups: [group], nextCursor: '100' },
        people: { members: [person] },
        invitation: preview,
      };
      requests[source].flush(responses[source]);
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(fixture.nativeElement.querySelectorAll('ion-list-header')).toHaveLength(1);
      });
      const result = fixture.nativeElement.querySelector('ion-list-header');
      expect(fixture.componentInstance['loading']()).toBe(true);
      expect(fixture.componentInstance['loadingMore']()).toBe(false);
      expect(fixture.nativeElement.querySelector('.page-loading')).not.toBeNull();
      expect(fixture.nativeElement.textContent).not.toContain('没有找到结果');
      for (const other of ['groups', 'people', 'invitation'] as const) {
        if (other !== source) requests[other].flush(responses[other]);
      }
      await settle(fixture);
      expect(fixture.nativeElement.contains(result)).toBe(true);
      expect(fixture.nativeElement.querySelectorAll('ion-list-header')).toHaveLength(3);
      peer.expectNone('invites.getByCode');
    },
  );

  it.each([
    [RpcErrorCode.NotFound, '邀请不存在'],
    [RpcErrorCode.Gone, '邀请已过期'],
  ])('recognizes invitation links and their unavailable results (%s)', async (error, text) => {
    const fixture = search(`https://example.com/chats/join/${code}`);
    peer.expect('groups.list').flush({ groups: [] });
    peer.expect('users.search').flush({ members: [] });
    peer.expect('invites.getByCode', { inviteCode: code }).error(error);
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('app-invite-card').textContent).toContain(text);
    expect(fixture.nativeElement.textContent).not.toContain('没有找到结果');
    expect(fixture.nativeElement.querySelector('app-load-error')).toBeNull();
    peer.expectNone('invites.getByCode');
  });

  it('preserves successful categories and their DOM while retrying a partial failure', async () => {
    const fixture = search(code);
    peer.expect('groups.list').error(RpcErrorCode.Unavailable);
    peer.expect('users.search').flush({ members: [person] });
    peer.expect('invites.getByCode').flush(preview);
    await settle(fixture);
    const card = fixture.nativeElement.querySelector('app-invite-card');
    expect(fixture.nativeElement.querySelector('app-load-error')).not.toBeNull();
    const retry = fixture.componentInstance['search']();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-invite-card')).toBe(card);
    expect(fixture.componentInstance['people']()).toHaveLength(1);
    peer.expect('groups.list').flush({ groups: [group] });
    peer.expect('users.search').flush({ members: [person] });
    peer.expect('invites.getByCode').flush(preview);
    await retry;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-invite-card')).toBe(card);
    expect(fixture.nativeElement.querySelector('app-load-error')).toBeNull();
  });

  it('paginates groups without repeating user or invitation requests', async () => {
    const fixture = search(code);
    peer.expect('groups.list').flush({ groups: [group], nextCursor: '100' });
    peer.expect('users.search').flush({ members: [person] });
    peer.expect('invites.getByCode').flush(preview);
    await settle(fixture);
    const more = fixture.componentInstance['search'](true);
    peer.expect('groups.list', (p) => p['after'] === '100').flush({ groups: [{ ...group, id: '101' }] });
    await more;
    fixture.detectChanges();
    expect(fixture.componentInstance['groups']()).toHaveLength(2);
    expect(fixture.componentInstance['people']()).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('app-invite-card')).not.toBeNull();
    peer.expectNone('users.search');
    peer.expectNone('invites.getByCode');
  });

  it.each(['people', 'invitation'] as const)(
    'preserves a failed %s search and its retry entry through group pagination',
    async (failed) => {
      const fixture = search(code);
      peer.expect('groups.list').flush({ groups: [group], nextCursor: '100' });
      const users = peer.expect('users.search');
      const invite = peer.expect('invites.getByCode');
      if (failed === 'people') {
        users.error(RpcErrorCode.Unavailable);
        invite.flush(preview);
      } else {
        users.flush({ members: [person] });
        invite.error(RpcErrorCode.Unavailable);
      }
      await settle(fixture);
      const error = fixture.nativeElement.querySelector('app-load-error');
      expect(error).not.toBeNull();
      const more = fixture.componentInstance['search'](true);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('app-load-error')).toBe(error);
      peer.expect('groups.list', (p) => p['after'] === '100').flush({ groups: [{ ...group, id: '101' }] });
      await more;
      fixture.detectChanges();
      expect(fixture.componentInstance['error']()).toBe(true);
      expect(fixture.nativeElement.querySelector('app-load-error')).toBe(error);
      expect(fixture.componentInstance['groups']()).toHaveLength(2);
      peer.expectNone('users.search');
      peer.expectNone('invites.getByCode');
      const retry = fixture.componentInstance['search']();
      peer.expect('groups.list').flush({ groups: [group] });
      peer.expect('users.search').flush({ members: [person] });
      peer.expect('invites.getByCode').flush(preview);
      await retry;
      fixture.detectChanges();
      expect(fixture.componentInstance['error']()).toBe(false);
      expect(fixture.nativeElement.querySelector('app-load-error')).toBeNull();
    },
  );

  it('clears a group-only failure after the failed page succeeds', async () => {
    const fixture = search(code);
    peer.expect('groups.list').flush({ groups: [group], nextCursor: '100' });
    peer.expect('users.search').flush({ members: [person] });
    peer.expect('invites.getByCode').flush(preview);
    await settle(fixture);
    const failedPage = fixture.componentInstance['search'](true);
    peer.expect('groups.list', (p) => p['after'] === '100').error(RpcErrorCode.Unavailable);
    await failedPage;
    expect(fixture.componentInstance['error']()).toBe(true);
    const retry = fixture.componentInstance['search'](true);
    peer.expect('groups.list', (p) => p['after'] === '100').flush({ groups: [{ ...group, id: '101' }] });
    await retry;
    expect(fixture.componentInstance['error']()).toBe(false);
    expect(fixture.componentInstance['groups']()).toHaveLength(2);
    peer.expectNone('users.search');
    peer.expectNone('invites.getByCode');
  });

  it.each(['query', 'account'])('discards late results after the %s changes', async (change) => {
    const fixture = search(code);
    const groups = peer.expect('groups.list');
    const users = peer.expect('users.search');
    const invite = peer.expect('invites.getByCode');
    if (change === 'query') fixture.componentRef.setInput('query', '');
    else TestBed.inject(SessionStore).user.set(undefined);
    fixture.detectChanges();
    groups.flush({ groups: [group] });
    users.flush({ members: [person] });
    invite.flush(preview);
    await settle(fixture);
    expect(fixture.componentInstance['groups']()).toEqual([]);
    expect(fixture.componentInstance['people']()).toEqual([]);
    expect(fixture.componentInstance['invitation']()).toBeUndefined();
  });

  it('keeps user-only search scoped to users', async () => {
    const fixture = search(code, true);
    peer.expect('users.search').flush({ members: [person] });
    await settle(fixture);
    expect(fixture.componentInstance['people']()).toHaveLength(1);
    peer.expectNone('groups.list');
    peer.expectNone('invites.getByCode');
  });
});
