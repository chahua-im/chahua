import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular';
import { InviteType, type InviteResponse } from '../../../generated/models';
import { RpcErrorCode } from '../../api/rpc-error';
import { provideRpcTesting, RpcTestPeer } from '../../api/rpc-testing';
import { decodeId, encodeId } from '../../api/snowflake-id';
import { ChatStore } from '../chat-store';
import { ChatInvites } from './chat-invites';

describe('Invite settings feedback', () => {
  const invite: InviteResponse = {
    id: encodeId('3'),
    chatId: encodeId('4'),
    code: 'test-code',
    inviteType: InviteType.generic,
    createdAt: '2026-01-01T00:00:00Z',
    creatorUid: 1,
  };
  let peer: RpcTestPeer;
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideIonicAngular({ animated: false }),
        provideRpcTesting(),
        { provide: ChatStore, useValue: { ensureDetails: async () => {}, canSpeak: () => true } },
      ],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
  });
  afterEach(() => {
    try {
      peer.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });
  async function page(groupError = false) {
    const fixture = TestBed.createComponent(ChatInvites);
    fixture.componentRef.setInput('chatId', invite.chatId);
    fixture.detectChanges();
    peer.expect('invites.list', { groupId: decodeId(invite.chatId), limit: 100 }).flush({ invites: [] });
    const groups = peer.expect('groups.list', {
      q: '',
      mode: 'submitted',
      scope: 'joined',
      limit: 50,
    });
    if (groupError) groups.error(RpcErrorCode.Unavailable);
    else groups.flush({ groups: [] });
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }
  it('retries group loading independently from the invite list', async () => {
    const fixture = await page(true);
    const component = fixture.componentInstance;
    expect(component['groupsError']()).toBe(true);
    expect(component['error']()).toBe(false);
    const retry: HTMLElement = Array.from(
      fixture.nativeElement.querySelectorAll('ion-button') as NodeListOf<HTMLElement>,
    ).find((button) => button.textContent?.trim() === '重试')!;
    retry.click();
    peer.expect('groups.list', { q: '', mode: 'submitted', scope: 'joined', limit: 50 }).flush({ groups: [] });
    await fixture.whenStable();
    expect(component['groupsError']()).toBe(false);
  });
  it('rejects past or malformed expiration and retains valid creation input on failure', async () => {
    const component = (await page()).componentInstance;
    for (const expiry of ['invalid', '2000-01-01T12:00']) {
      component['values'].set({ expiry });
      await component['create']();
    }
    peer.expectNone('invites.create');
    const expiry = '2099-01-01T12:00';
    component['values'].set({ expiry });
    const failed = component['create']();
    peer.expect('invites.create').error(RpcErrorCode.Unavailable);
    await failed;
    expect(component['values']().expiry).toBe(expiry);
    expect(component['error']()).toBe(true);
    const created = component['create']();
    peer.expect('invites.create').flush({ ...invite, id: decodeId(invite.id), chatId: decodeId(invite.chatId) });
    await created;
    expect(component['invites']()).toEqual([invite]);
  });
  it('shows confirmation only after a successful share', async () => {
    const component = (await page()).componentInstance;
    component['destination'].set(encodeId('10'));
    const failed = component['share'](invite);
    const failedRequest = await peer.expectAsync(
      'invites.send',
      (params) =>
        params['sourceChatId'] === decodeId(invite.chatId) &&
        params['inviteId'] === decodeId(invite.id) &&
        params['destinationChatId'] === '10',
    );
    expect(failedRequest.params).toEqual({
      sourceChatId: decodeId(invite.chatId),
      inviteId: decodeId(invite.id),
      destinationChatId: '10',
      clientGeneratedId: expect.any(String),
    });
    failedRequest.error(RpcErrorCode.Unavailable);
    await failed;
    expect(component['notice']()).toBeUndefined();
    const shared = component['share'](invite);
    const sharedRequest = await peer.expectAsync(
      'invites.send',
      (params) =>
        params['sourceChatId'] === decodeId(invite.chatId) &&
        params['inviteId'] === decodeId(invite.id) &&
        params['destinationChatId'] === '10',
    );
    expect(sharedRequest.params).toEqual({
      sourceChatId: decodeId(invite.chatId),
      inviteId: decodeId(invite.id),
      destinationChatId: '10',
      clientGeneratedId: expect.any(String),
    });
    sharedRequest.flush({
      id: decodeId(invite.id),
      chatId: decodeId(invite.chatId),
      code: invite.code,
      inviteType: invite.inviteType,
      createdAt: invite.createdAt,
      creatorUid: invite.creatorUid,
    });
    await shared;
    expect(component['notice']()).toBe('邀请已发送');
  });
});
