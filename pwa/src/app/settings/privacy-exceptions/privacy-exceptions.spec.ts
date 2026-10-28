import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AlertController, provideIonicAngular } from '@ionic/angular';
import { Subject } from 'rxjs';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { PrivacyExceptionKind, type PrivacyException } from '../../../generated/models';
import { testUser } from '../../api/testing';
import { ChatStore } from '../../chats/chat-store';
import { Presence } from '../../presence/presence';
import { SessionStore } from '../../session/session-store';
import { PrivacyExceptions } from './privacy-exceptions';

describe('Privacy exceptions', () => {
  const row: PrivacyException = { user: { uid: 2, username: '好友', gender: 0 }, share: true };
  const account = signal({ ...testUser });
  let http: HttpTestingController;
  let alerts: { create: ReturnType<typeof vi.fn> };
  let chats: {
    invalidateReadReceiptPrivacy: ReturnType<typeof vi.fn>;
    publishPrivacyOverride: ReturnType<typeof vi.fn>;
    privacyOverrides$: Subject<{ kind: PrivacyExceptionKind }>;
  };
  const presence = { invalidateUsers: vi.fn() };
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
        provideHttpClient(),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: SessionStore, useValue: { user: account } },
        { provide: ChatStore, useValue: chats },
        { provide: Presence, useValue: presence },
        { provide: AlertController, useValue: alerts },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());
  function open(kind = PrivacyExceptionKind.presence) {
    const fixture = TestBed.createComponent(PrivacyExceptions);
    fixture.componentRef.setInput('kind', kind);
    fixture.detectChanges();
    return fixture;
  }
  async function loaded(kind = PrivacyExceptionKind.presence) {
    const fixture = open(kind);
    http.expectOne(`/_api/me/privacy-exceptions?kind=${kind}`).flush({ exceptions: [row] });
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('only shows empty after a successful read and preserves rows during refresh failure', async () => {
    const fixture = open();
    const component = fixture.componentInstance;
    http.expectOne('/_api/me/privacy-exceptions?kind=presence').flush({}, { status: 503, statusText: 'Unavailable' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('暂无例外');
    const retry = component['load']();
    http.expectOne('/_api/me/privacy-exceptions?kind=presence').flush({ exceptions: [row] });
    await retry;
    fixture.detectChanges();
    const avatar = fixture.nativeElement.querySelector('app-chat-avatar');
    const refresh = component['load']();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-chat-avatar')).toBe(avatar);
    http.expectOne('/_api/me/privacy-exceptions?kind=presence').flush({}, { status: 503, statusText: 'Unavailable' });
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
    for (const role of ['navigate', 'parent-dismissed', 'parent-removed']) {
      expect(await canDismiss(undefined, role)).toBe(true);
    }
    http.expectOne('/_api/friends/2/presence-settings').flush({ override: 'inherit' });
    await saving;
    expect(await canDismiss(undefined, 'backdrop')).toBe(true);
  });

  it.each([PrivacyExceptionKind.presence, PrivacyExceptionKind.readReceipts])(
    'saves and removes %s overrides without changing the global policy',
    async (kind) => {
      const component = (await loaded(kind)).componentInstance;
      const endpoint = kind === PrivacyExceptionKind.presence ? 'presence-settings' : 'read-receipt-settings';
      const saving = component['choose'](row.user, true);
      await vi.waitFor(() => expect(alerts.create).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const request = http.expectOne(`/_api/friends/2/${endpoint}`);
      expect(request.request.body).toEqual({ override: 'hide' });
      request.flush({ override: 'hide' });
      await saving;
      expect(component['rows']()).toEqual([{ ...row, share: false }]);
      expect(chats.publishPrivacyOverride).toHaveBeenCalledWith(kind, 2, false);
      const removal = component['remove'](row);
      const removeRequest = http.expectOne(`/_api/friends/2/${endpoint}`);
      expect(removeRequest.request.body).toEqual({ override: 'inherit' });
      removeRequest.flush({ override: 'inherit' });
      await removal;
      expect(component['rows']()).toEqual([]);
      http.expectNone(`/_api/me/${endpoint}`);
    },
  );

  it('retains an exception after a failed write and ignores an older list arriving after removal', async () => {
    const component = (await loaded()).componentInstance;
    const failure = component['remove'](row);
    http.expectOne('/_api/friends/2/presence-settings').flush({}, { status: 503, statusText: 'Unavailable' });
    await failure;
    expect(component['rows']()).toEqual([row]);
    expect(component['saveFailed']()).toBe(true);
    const refresh = component['load']();
    const old = http.expectOne('/_api/me/privacy-exceptions?kind=presence');
    const removal = component['remove'](row);
    http.expectOne('/_api/friends/2/presence-settings').flush({ override: 'inherit' });
    await removal;
    old.flush({ exceptions: [row] });
    await refresh;
    expect(component['rows']()).toEqual([]);
  });

  it('clears only after confirmation, keeps rows on failure and reloads after success', async () => {
    const component = (await loaded()).componentInstance;
    alerts.create.mockResolvedValueOnce({ present: async () => {}, onDidDismiss: async () => ({ role: 'cancel' }) });
    await component['clear']();
    http.expectNone((request) => request.method === 'DELETE');
    alerts.create.mockResolvedValue({ present: async () => {}, onDidDismiss: async () => ({ role: 'destructive' }) });
    const failed = component['clear']();
    await vi.waitFor(() => expect(alerts.create).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    http.expectOne('/_api/me/privacy-exceptions?kind=presence').flush({}, { status: 503, statusText: 'Unavailable' });
    await failed;
    expect(component['rows']()).toEqual([row]);
    const success = component['clear']();
    await vi.waitFor(() => expect(alerts.create).toHaveBeenCalledTimes(3));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    http.expectOne('/_api/me/privacy-exceptions?kind=presence').flush(null);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    http.expectOne('/_api/me/privacy-exceptions?kind=presence').flush({ exceptions: [] });
    await success;
    expect(component['rows']()).toEqual([]);
    expect(chats.publishPrivacyOverride).toHaveBeenCalledWith(PrivacyExceptionKind.presence);
  });

  it('loads friend choices in one request, filters them and excludes existing exceptions', async () => {
    const component = (await loaded()).componentInstance;
    const loading = component['loadFriends']();
    http.expectOne('/_api/friends').flush({
      friends: [
        { user: row.user, since: '' },
        { user: { ...row.user, uid: 3, username: '另一个' }, since: '' },
      ],
    });
    await loading;
    component['query'].set('另');
    expect(component['candidates']()?.map((user) => user.uid)).toEqual([3]);
    expect(component['existing']().has(2)).toBe(true);
  });

  it('uses scoped WS receipt invalidation instead of refreshing every DM after clearing exceptions', async () => {
    const component = (await loaded(PrivacyExceptionKind.readReceipts)).componentInstance;
    alerts.create.mockResolvedValue({ present: async () => {}, onDidDismiss: async () => ({ role: 'destructive' }) });
    const clearing = component['clear']();
    await vi.waitFor(() => http.expectOne('/_api/me/privacy-exceptions?kind=readReceipts').flush(null));
    await vi.waitFor(() => http.expectOne('/_api/me/privacy-exceptions?kind=readReceipts').flush({ exceptions: [] }));
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
    const old = http.expectOne('/_api/me/privacy-exceptions?kind=presence');
    account.set({ ...testUser, uid: 8 });
    fixture.detectChanges();
    expect(component['rows']()).toBeUndefined();
    http.expectOne('/_api/me/privacy-exceptions?kind=presence').flush({ exceptions: [] });
    old.flush({ exceptions: [row] });
    await refresh;
    await fixture.whenStable();
    expect(component['rows']()).toEqual([]);
  });
});
