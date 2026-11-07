import { TestBed } from '@angular/core/testing';
import { RpcErrorCode } from '../../api/rpc-error';
import { provideRpcTesting, RpcTestPeer } from '../../api/rpc-testing';
import { wireChat } from '../../api/testing';
import { InviteCard } from './invite-card';

describe('InviteCard availability', () => {
  let peer: RpcTestPeer;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRpcTesting()] });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
  });
  afterEach(() => peer.verify());

  function card() {
    const fixture = TestBed.createComponent(InviteCard);
    fixture.componentRef.setInput('code', 'old-code');
    fixture.detectChanges();
    return fixture;
  }

  it.each([
    [RpcErrorCode.BadRequest, '邀请不存在'],
    [RpcErrorCode.NotFound, '邀请不存在'],
    [RpcErrorCode.Gone, '邀请已过期'],
  ])('shows the server-confirmed availability instead of a loading failure (%s)', (code, message) => {
    const fixture = card();
    peer.expect('invites.getByCode', { inviteCode: 'old-code' }).error(code);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(message);
    expect(fixture.nativeElement.textContent).not.toContain('邀请加载失败');
    expect(fixture.nativeElement.querySelector('ion-spinner')).toBeNull();
  });

  it('keeps service failures distinct from an invalid invite', () => {
    const fixture = card();
    peer.expect('invites.getByCode').error(RpcErrorCode.Unavailable);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('邀请加载失败');
    expect(fixture.nativeElement.textContent).not.toContain('邀请已过期');
  });

  it.each([
    ['generic', false, true, undefined],
    ['generic', true, false, undefined],
    ['targeted', false, true, undefined],
    ['targeted', false, false, undefined],
    ['targeted', true, false, '2026-01-01T00:00:00Z'],
    ['targeted', false, false, '2026-01-01T00:00:00Z'],
    ['membership', false, true, undefined],
    ['membership', false, false, undefined],
  ])(
    'renders the same active invitation regardless of join eligibility: %s / %s / %s / %s',
    (inviteType, alreadyMember, canJoin, usedAt) => {
      const fixture = card();
      peer.expect('invites.getByCode').flush({
        alreadyMember,
        canJoin,
        chat: { ...wireChat, description: '一起聊聊茶' },
        invite: { id: '100', chatId: wireChat.id, code: 'old-code', inviteType, usedAt, createdAt: '' },
      });
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('strong').textContent.trim()).toBe(wireChat.name);
      expect(fixture.nativeElement.querySelector('small').textContent.trim()).toBe('一起聊聊茶');
    },
  );

  it.each([false, true])(
    'treats a loaded revoked invitation as expired even for current members: %s',
    (alreadyMember) => {
      const fixture = card();
      peer.expect('invites.getByCode').flush({
        alreadyMember,
        canJoin: !alreadyMember,
        chat: wireChat,
        invite: {
          id: '100',
          chatId: wireChat.id,
          code: 'old-code',
          inviteType: 'generic',
          revokedAt: '2026-01-01T00:00:00Z',
          createdAt: '',
        },
      });
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('strong').textContent.trim()).toBe('邀请已过期');
      expect(fixture.nativeElement.querySelector('small')).toBeNull();
    },
  );

  it('ignores a late unavailable response for a different invite', () => {
    const fixture = card();
    const old = peer.expect('invites.getByCode');
    fixture.componentRef.setInput('code', 'new-code');
    fixture.detectChanges();
    peer.expect('invites.getByCode', { inviteCode: 'new-code' }).flush({
      alreadyMember: false,
      canJoin: true,
      chat: wireChat,
      invite: { id: '100', chatId: wireChat.id, code: 'new-code', inviteType: 'generic', createdAt: '' },
    });
    old.error(RpcErrorCode.Gone);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(wireChat.name);
    expect(fixture.nativeElement.textContent).not.toContain('邀请已过期');
    expect(fixture.componentInstance['issue']()).toBeUndefined();
  });
});
