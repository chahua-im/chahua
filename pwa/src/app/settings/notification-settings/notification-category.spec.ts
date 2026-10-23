import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ToggleCustomEvent } from '@ionic/core';
import { vi } from 'vitest';
import { Subject } from 'rxjs';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { GroupKind, ServerWsMessageType, type ServerWsMessage } from '../../../generated/models';
import { Connection } from '../../api/connection';
import { jsonInterceptor } from '../../api/json.interceptor';
import { decodeId, encodeId } from '../../api/snowflake-id';
import { mockRealtime, testUser } from '../../api/testing';
import { SessionStore } from '../../session/session-store';
import { NotificationCategory } from './notification-category';

const row = (id: number, archived = false) => ({
  chatId: String(id),
  kind: GroupKind.group,
  name: `群 ${id}`,
  archived,
  muteOverride: false,
  mutedUntil: null,
  isMuted: false,
});
const base = '/_api/users/me/notification-exceptions?kind=group&limit=20';
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  TestBed.tick();
};

describe('notification exceptions', () => {
  let fixture: ComponentFixture<NotificationCategory>;
  let component: NotificationCategory;
  let http: HttpTestingController;
  let events: Subject<ServerWsMessage>;
  beforeEach(() => {
    events = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: Connection, useValue: mockRealtime({ events$: events }) },
      ],
    });
    TestBed.inject(SessionStore).user.set(testUser);
    fixture = TestBed.createComponent(NotificationCategory);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('kind', GroupKind.group);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });
  afterEach(() => {
    fixture.destroy();
    http.verify();
  });

  it('reads full server count, archived exceptions and Snowflake cursors without fetching chats', async () => {
    http
      .expectOne(base)
      .flush({ exceptions: [row(9007199254740990, true)], nextCursor: '9007199254740990', totalCount: 47 });
    await settle();
    expect(component['page']()?.totalCount).toBe(47);
    expect(component['page']()?.exceptions[0].archived).toBe(true);
    expect(decodeId(component['page']()!.nextCursor!)).toBe('9007199254740990');
    const more = component['loadMore']();
    const req = http.expectOne('/_api/users/me/notification-exceptions?kind=group&limit=20&after=9007199254740990');
    req.flush({ exceptions: [row(9007199254740991)], totalCount: 47, nextCursor: null });
    await more;
    expect(component['page']()?.exceptions.length).toBe(2);
    http.expectNone('/_api/chats?limit=50');
  });

  it('keeps rows through refresh and failures and retries without showing a false empty list', async () => {
    http.expectOne(base).flush({ exceptions: [row(1)], totalCount: 1 });
    await settle();
    const refresh = component.refresh();
    expect(component['page']()?.exceptions.length).toBe(1);
    http.expectOne(base).flush('failed', { status: 500, statusText: 'Failed' });
    await refresh;
    expect(component['error']()).toBe(true);
    expect(component['page']()?.totalCount).toBe(1);
    const retry = component.refresh();
    http.expectOne(base).flush({ exceptions: [], totalCount: 0 });
    await retry;
    expect(component['page']()?.totalCount).toBe(0);
  });

  it('rejects a stale page after a preference event and refreshes the complete count', async () => {
    const old = http.expectOne(base);
    events.next({
      type: ServerWsMessageType.chatNotificationSettingChanged,
      payload: { ...row(1), chatId: encodeId('1'), mutedUntil: undefined, muteOverride: undefined },
    });
    old.flush({ exceptions: [row(1)], totalCount: 1 });
    await settle();
    expect(component['page']()).toBeUndefined();
    http.expectOne(base).flush({ exceptions: [], totalCount: 0 });
    await settle();
    expect(component['page']()?.totalCount).toBe(0);
  });

  it('applies account default events without clearing rows or fetching exceptions again', async () => {
    http.expectOne(base).flush({ exceptions: [row(1)], totalCount: 1 });
    await settle();
    events.next({
      type: ServerWsMessageType.notificationSettingsChanged,
      payload: { muteGroupChatsByDefault: false, muteDirectChatsByDefault: false },
    });
    await settle();
    expect(component['defaultMuted']()).toBe(false);
    expect(component['page']()?.totalCount).toBe(1);
    http.expectNone(base);
  });

  it('does not start another page request after logout during a refresh', async () => {
    const old = http.expectOne(base);
    TestBed.inject(SessionStore).user.set(undefined);
    TestBed.tick();
    old.flush({ exceptions: [row(1)], totalCount: 1 });
    await settle();
    expect(component['page']()).toBeUndefined();
    http.expectNone(base);
  });

  it('clears the previous account list immediately and discards its in-flight page', async () => {
    const old = http.expectOne(base);
    TestBed.inject(SessionStore).user.set({ ...testUser, uid: 2 });
    TestBed.tick();
    expect(component['page']()).toBeUndefined();
    old.flush({ exceptions: [row(1)], totalCount: 1 });
    await settle();
    http.expectOne(base).flush({ exceptions: [row(2)], totalCount: 1 });
    await settle();
    expect(component['page']()?.exceptions[0].name).toBe('群 2');
  });
  it('uses a positive notification toggle and preserves exceptions when changing the default', async () => {
    http.expectOne(base).flush({ exceptions: [row(1)], totalCount: 1 });
    await settle();
    const event = { detail: { checked: true }, target: { checked: true } } as unknown as ToggleCustomEvent;
    const save = component['setDefault'](event);
    const request = http.expectOne('/_api/users/me/notification-settings');
    expect(request.request.body).toEqual({ muteGroupChatsByDefault: false });
    request.flush({ muteGroupChatsByDefault: false, muteDirectChatsByDefault: false });
    await save;
    expect(event.target.checked).toBe(true);
    expect(component['page']()?.totalCount).toBe(1);
    http.expectNone(base);
  });

  it('removes an exception using inherit without changing archive', async () => {
    http.expectOne(base).flush({ exceptions: [row(1, true)], totalCount: 1 });
    await settle();
    const remove = component['edit'](encodeId('1'), true);
    const req = http.expectOne('/_api/group/1/notification-setting');
    expect(req.request.body).toEqual({ mode: 'inherit' });
    req.flush({ ...row(1, true), muteOverride: null, isMuted: true });
    await remove;
    http.expectOne(base).flush({ exceptions: [], totalCount: 0 });
    await settle();
    expect(component['page']()?.totalCount).toBe(0);
  });

  it('requires confirmation before deleting all exceptions and refreshes the server total', async () => {
    http.expectOne(base).flush({ exceptions: [row(1, true)], totalCount: 47 });
    await settle();
    const alert = component['clearAlert']();
    vi.spyOn(alert, 'present').mockResolvedValue();
    const dismissed = vi.spyOn(alert, 'onDidDismiss').mockResolvedValue({ role: 'cancel' });
    await component['clearAll']();
    http.expectNone('/_api/users/me/notification-exceptions?kind=group');
    dismissed.mockResolvedValue({ role: 'confirm' });
    const clear = component['clearAll']();
    await settle();
    const req = http.expectOne('/_api/users/me/notification-exceptions?kind=group');
    expect(req.request.method).toBe('DELETE');
    req.flush({ kind: 'group', chatIds: ['1'] });
    await clear;
    http.expectOne(base).flush({ exceptions: [], totalCount: 0 });
    await settle();
    expect(component['page']()?.totalCount).toBe(0);
  });
});
