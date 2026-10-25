import { HttpTestingController } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AlertController, IonPopover, IonToast } from '@ionic/angular';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import {
  GroupRole,
  SpeakingMode,
  ServerWsMessageType,
  type ServerWsMessage,
  type MemberResponse,
} from '../../../generated/models';
import { encodeId } from '../../api/snowflake-id';
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
const url = `/_api/group/${wireChat.id}/members`;

describe('ChatMembers management', () => {
  let http: HttpTestingController;
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
        provideChahuaBaseUrl('/_api'),
        { provide: Connection, useValue: mockRealtime({ events$: events, resync$: resync }) },
        { provide: SessionStore, useValue: { user: signal(testUser) } },
        { provide: AlertController, useValue: { create: vi.fn().mockResolvedValue(alert) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  async function open(canManage = true) {
    const fixture = TestBed.createComponent(ChatMembers);
    fixture.componentRef.setInput('chatId', testChat.id);
    fixture.componentRef.setInput('canManage', canManage);
    fixture.detectChanges();
    http.expectOne((req) => req.url === url).flush({ members: [self, member, admin], canManageMembers: canManage });
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
    const read = http.expectOne((req) => req.url === url);
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
    const request = http.expectOne(`${url}/${member.uid}/speaking-mode`);
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
    http.expectNone((req) => req.method === 'PUT');
    resync.next();
    http.expectOne('/_api/users/me/notification-settings').flush({});
    const refresh = http.expectOne((req) => req.url === url);
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
    const request = http.expectOne((req) => req.url === url);
    expect(request.request.params.get('q')).toBe('成员');
    expect(request.request.params.get('mode')).toBe('autocomplete');
    expect(request.request.params.has('after')).toBe(false);
    expect(fixture.nativeElement.querySelectorAll('ion-list > ion-item')).toHaveLength(3);
    expect(fixture.nativeElement.querySelector('.page-loading')).toBeNull();
    request.flush({ members: [member], nextCursor: member.uid, canManageMembers: true });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-list > ion-item')).toBe(row);
    expect(row.querySelector('ion-button')).not.toBeNull();
    const more = fixture.componentInstance['load'](true);
    const next = http.expectOne((req) => req.url === url);
    expect(next.request.params.get('q')).toBe('成员');
    expect(next.request.params.get('after')).toBe(String(member.uid));
    next.flush({ members: [admin], canManageMembers: true });
    await more;
    expect(fixture.componentInstance['members']()).toEqual([member, admin]);
  });

  it('cancels outdated searches and pagination, and restores the full list when cleared', async () => {
    const fixture = await open();
    search(fixture, '甲');
    const obsolete = http.expectOne((req) => req.url === url);
    search(fixture, '乙');
    expect(obsolete.cancelled).toBe(true);
    http.expectOne((req) => req.params.get('q') === '乙').flush({ members: [admin], nextCursor: admin.uid });
    await fixture.whenStable();
    const more = fixture.componentInstance['load'](true);
    const pagination = http.expectOne((req) => req.params.get('after') === String(admin.uid));
    search(fixture, '');
    expect(pagination.cancelled).toBe(true);
    const cleared = http.expectOne((req) => req.url === url);
    expect(cleared.request.params.has('q')).toBe(false);
    expect(cleared.request.params.has('after')).toBe(false);
    cleared.flush({ members: [self, member, admin] });
    await more;
    await fixture.whenStable();
    expect(fixture.componentInstance['members']()).toEqual([self, member, admin]);
    expect(fixture.componentInstance['error']()).toBe(false);
  });

  it('retains results on search failure and shows an empty state only after successful retry', async () => {
    const fixture = await open(false);
    search(fixture, '不存在');
    http.expectOne((req) => req.url === url).flush({}, { status: 500, statusText: 'Server Error' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance['members']()).toEqual([self, member, admin]);
    expect(fixture.nativeElement.querySelector('app-load-error')).not.toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('没有找到匹配的群成员');
    const retry = fixture.componentInstance['load']();
    http.expectOne((req) => req.params.get('q') === '不存在').flush({ members: [] });
    await retry;
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('没有找到匹配的群成员');
    expect(fixture.nativeElement.querySelector('app-load-error')).toBeNull();
  });

  it('defers the latest search until a management request completes', async () => {
    const fixture = await open();
    const operation = fixture.componentInstance['changeRole'](member);
    const update = http.expectOne(`${url}/${member.uid}`);
    search(fixture, '甲');
    search(fixture, '成员');
    http.expectNone((req) => req.method === 'GET');
    update.flush({ ...member, role: GroupRole.admin });
    await operation;
    fixture.detectChanges();
    const request = http.expectOne((req) => req.url === url);
    expect(request.request.params.get('q')).toBe('成员');
    request.flush({ members: [{ ...member, role: GroupRole.admin }] });
    await fixture.whenStable();
    expect(fixture.componentInstance['members']()[0].role).toBe(GroupRole.admin);
  });

  it('resets the search and cancels old reads when changing groups', async () => {
    const fixture = await open();
    search(fixture, '甲');
    const obsolete = http.expectOne((req) => req.url === url);
    fixture.componentRef.setInput('chatId', encodeId('9007199254740995'));
    fixture.detectChanges();
    expect(obsolete.cancelled).toBe(true);
    expect(fixture.componentInstance['query']()).toBe('');
    expect(fixture.componentInstance['members']()).toEqual([]);
    const request = http.expectOne((req) => req.url.endsWith('/9007199254740995/members'));
    expect(request.request.params.has('q')).toBe(false);
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
    http.expectNone((req) => req.method === 'PATCH');
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
    const request = http.expectOne(`${url}/${target.uid}`);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ role });
    request.flush({ ...target, role });
    await operation;
    fixture.detectChanges();
    expect(fixture.componentInstance['members']().find((item) => item.uid === target.uid)?.role).toBe(role);
    expect(fixture.nativeElement.querySelectorAll('ion-list > ion-item')[target.uid - 1]).toBe(row);
    expect(fixture.componentInstance['pending']()).toBeUndefined();
    http.expectNone((req) => req.method === 'GET');
  });

  it('preserves a failed role change and allows retry', async () => {
    const fixture = await open();
    const operation = fixture.componentInstance['changeRole'](member);
    http.expectOne(`${url}/${member.uid}`).flush({}, { status: 403, statusText: 'Forbidden' });
    await operation;
    expect(fixture.componentInstance['members']()[1]).toEqual(member);
    expect(fixture.componentInstance['pending']()).toBeUndefined();
    expect(IonToast.prototype.present).toHaveBeenCalled();
    const retry = fixture.componentInstance['changeRole'](member);
    http.expectOne(`${url}/${member.uid}`).flush({ ...member, role: GroupRole.admin });
    await retry;
    expect(fixture.componentInstance['members']()[1].role).toBe(GroupRole.admin);
  });

  it('removes only after confirmation and retains other members', async () => {
    const fixture = await open();
    alert.onDidDismiss.mockResolvedValueOnce({ role: 'cancel' });
    await fixture.componentInstance['remove'](member);
    http.expectNone((req) => req.method === 'DELETE');
    const operation = fixture.componentInstance['remove'](member);
    await vi.waitFor(() => expect(fixture.componentInstance['pending']()).toBe(member.uid));
    const request = http.expectOne(`${url}/${member.uid}`);
    expect(request.request.method).toBe('DELETE');
    expect(request.request.params.has('deleteMessages')).toBe(false);
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
    http.expectNone((req) => req.method === 'DELETE');
  });

  it('ignores a delayed response after switching groups', async () => {
    const fixture = await open();
    const operation = fixture.componentInstance['changeRole'](member);
    const request = http.expectOne(`${url}/${member.uid}`);
    fixture.componentRef.setInput('chatId', encodeId('9007199254740995'));
    fixture.detectChanges();
    http
      .expectOne((req) => req.url.endsWith('/9007199254740995/members'))
      .flush({ members: [member], canManageMembers: true });
    await fixture.whenStable();
    request.flush({ ...member, role: GroupRole.admin });
    await operation;
    expect(fixture.componentInstance['members']()).toEqual([member]);
    expect(fixture.componentInstance['pending']()).toBeUndefined();
  });
});
