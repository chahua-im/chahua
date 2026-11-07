import { By } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import { AlertController, provideIonicAngular } from '@ionic/angular';
import { GroupKind, InviteType, type InviteResponse } from '../../../generated/models';
import { RpcErrorCode } from '../../api/rpc-error';
import { provideRpcTesting, RpcTestPeer } from '../../api/rpc-testing';
import { decodeId, encodeId } from '../../api/snowflake-id';
import { ChatListStore } from '../chat-list-store';
import { ChatStore } from '../chat-store';
import { ChatInvites } from './chat-invites';
import { ChatPicker, ChatPickerScope } from '../chat-picker/chat-picker';

describe('Invite management', () => {
  const invite: InviteResponse = {
    id: encodeId('3'),
    chatId: encodeId('4'),
    code: 'test-code',
    inviteType: InviteType.generic,
    createdAt: '2026-01-01T00:00:00Z',
    creatorUid: 1,
  };
  const wire = { ...invite, id: '3', chatId: '4' };
  let peer: RpcTestPeer;
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
    TestBed.configureTestingModule({
      providers: [
        provideIonicAngular({ animated: false }),
        provideRpcTesting(),
        {
          provide: ChatListStore,
          useValue: {
            chats: () => ({
              items: () => [],
              loading: () => false,
              loadingMore: () => false,
              listError: () => undefined,
              hasMore: () => false,
              loadedThrough: () => -Infinity,
              activate: () => () => {},
            }),
          },
        },
        {
          provide: AlertController,
          useValue: {
            create: async () => ({
              present: async () => {},
              dismiss: async () => {},
              onDidDismiss: async () => ({ role: 'confirm' }),
            }),
          },
        },
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
      vi.unstubAllGlobals();
    }
  });
  async function page() {
    const fixture = TestBed.createComponent(ChatInvites);
    fixture.componentRef.setInput('chatId', invite.chatId);
    fixture.detectChanges();
    peer
      .expect('invites.list', { groupId: '4', activeOnly: true, limit: 30 })
      .flush({ invites: [wire], nextCursor: 'cursor-1' });
    await fixture.whenStable();
    fixture.detectChanges();
    peer.expectNone('groups.list');
    return fixture;
  }
  it('shows only active invitations and preserves rows while loading the next page', async () => {
    const fixture = await page();
    const component = fixture.componentInstance;
    expect(fixture.nativeElement.querySelector('ion-segment')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('历史邀请');
    expect(fixture.nativeElement.textContent).not.toContain('刷新');
    expect(fixture.nativeElement.textContent).toContain('邀请 任意获得链接的人');
    expect(fixture.nativeElement.querySelectorAll('.invite-actions ion-button')).toHaveLength(3);
    peer.expectNone('invites.list');
    const pending = component['load'](true);
    expect(component['list']().rows).toEqual([invite]);
    peer
      .expect('invites.list', { groupId: '4', activeOnly: true, limit: 30, after: 'cursor-1' })
      .error(RpcErrorCode.Unavailable);
    await pending;
    expect(component['list']().rows).toEqual([invite]);
    expect(component['list']().failedMore).toBe(true);
    const retry = component['load'](true);
    peer
      .expect('invites.list', { groupId: '4', activeOnly: true, limit: 30, after: 'cursor-1' })
      .flush({ invites: [{ ...wire, id: '2' }] });
    await retry;
    expect(component['list']().rows.map((row) => decodeId(row.id))).toEqual(['3', '2']);
  });
  it('defaults to seven days and presents the generated invite without sending it', async () => {
    const component = (await page()).componentInstance;
    component['startCreate']();
    const before = Date.now();
    const created = component['create']();
    const request = peer.expect('invites.create');
    const expires = Date.parse(request.params!['expiresAt'] as string);
    expect(expires - before).toBeGreaterThanOrEqual(7 * 86400000);
    expect(expires - before).toBeLessThan(7 * 86400000 + 1000);
    request.flush(wire);
    await created;
    expect(component['creating']()).toBe(false);
    expect(component['list']().rows[0].id).toBe(invite.id);
    peer.expectNone('invites.send');
  });
  it('rejects missing or past custom expiry and preserves creation input on failure', async () => {
    const component = (await page()).componentInstance;
    component['startCreate']();
    component['changeExpiry']('custom');
    for (const expiry of ['', 'invalid', '2000-01-01T12:00']) {
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
    expect(component['operationError']()).toBe('chats.invites.createFailed');
    expect(component['creating']()).toBe(true);
  });
  it('retains the selected invite and destination on send failure and reuses the send id on retry', async () => {
    const component = (await page()).componentInstance;
    component['startShare'](invite);
    component['selectDestination']({
      chatId: encodeId('10'),
      name: '摄影交流',
      kind: GroupKind.group,
      avatar: {},
      time: 0,
    });
    const failed = component['share']();
    const request = await peer.expectAsync('invites.send');
    expect(request.params).toMatchObject({ sourceChatId: '4', inviteId: '3', destinationChatId: '10' });
    request.error(RpcErrorCode.Unavailable);
    await failed;
    expect(component['notice']()).toContain('发送失败');
    expect(component['selected']()).toBe(invite);
    expect(component['destination']()?.name).toBe('摄影交流');
    await component['startShare'](invite);
    const retry = component['chooseChat'](component['destination']()!, () => true);
    const retried = await peer.expectAsync('invites.send');
    expect(retried.params).toEqual(request.params);
    retried.flush({ invite: wire });
    await retry;
    expect(component['notice']()).toBe('邀请已发送到「摄影交流」');
    expect(component['creating']()).toBe(false);
    peer.expectNone('invites.create');
  });
  it('selects a private destination without sending until confirmation or loading group details', async () => {
    const component = (await page()).componentInstance;
    const details = vi.spyOn(TestBed.inject(ChatStore), 'ensureDetails');
    const destination = { chatId: encodeId('11'), name: '好友', kind: GroupKind.dm, avatar: {}, time: 0 };
    component['startShare'](invite);
    const pending = component['chooseChat'](destination, () => true);
    expect(component['destination']()).toEqual(destination);
    peer.expectNone('invites.send');
    (await peer.expectAsync('invites.send', (params) => params['destinationChatId'] === '11')).flush({ invite: wire });
    await pending;
    expect(details).not.toHaveBeenCalled();
    expect(component['notice']()).toBe('邀请已发送到「好友」');
  });
  it('keeps the membership condition separate from the selected sending destination', async () => {
    const component = (await page()).componentInstance;
    component['startCreate']();
    component['change'](InviteType.membership);
    const condition = { chatId: encodeId('12'), name: '条件群', kind: GroupKind.group, avatar: {}, time: 0 };
    component['picker'].set(component['Picker'].GroupCondition);
    await component['chooseChat'](condition, () => true);
    component['startShare'](invite);
    const destination = { ...condition, chatId: encodeId('13'), name: '目的群' };
    vi.spyOn(TestBed.inject(AlertController), 'create').mockResolvedValue({
      present: async () => {},
      dismiss: async () => {},
      onDidDismiss: async () => ({ role: 'cancel' }),
    } as unknown as HTMLIonAlertElement);
    expect(await component['chooseChat'](destination, () => true)).toBe(false);
    expect(component['requiredGroup']()).toBe(condition);
    expect(component['destination']()).toBe(destination);
    peer.expectNone('invites.send');
  });
  it('does not send when the picker target becomes unavailable during confirmation', async () => {
    const component = (await page()).componentInstance;
    let confirm!: (value: { role: string }) => void;
    const dismissed = new Promise<{ role: string }>((resolve) => (confirm = resolve));
    vi.spyOn(TestBed.inject(AlertController), 'create').mockResolvedValue({
      present: async () => {},
      dismiss: async () => {},
      onDidDismiss: () => dismissed,
    } as unknown as HTMLIonAlertElement);
    await component['startShare'](invite);
    let available = true;
    const sending = component['chooseChat'](
      { chatId: encodeId('10'), kind: GroupKind.group, avatar: {}, time: 0 },
      () => available,
    );
    await Promise.resolve();
    available = false;
    confirm({ role: 'confirm' });
    expect(await sending).toBe(false);
    peer.expectNone('invites.send');
  });
  it('confirms membership invitations and sends straight to the required group', async () => {
    const component = (await page()).componentInstance;
    const sending = component['startShare']({
      ...invite,
      inviteType: InviteType.membership,
      requiredChatId: encodeId('12'),
      requiredChatName: '条件群',
    });
    (await peer.expectAsync('invites.send', (params) => params['destinationChatId'] === '12')).flush({ invite: wire });
    await sending;
    expect(component['picker']()).toBeUndefined();
    expect(component['creating']()).toBe(false);
    expect(component['notice']()).toBe('邀请已发送到「条件群」');
  });
  it('resolves the specified user private chat only after confirmation', async () => {
    const component = (await page()).componentInstance;
    const sending = component['startShare']({
      ...invite,
      inviteType: InviteType.targeted,
      targetUid: 9,
      targetName: '小张',
    });
    (await peer.expectAsync('friends.getRelationship', { uid: 9 })).flush({ isFriend: true, dmChatId: '11' });
    (await peer.expectAsync('invites.send', (params) => params['destinationChatId'] === '11')).flush({ invite: wire });
    await sending;
    expect(component['picker']()).toBeUndefined();
    expect(component['notice']()).toBe('邀请已发送到「小张」');
  });
  it('does not send or look up a private chat when confirmation is cancelled', async () => {
    const component = (await page()).componentInstance;
    vi.spyOn(TestBed.inject(AlertController), 'create').mockResolvedValue({
      present: async () => {},
      dismiss: async () => {},
      onDidDismiss: async () => ({ role: 'cancel' }),
    } as unknown as HTMLIonAlertElement);
    await component['startShare']({ ...invite, inviteType: InviteType.targeted, targetUid: 9 });
    peer.expectNone('friends.getRelationship');
    peer.expectNone('invites.send');
    expect(component['picker']()).toBeUndefined();
  });
  it('explains when a specified user has no private chat', async () => {
    const component = (await page()).componentInstance;
    const sending = component['startShare']({ ...invite, inviteType: InviteType.targeted, targetUid: 9 });
    (await peer.expectAsync('friends.getRelationship', { uid: 9 })).flush({ isFriend: false });
    await sending;
    peer.expectNone('invites.send');
    expect(component['notice']()).toContain('尚无可用私聊');
    expect(component['busy']()).toBe(false);
  });
  it('ignores direct sending confirmation after changing chats', async () => {
    const fixture = await page();
    let confirm!: (result: { role: string }) => void;
    const dismissed = new Promise<{ role: string }>((resolve) => (confirm = resolve));
    vi.spyOn(TestBed.inject(AlertController), 'create').mockResolvedValue({
      present: async () => {},
      dismiss: async () => {},
      onDidDismiss: () => dismissed,
    } as unknown as HTMLIonAlertElement);
    const sending = fixture.componentInstance['startShare']({
      ...invite,
      inviteType: InviteType.targeted,
      targetUid: 9,
    });
    fixture.componentRef.setInput('chatId', encodeId('5'));
    fixture.detectChanges();
    peer.expect('invites.list').flush({ invites: [] });
    confirm({ role: 'confirm' });
    await sending;
    peer.expectNone('friends.getRelationship');
    peer.expectNone('invites.send');
  });
  it('removes a revoked invitation without requesting history', async () => {
    const component = (await page()).componentInstance;
    const pending = component['revoke'](invite);
    (await peer.expectAsync('invites.delete', { inviteId: '3' })).flush(null);
    await pending;
    expect(component['list']().rows).toEqual([]);
    peer.expectNone('invites.list');
  });
  it('creates permanent invitations without an expiration and limits targeted invitations to the selected user', async () => {
    const fixture = await page();
    const component = fixture.componentInstance;
    component['startCreate']();
    component['changeExpiry']('never');
    component['change'](InviteType.targeted);
    await component['create']();
    peer.expectNone('invites.create');
    component['picker'].set(component['Picker'].User);
    component['editorReady'].set(true);
    fixture.detectChanges();
    const picker = fixture.debugElement.query(By.directive(ChatPicker)).componentInstance as ChatPicker;
    expect(picker.scope()).toBe(ChatPickerScope.Users);
    picker.userSelected.emit({ uid: 9, username: '小张', gender: 0 });
    picker.closed.emit();
    expect(component['target']()?.uid).toBe(9);
    component['picker'].set(component['Picker'].User);
    fixture.detectChanges();
    const reopened = fixture.debugElement.query(By.directive(ChatPicker)).componentInstance as ChatPicker;
    reopened.closed.emit();
    expect(component['target']()?.uid).toBe(9);
    const created = component['create']();
    const request = peer.expect('invites.create');
    expect(request.params).toEqual({ chatId: '4', inviteType: 'targeted', targetUid: 9 });
    request.flush({ ...wire, inviteType: 'targeted', targetUid: 9 });
    await created;
    expect(component['list']().rows[0].targetName).toBe('小张');
  });
  it('ignores a list response after switching chats', async () => {
    const fixture = TestBed.createComponent(ChatInvites);
    fixture.componentRef.setInput('chatId', invite.chatId);
    fixture.detectChanges();
    const old = peer.expect('invites.list');
    fixture.componentRef.setInput('chatId', encodeId('5'));
    fixture.detectChanges();
    peer.expect('invites.list', { groupId: '5', activeOnly: true, limit: 30 }).flush({ invites: [] });
    old.flush({ invites: [wire] });
    await fixture.whenStable();
    expect(fixture.componentInstance['list']().rows).toEqual([]);
  });
  it('keeps group selection requests and retries local to their picker', async () => {
    const fixture = TestBed.createComponent(ChatPicker);
    fixture.componentRef.setInput('scope', ChatPickerScope.JoinedGroups);
    fixture.componentRef.setInput('title', '选择群聊');
    fixture.componentRef.setInput('choose', () => true);
    fixture.componentRef.setInput('excludedId', invite.chatId);
    fixture.detectChanges();
    peer.expect('groups.list').error(RpcErrorCode.Unavailable);
    await fixture.whenStable();
    expect(fixture.componentInstance['groupsError']()).toBe(true);
    const retry = fixture.componentInstance['loadGroups']();
    peer.expect('groups.list').flush({
      groups: [
        { id: '4', name: 'Current' },
        { id: '10', name: 'Other' },
      ],
    });
    await retry;
    expect(fixture.componentInstance['targets']().map((group) => group.name)).toEqual(['Other']);
    peer.expectNone('invites.list');
  });
});
