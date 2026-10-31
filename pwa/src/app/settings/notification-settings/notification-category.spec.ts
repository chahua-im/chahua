import { signal, type WritableSignal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ToggleCustomEvent } from '@ionic/core';
import { Subject } from 'rxjs';
import type { Mock } from 'vitest';
import { GroupKind, NotificationSettingMode } from '../../../generated/models';
import { RpcTestPeer, provideRpcTesting } from '../../api/rpc-testing';
import { Connection, ResyncReason } from '../../api/connection';
import { encodeId } from '../../api/snowflake-id';

import { ChatStore } from '../../chats/chat-store';
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

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  TestBed.tick();
};

describe('notification exceptions', () => {
  const account = signal<{ uid: number } | undefined>({ uid: 1 });
  let fixture: ComponentFixture<NotificationCategory>;
  let component: NotificationCategory;
  let peer: RpcTestPeer;
  let store: {
    notificationDefaults: WritableSignal<
      { muteDirectChatsByDefault: boolean; muteGroupChatsByDefault: boolean } | undefined
    >;
    defaultsSaving: WritableSignal<boolean>;
    snapshot: Mock;
    acceptNotificationExceptions: Mock;
    preferenceChanges$: Subject<GroupKind>;
    setNotificationDefault: Mock;
    setNotificationSetting: Mock;
    clearNotificationExceptions: Mock;
  };

  beforeEach(() => {
    account.set({ uid: 1 });
    const preferenceChanges$ = new Subject<GroupKind>();
    const notificationDefaults = signal({ muteDirectChatsByDefault: false, muteGroupChatsByDefault: true });
    store = {
      notificationDefaults,
      defaultsSaving: signal(false),
      snapshot: vi.fn(() => 1),
      acceptNotificationExceptions: vi.fn(),
      preferenceChanges$,
      setNotificationDefault: vi.fn(async (kind: GroupKind, muted: boolean) => {
        notificationDefaults.update((defaults) => ({
          ...defaults,
          [kind === GroupKind.dm ? 'muteDirectChatsByDefault' : 'muteGroupChatsByDefault']: muted,
        }));
      }),
      setNotificationSetting: vi.fn(async () => preferenceChanges$.next(GroupKind.group)),
      clearNotificationExceptions: vi.fn(async () => preferenceChanges$.next(GroupKind.group)),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideRpcTesting(),
        { provide: ChatStore, useValue: store },
        { provide: SessionStore, useValue: { user: account } },
        { provide: Connection, useValue: { resync$: new Subject<ResyncReason>(), connected: () => true } },
      ],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
    fixture = TestBed.createComponent(NotificationCategory);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('kind', GroupKind.group);
    fixture.detectChanges();
  });

  afterEach(() => {
    try {
      peer.verify();
    } finally {
      try {
        fixture?.destroy();
      } finally {
        TestBed.resetTestingModule();
      }
    }
  });

  it('reads full server count, archived exceptions and Snowflake cursors without fetching chat pages', async () => {
    peer.expect('users.listNotificationExceptions', { kind: GroupKind.group, limit: 20 }).flush({
      exceptions: [row(9007199254740990, true)],
      nextCursor: '9007199254740990',
      totalCount: 47,
    });
    await settle();
    expect(component['page']()?.totalCount).toBe(47);
    expect(component['page']()?.exceptions[0].archived).toBe(true);
    expect(component['page']()?.nextCursor).toBe(encodeId('9007199254740990'));
    const more = component['loadMore']();
    peer
      .expect(
        'users.listNotificationExceptions',
        (params) => params['after'] === '9007199254740990' && params['limit'] === 20,
      )
      .flush({ exceptions: [row(9007199254740991)], totalCount: 47, nextCursor: null });
    await more;
    expect(component['page']()?.exceptions.length).toBe(2);
  });

  it('keeps rows through refresh and failures and retries without showing a false empty list', async () => {
    peer.expect('users.listNotificationExceptions', { kind: GroupKind.group, limit: 20 }).flush({
      exceptions: [row(1)],
      totalCount: 1,
    });
    await settle();
    const refresh = component.refresh();
    expect(component['page']()?.exceptions.length).toBe(1);
    peer.expect('users.listNotificationExceptions', { kind: GroupKind.group, limit: 20 }).error(1500);
    await refresh;
    expect(component['error']()).toBe(true);
    expect(component['page']()?.totalCount).toBe(1);
    const retry = component.refresh();
    peer.expect('users.listNotificationExceptions', { kind: GroupKind.group, limit: 20 }).flush({
      exceptions: [],
      totalCount: 0,
    });
    await retry;
    expect(component['page']()?.totalCount).toBe(0);
  });

  it('rejects a stale page after a preference event and refreshes the complete count', async () => {
    const old = peer.expect('users.listNotificationExceptions', { kind: GroupKind.group, limit: 20 });
    store.preferenceChanges$.next(GroupKind.group);
    old.flush({ exceptions: [row(1)], totalCount: 1 });
    await settle();
    expect(component['page']()).toBeUndefined();
    peer.expect('users.listNotificationExceptions', { kind: GroupKind.group, limit: 20 }).flush({
      exceptions: [],
      totalCount: 0,
    });
    await settle();
    expect(component['page']()?.totalCount).toBe(0);
  });

  it('applies notification defaults without clearing rows or fetching exceptions again', async () => {
    peer.expect('users.listNotificationExceptions', { kind: GroupKind.group, limit: 20 }).flush({
      exceptions: [row(1)],
      totalCount: 1,
    });
    await settle();
    store.notificationDefaults.set({ muteGroupChatsByDefault: false, muteDirectChatsByDefault: false });
    fixture.detectChanges();
    expect(component['defaultMuted']()).toBe(false);
    expect(component['page']()?.totalCount).toBe(1);
    peer.expectNone('users.listNotificationExceptions');
  });

  it('does not start another page request after logout during a refresh', async () => {
    const old = peer.expect('users.listNotificationExceptions', { kind: GroupKind.group, limit: 20 });
    account.set(undefined);
    TestBed.tick();
    old.flush({ exceptions: [row(1)], totalCount: 1 });
    await settle();
    expect(component['page']()).toBeUndefined();
    peer.expectNone('users.listNotificationExceptions');
  });

  it('clears the previous account list immediately and discards its in-flight page', async () => {
    const old = peer.expect('users.listNotificationExceptions', { kind: GroupKind.group, limit: 20 });
    account.set({ uid: 2 });
    TestBed.tick();
    expect(component['page']()).toBeUndefined();
    old.flush({ exceptions: [row(1)], totalCount: 1 });
    await settle();
    peer.expect('users.listNotificationExceptions', { kind: GroupKind.group, limit: 20 }).flush({
      exceptions: [row(2)],
      totalCount: 1,
    });
    await settle();
    expect(component['page']()?.exceptions[0].name).toBe('群 2');
  });

  it('uses a positive notification toggle and preserves exceptions when changing the default', async () => {
    peer.expect('users.listNotificationExceptions', { kind: GroupKind.group, limit: 20 }).flush({
      exceptions: [row(1)],
      totalCount: 1,
    });
    await settle();
    const event = { detail: { checked: true }, target: { checked: true } } as unknown as ToggleCustomEvent;
    await component['setDefault'](event);
    expect(store.setNotificationDefault).toHaveBeenCalledWith(GroupKind.group, false);
    expect(event.target.checked).toBe(true);
    expect(component['page']()?.totalCount).toBe(1);
    peer.expectNone('users.listNotificationExceptions');
  });

  it('removes an exception using inherit without changing archive', async () => {
    peer.expect('users.listNotificationExceptions', { kind: GroupKind.group, limit: 20 }).flush({
      exceptions: [row(1, true)],
      totalCount: 1,
    });
    await settle();
    const remove = component['edit'](component['page']()!.exceptions[0].chatId, true);
    await remove;
    expect(store.setNotificationSetting).toHaveBeenCalledWith(component['page']()!.exceptions[0].chatId, {
      mode: NotificationSettingMode.inherit,
    });
    peer.expect('users.listNotificationExceptions', { kind: GroupKind.group, limit: 20 }).flush({
      exceptions: [],
      totalCount: 0,
    });
    await settle();
    expect(component['page']()?.totalCount).toBe(0);
  });

  it('requires confirmation before deleting all exceptions and refreshes the server total', async () => {
    peer.expect('users.listNotificationExceptions', { kind: GroupKind.group, limit: 20 }).flush({
      exceptions: [row(1, true)],
      totalCount: 47,
    });
    await settle();
    const alert = component['clearAlert']();
    vi.spyOn(alert, 'present').mockResolvedValue();
    const dismissed = vi.spyOn(alert, 'onDidDismiss').mockResolvedValue({ role: 'cancel' });
    await component['clearAll']();
    expect(store.clearNotificationExceptions).not.toHaveBeenCalled();
    dismissed.mockResolvedValue({ role: 'confirm' });
    const clear = component['clearAll']();
    await clear;
    expect(store.clearNotificationExceptions).toHaveBeenCalledWith(GroupKind.group);
    peer.expect('users.listNotificationExceptions', { kind: GroupKind.group, limit: 20 }).flush({
      exceptions: [],
      totalCount: 0,
    });
    await settle();
    expect(component['page']()?.totalCount).toBe(0);
  });
});
