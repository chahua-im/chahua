import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AlertController, IonPopover, IonToast } from '@ionic/angular';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import {
  GroupRole,
  SpeakingMode,
  ServerWsMessageType,
  type ServerWsMessage,
  type MemberResponse,
} from '../../../generated/models';
import { decodeId, encodeId } from '../../api/snowflake-id';
import { RpcErrorCode } from '../../api/rpc-error';
import { provideRpcTesting, RpcTestPeer } from '../../api/rpc-testing';
import { mockRealtime, testChat, testUser, wireChat } from '../../api/testing';
import { Connection } from '../../api/connection';
import { SessionStore } from '../../session/session-store';
import { ChatMembers } from './chat-members';

const member: MemberResponse = {
  uid: 2,
  username: '成员甲',
  gender: 0,
  role: GroupRole.member,
  joinedAt: '',
  speakingMode: SpeakingMode.unrestricted,
};
const admin: MemberResponse = { ...member, uid: 3, username: '管理员乙', role: GroupRole.admin };
const self: MemberResponse = { ...admin, uid: testUser.uid, username: testUser.username };
const membersParams = (params: Record<string, unknown> = {}) => ({
  chatId: wireChat.id,
  limit: 40,
  mode: 'autocomplete',
  ...params,
});

describe('ChatMembers management', () => {
  let peer: RpcTestPeer;
  let events: Subject<ServerWsMessage>;
  let resync: Subject<void>;
  const alert = { present: vi.fn(), onDidDismiss: vi.fn() };

  beforeEach(() => {
    events = new Subject();
    resync = new Subject();
    alert.onDidDismiss.mockReset().mockResolvedValue({ role: 'confirm' });
    vi.spyOn(IonPopover.prototype, 'present').mockResolvedValue();
    vi.spyOn(IonPopover.prototype, 'dismiss').mockResolvedValue(true);
    vi.spyOn(IonToast.prototype, 'present').mockResolvedValue();
    TestBed.configureTestingModule({
      providers: [
        provideRpcTesting(),
        { provide: Connection, useValue: mockRealtime({ events$: events, resync$: resync }) },
        { provide: SessionStore, useValue: { user: signal(testUser) } },
        { provide: AlertController, useValue: { create: vi.fn().mockResolvedValue(alert) } },
      ],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
  });
  afterEach(() => peer.verify());

  async function open(canManage = true) {
    const fixture = TestBed.createComponent(ChatMembers);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.componentRef.setInput('canManage', canManage);
    fixture.detectChanges();
    peer
      .expect('groups.listMembers', membersParams())
      .flush({ members: [self, member, admin], canManageMembers: canManage });
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  function search(fixture: Awaited<ReturnType<typeof open>>, query: string) {
    fixture.nativeElement
      .querySelector('ion-searchbar')
      .dispatchEvent(new CustomEvent('ionInput', { detail: { value: query } }));
    fixture.detectChanges();
  }

  it('applies member restrictions and protects live updates from delayed searches and saves', async () => {
    const fixture = await open();
    const component = fixture.componentInstance;
    search(fixture, '成员');
    const read = peer.expect('groups.listMembers', membersParams({ q: '成员' }));
    events.next({
      type: ServerWsMessageType.memberSpeakingModeChanged,
      payload: {
        chatId: testChat.id,
        uid: member.uid,
        role: GroupRole.member,
        speakingMode: SpeakingMode.readOnly,
        groupSpeakingMode: SpeakingMode.unrestricted,
        effectiveSpeakingMode: SpeakingMode.readOnly,
      },
    });
    read.flush({ members: [member] });
    await fixture.whenStable();
    expect(component['members']()[0].speakingMode).toBe(SpeakingMode.readOnly);
    const saving = component['changeSpeakingMode'](component['members']()[0], SpeakingMode.unrestricted);
    const request = peer.expect('groups.updateMemberSpeakingMode', {
      chatId: wireChat.id,
      uid: member.uid,
      speakingMode: SpeakingMode.unrestricted,
    });
    events.next({
      type: ServerWsMessageType.memberSpeakingModeChanged,
      payload: {
        chatId: testChat.id,
        uid: member.uid,
        role: GroupRole.member,
        speakingMode: SpeakingMode.repliesOnly,
        groupSpeakingMode: SpeakingMode.unrestricted,
        effectiveSpeakingMode: SpeakingMode.repliesOnly,
      },
    });
    request.flush({
      chatId: testChat.id,
      uid: member.uid,
      role: GroupRole.member,
      speakingMode: SpeakingMode.unrestricted,
      groupSpeakingMode: SpeakingMode.unrestricted,
      effectiveSpeakingMode: SpeakingMode.unrestricted,
    });
    await saving;
    expect(component['members']()[0].speakingMode).toBe(SpeakingMode.repliesOnly);
  });

  it('refreshes loaded members on reconnect without clearing rows and rejects administrator restrictions', async () => {
    const fixture = await open();
    const component = fixture.componentInstance;
    const row = fixture.nativeElement.querySelectorAll('ion-list > ion-item')[1];
    await component['changeSpeakingMode'](admin, SpeakingMode.readOnly);
    peer.expectNone('groups.updateMemberSpeakingMode');
    resync.next();
    peer.expect('users.getNotificationSettings', {}).flush({});
    const refresh = peer.expect('groups.listMembers', membersParams());
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('ion-list > ion-item')[1]).toBe(row);
    refresh.flush({ members: [self, { ...member, speakingMode: SpeakingMode.readOnly }, admin] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('ion-list > ion-item')[1]).toBe(row);
    expect(row.textContent).toContain('禁止发言');
  });

  it('searches all group members like mentions and keeps rows until the response arrives', async () => {
    const fixture = await open();
    const row = fixture.nativeElement.querySelectorAll('ion-list > ion-item')[1];
    search(fixture, ' 成员 ');
    const request = peer.expect('groups.listMembers', membersParams({ q: '成员' }));
    expect(request.params?.['q']).toBe('成员');
    expect(request.params?.['mode']).toBe('autocomplete');
    expect(request.params?.['after']).toBeUndefined();
    expect(fixture.nativeElement.querySelectorAll('ion-list > ion-item')).toHaveLength(3);
    expect(fixture.nativeElement.querySelector('.page-loading')).toBeNull();
    request.flush({ members: [member], nextCursor: member.uid, canManageMembers: true });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-list > ion-item')).toBe(row);
    expect(row.querySelector('ion-button')).not.toBeNull();
    const more = fixture.componentInstance['load'](true);
    const next = peer.expect('groups.listMembers', membersParams({ q: '成员', after: member.uid }));
    expect(next.params?.['q']).toBe('成员');
    expect(next.params?.['after']).toBe(member.uid);
    next.flush({ members: [admin], canManageMembers: true });
    await more;
    expect(fixture.componentInstance['members']()).toEqual([member, admin]);
  });

  it('cancels outdated searches and pagination, and restores the full list when cleared', async () => {
    const fixture = await open();
    search(fixture, '甲');
    const obsolete = peer.expect('groups.listMembers', membersParams({ q: '甲' }));
    search(fixture, '乙');
    const current = peer.expect('groups.listMembers', membersParams({ q: '乙' }));
    current.flush({ members: [admin], nextCursor: admin.uid });
    obsolete.flush({ members: [member] });
    await fixture.whenStable();
    const more = fixture.componentInstance['load'](true);
    const pagination = peer.expect('groups.listMembers', membersParams({ q: '乙', after: admin.uid }));
    search(fixture, '');
    pagination.flush({ members: [member] });
    const cleared = peer.expect('groups.listMembers', membersParams());
    expect(cleared.params?.['q']).toBeUndefined();
    expect(cleared.params?.['after']).toBeUndefined();
    cleared.flush({ members: [self, member, admin] });
    await more;
    await fixture.whenStable();
    expect(fixture.componentInstance['members']()).toEqual([self, member, admin]);
    expect(fixture.componentInstance['error']()).toBe(false);
  });

  it('retains results on search failure and shows an empty state only after successful retry', async () => {
    const fixture = await open(false);
    search(fixture, '不存在');
    peer.expect('groups.listMembers', membersParams({ q: '不存在' })).error(RpcErrorCode.Internal);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance['members']()).toEqual([self, member, admin]);
    expect(fixture.nativeElement.querySelector('app-load-error')).not.toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('没有找到匹配的群成员');
    const retry = fixture.componentInstance['load']();
    peer.expect('groups.listMembers', membersParams({ q: '不存在' })).flush({ members: [] });
    await retry;
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('没有找到匹配的群成员');
    expect(fixture.nativeElement.querySelector('app-load-error')).toBeNull();
  });

  it('defers the latest search until a management request completes', async () => {
    const fixture = await open();
    const operation = fixture.componentInstance['changeRole'](member);
    const update = peer.expect('groups.updateMember', { chatId: wireChat.id, uid: member.uid, role: GroupRole.admin });
    search(fixture, '甲');
    search(fixture, '成员');
    peer.expectNone('groups.listMembers');
    update.flush({ ...member, role: GroupRole.admin });
    await operation;
    fixture.detectChanges();
    const request = peer.expect('groups.listMembers', membersParams({ q: '成员' }));
    expect(request.params?.['q']).toBe('成员');
    request.flush({ members: [{ ...member, role: GroupRole.admin }] });
    await fixture.whenStable();
    expect(fixture.componentInstance['members']()[0].role).toBe(GroupRole.admin);
  });

  it('resets the search and cancels old reads when changing groups', async () => {
    const fixture = await open();
    search(fixture, '甲');
    const obsolete = peer.expect('groups.listMembers', membersParams({ q: '甲' }));
    fixture.componentRef.setInput('chatId', encodeId('9007199254740995'));
    fixture.detectChanges();
    obsolete.flush({ members: [member] });
    expect(fixture.componentInstance['query']()).toBe('');
    expect(fixture.componentInstance['members']()).toEqual([]);
    const request = peer.expect('groups.listMembers', {
      chatId: decodeId(encodeId('9007199254740995')),
      limit: 40,
      mode: 'autocomplete',
    });
    expect(request.params?.['q']).toBeUndefined();
    request.flush({ members: [admin] });
    await fixture.whenStable();
    expect(fixture.componentInstance['members']()).toEqual([admin]);
  });

  it('only manages other members and opens the menu without profile navigation', async () => {
    const fixture = await open();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    const rows = fixture.nativeElement.querySelectorAll('ion-list > ion-item');
    expect(rows[0].querySelector('ion-button')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('ion-button')).toHaveLength(2);
    rows[1].querySelector('ion-button').click();
    fixture.detectChanges();
    expect(fixture.componentInstance['selected']()?.uid).toBe(member.uid);
    expect(IonPopover.prototype.present).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    fixture.componentRef.setInput('canManage', false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-button')).toBeNull();
    expect(fixture.componentInstance['selected']()).toBeUndefined();
    await fixture.componentInstance['changeRole'](member);
    peer.expectNone('groups.updateMember');
  });

  it('retains profile navigation for ordinary members without management buttons', async () => {
    const fixture = await open(false);
    expect(fixture.nativeElement.querySelectorAll('ion-list > ion-item')).toHaveLength(3);
    expect(fixture.nativeElement.querySelector('ion-button')).toBeNull();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    fixture.nativeElement.querySelectorAll('ion-list > ion-item')[1].click();
    expect(navigate).toHaveBeenCalled();
  });

  it.each([
    [member, GroupRole.admin],
    [admin, GroupRole.member],
  ])('updates roles in place after confirmation (%j)', async (target, role) => {
    const fixture = await open();
    const row = fixture.nativeElement.querySelectorAll('ion-list > ion-item')[target.uid - 1];
    const operation = fixture.componentInstance['changeRole'](target);
    fixture.detectChanges();
    expect(fixture.componentInstance['pending']()).toBe(target.uid);
    expect(row.querySelector('ion-spinner')).not.toBeNull();
    expect(fixture.componentInstance['members']().find((item) => item.uid === target.uid)?.role).toBe(target.role);
    await fixture.componentInstance['changeRole'](target);
    const request = peer.expect('groups.updateMember', { chatId: wireChat.id, uid: target.uid, role });
    expect(request.params).toEqual({ chatId: wireChat.id, uid: target.uid, role });
    request.flush({ ...target, role });
    await operation;
    fixture.detectChanges();
    expect(fixture.componentInstance['members']().find((item) => item.uid === target.uid)?.role).toBe(role);
    expect(fixture.nativeElement.querySelectorAll('ion-list > ion-item')[target.uid - 1]).toBe(row);
    expect(fixture.componentInstance['pending']()).toBeUndefined();
    peer.expectNone('groups.listMembers');
  });

  it('preserves a failed role change and allows retry', async () => {
    const fixture = await open();
    const operation = fixture.componentInstance['changeRole'](member);
    peer
      .expect('groups.updateMember', { chatId: wireChat.id, uid: member.uid, role: GroupRole.admin })
      .error(RpcErrorCode.Forbidden);
    await operation;
    expect(fixture.componentInstance['members']()[1]).toEqual(member);
    expect(fixture.componentInstance['pending']()).toBeUndefined();
    expect(IonToast.prototype.present).toHaveBeenCalled();
    const retry = fixture.componentInstance['changeRole'](member);
    peer
      .expect('groups.updateMember', { chatId: wireChat.id, uid: member.uid, role: GroupRole.admin })
      .flush({ ...member, role: GroupRole.admin });
    await retry;
    expect(fixture.componentInstance['members']()[1].role).toBe(GroupRole.admin);
  });

  it('removes only after confirmation and retains other members', async () => {
    const fixture = await open();
    alert.onDidDismiss.mockResolvedValueOnce({ role: 'cancel' });
    await fixture.componentInstance['remove'](member);
    peer.expectNone('groups.removeMember');
    const operation = fixture.componentInstance['remove'](member);
    await vi.waitFor(() => expect(fixture.componentInstance['pending']()).toBe(member.uid));
    const request = peer.expect('groups.removeMember', { chatId: wireChat.id, uid: member.uid });
    expect(request.params).toEqual({ chatId: wireChat.id, uid: member.uid });
    request.flush(null);
    await operation;
    expect(fixture.componentInstance['members']().map((item) => item.uid)).toEqual([self.uid, admin.uid]);
  });

  it('rechecks permissions after the removal confirmation', async () => {
    const fixture = await open();
    let confirm!: (value: { role: string }) => void;
    alert.onDidDismiss.mockReturnValueOnce(
      new Promise((resolve) => {
        confirm = resolve;
      }),
    );
    const operation = fixture.componentInstance['remove'](member);
    await vi.waitFor(() => expect(alert.onDidDismiss).toHaveBeenCalled());
    fixture.componentRef.setInput('canManage', false);
    fixture.detectChanges();
    confirm({ role: 'confirm' });
    await operation;
    peer.expectNone('groups.removeMember');
  });

  it('ignores a delayed response after switching groups', async () => {
    const fixture = await open();
    const operation = fixture.componentInstance['changeRole'](member);
    const request = peer.expect('groups.updateMember', { chatId: wireChat.id, uid: member.uid, role: GroupRole.admin });
    fixture.componentRef.setInput('chatId', encodeId('9007199254740995'));
    fixture.detectChanges();
    peer
      .expect('groups.listMembers', { chatId: decodeId(encodeId('9007199254740995')), limit: 40, mode: 'autocomplete' })
      .flush({ members: [member], canManageMembers: true });
    await fixture.whenStable();
    request.flush({ ...member, role: GroupRole.admin });
    await operation;
    expect(fixture.componentInstance['members']()).toEqual([member]);
    expect(fixture.componentInstance['pending']()).toBeUndefined();
  });
});
