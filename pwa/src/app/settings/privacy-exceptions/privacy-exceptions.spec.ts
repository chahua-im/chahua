import { signal } from '@angular/core';
import type { Mock } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AlertController, provideIonicAngular } from '@ionic/angular';
import { Subject } from 'rxjs';
import { PrivacyExceptionKind, type PrivacyException } from '../../../generated/models';
import { RpcTestPeer, provideRpcTesting } from '../../api/rpc-testing';
import { testUser } from '../../api/testing';
import { ChatStore } from '../../chats/chat-store';
import { Presence } from '../../presence/presence';
import { SessionStore } from '../../session/session-store';
import { PrivacyExceptions } from './privacy-exceptions';

describe('Privacy exceptions', () => {
  const row: PrivacyException = { user: { uid: 2, username: '好友', gender: 0 }, share: true };
  const account = signal({ ...testUser });
  let peer: RpcTestPeer;
  let alerts: { create: Mock };
  let chats: {
    invalidateReadReceiptPrivacy: Mock;
    publishPrivacyOverride: Mock;
    privacyOverrides$: Subject<{ kind: PrivacyExceptionKind }>;
  };
  const presence = { invalidateUsers: vi.fn() };
  type FriendOverrideMethod = 'friends.updatePresenceSettings' | 'friends.updateReadReceiptSettings';
  beforeEach(() => {
    account.set({ ...testUser });
    presence.invalidateUsers.mockClear();
    alerts = {
      create: vi.fn(async () => ({
        present: async () => {},
        onDidDismiss: async () => ({ role: 'confirm', data: { values: 'hide' } }),
      })),
    };
    chats = {
      invalidateReadReceiptPrivacy: vi.fn(),
      publishPrivacyOverride: vi.fn(),
      privacyOverrides$: new Subject(),
    };
    TestBed.configureTestingModule({
      providers: [
        provideIonicAngular({ animated: false }),
        provideRpcTesting(),
        { provide: SessionStore, useValue: { user: account } },
        { provide: ChatStore, useValue: chats },
        { provide: Presence, useValue: presence },
        { provide: AlertController, useValue: alerts },
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

  async function expectOverride(method: FriendOverrideMethod, override: string) {
    const request = await peer.expectAsync(method, (params) => params['uid'] === row.user.uid);
    expect(request.params).toEqual({ uid: row.user.uid, override });
    return request;
  }
  function open(kind = PrivacyExceptionKind.presence) {
    const fixture = TestBed.createComponent(PrivacyExceptions);
    fixture.componentRef.setInput('kind', kind);
    fixture.detectChanges();
    return fixture;
  }

  async function loaded(kind = PrivacyExceptionKind.presence) {
    const fixture = open(kind);
    peer.expect('privacy.listExceptions', { kind }).flush({ exceptions: [row] });
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('only shows empty after a successful read and preserves rows during refresh failure', async () => {
    const fixture = open();
    const component = fixture.componentInstance;
    peer.expect('privacy.listExceptions', { kind: PrivacyExceptionKind.presence }).error(1503);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('暂无例外');
    const retry = component['load']();
    peer.expect('privacy.listExceptions', { kind: PrivacyExceptionKind.presence }).flush({ exceptions: [row] });
    await retry;
    fixture.detectChanges();
    const avatar = fixture.nativeElement.querySelector('app-chat-avatar');
    const refresh = component['load']();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-chat-avatar')).toBe(avatar);
    peer.expect('privacy.listExceptions', { kind: PrivacyExceptionKind.presence }).error(1503);
    await refresh;
    expect(component['rows']()).toEqual([row]);
  });

  it('blocks accidental picker dismissal during a save but permits navigation cleanup', async () => {
    const fixture = await loaded();
    const component = fixture.componentInstance;
    const saving = component['remove'](row);
    fixture.detectChanges();
    const picker: HTMLIonModalElement = fixture.nativeElement.querySelector('ion-modal');
    expect(typeof picker.canDismiss).toBe('function');
    const canDismiss = picker.canDismiss as (_data?: unknown, role?: string) => Promise<boolean>;
    expect(await canDismiss(undefined, 'backdrop')).toBe(false);
    for (const role of ['navigate', 'parent-dismissed', 'parent-removed'])
      expect(await canDismiss(undefined, role)).toBe(true);
    (await expectOverride('friends.updatePresenceSettings', 'inherit')).flush({});
    await saving;
    expect(await canDismiss(undefined, 'backdrop')).toBe(true);
  });

  it.each([PrivacyExceptionKind.presence, PrivacyExceptionKind.readReceipts])(
    'saves and removes %s overrides without changing the global policy',
    async (kind) => {
      const component = (await loaded(kind)).componentInstance;
      const saving = component['choose'](row.user, true);
      await vi.waitFor(() => expect(alerts.create).toHaveBeenCalledOnce());
      const method: FriendOverrideMethod =
        kind === PrivacyExceptionKind.presence ? 'friends.updatePresenceSettings' : 'friends.updateReadReceiptSettings';
      (await expectOverride(method, 'hide')).flush({});
      await saving;
      expect(component['rows']()).toEqual([{ ...row, share: false }]);
      expect(chats.publishPrivacyOverride).toHaveBeenCalledWith(kind, 2, false);
      const removal = component['remove'](row);
      (await expectOverride(method, 'inherit')).flush({});
      await removal;
      expect(component['rows']()).toEqual([]);
    },
  );

  it('retains an exception after a failed write and ignores an older list arriving after removal', async () => {
    const component = (await loaded()).componentInstance;
    const failure = component['remove'](row);
    (await expectOverride('friends.updatePresenceSettings', 'inherit')).error(1503);
    await failure;
    expect(component['rows']()).toEqual([row]);
    expect(component['saveFailed']()).toBe(true);
    const refresh = component['load']();
    const old = peer.expect('privacy.listExceptions', { kind: PrivacyExceptionKind.presence });
    const removal = component['remove'](row);
    (await expectOverride('friends.updatePresenceSettings', 'inherit')).flush({});
    await removal;
    old.flush({ exceptions: [row] });
    await refresh;
    expect(component['rows']()).toEqual([]);
  });

  it('clears only after confirmation, keeps rows on failure and reloads after success', async () => {
    const component = (await loaded()).componentInstance;
    alerts.create.mockResolvedValueOnce({ present: async () => {}, onDidDismiss: async () => ({ role: 'cancel' }) });
    await component['clear']();
    peer.expectNone('privacy.clearExceptions');
    alerts.create.mockResolvedValue({ present: async () => {}, onDidDismiss: async () => ({ role: 'destructive' }) });
    const failed = component['clear']();
    await vi.waitFor(() => expect(alerts.create).toHaveBeenCalledTimes(2));
    (await peer.expectAsync('privacy.clearExceptions', { kind: PrivacyExceptionKind.presence })).error(1503);
    await failed;
    expect(component['rows']()).toEqual([row]);
    const success = component['clear']();
    await vi.waitFor(() => expect(alerts.create).toHaveBeenCalledTimes(3));
    (await peer.expectAsync('privacy.clearExceptions', { kind: PrivacyExceptionKind.presence })).flush(null);
    (await peer.expectAsync('privacy.listExceptions', { kind: PrivacyExceptionKind.presence })).flush({
      exceptions: [],
    });
    await success;
    expect(component['rows']()).toEqual([]);
    expect(chats.publishPrivacyOverride).toHaveBeenCalledWith(PrivacyExceptionKind.presence);
  });

  it('loads friend choices in one request, filters them and excludes existing exceptions', async () => {
    const component = (await loaded()).componentInstance;
    const loading = component['loadFriends']();
    peer.expect('friends.list').flush({
      friends: [{ user: row.user }, { user: { ...row.user, uid: 3, username: '另一个' } }],
    });
    await loading;
    component['query'].set('另');
    expect(component['candidates']()?.map((user) => user.uid)).toEqual([3]);
    expect(component['existing']().has(2)).toBe(true);
  });

  it('uses scoped receipt invalidation instead of refreshing every DM after clearing exceptions', async () => {
    const component = (await loaded(PrivacyExceptionKind.readReceipts)).componentInstance;
    alerts.create.mockResolvedValue({ present: async () => {}, onDidDismiss: async () => ({ role: 'destructive' }) });
    const clearing = component['clear']();
    (await peer.expectAsync('privacy.clearExceptions', { kind: PrivacyExceptionKind.readReceipts })).flush(null);
    (await peer.expectAsync('privacy.listExceptions', { kind: PrivacyExceptionKind.readReceipts })).flush({
      exceptions: [],
    });
    await clearing;
    expect(component['rows']()).toEqual([]);
    expect(chats.publishPrivacyOverride).toHaveBeenCalledWith(PrivacyExceptionKind.readReceipts);
    expect(chats.invalidateReadReceiptPrivacy).not.toHaveBeenCalled();
    expect(presence.invalidateUsers).not.toHaveBeenCalled();
  });

  it('clears private rows on account changes and rejects old-account responses', async () => {
    const fixture = await loaded();
    const component = fixture.componentInstance;
    const refresh = component['load']();
    const old = peer.expect('privacy.listExceptions', { kind: PrivacyExceptionKind.presence });
    account.set({ ...testUser, uid: 8 });
    fixture.detectChanges();
    expect(component['rows']()).toBeUndefined();
    peer.expect('privacy.listExceptions', { kind: PrivacyExceptionKind.presence }).flush({ exceptions: [] });
    old.flush({ exceptions: [row] });
    await refresh;
    await fixture.whenStable();
    expect(component['rows']()).toEqual([]);
  });
});
