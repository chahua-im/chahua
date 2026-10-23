import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { GroupKind, NotificationSettingMode, ServerWsMessageType, type ServerWsMessage } from '../../generated/models';
import { Connection, ResyncReason } from '../api/connection';
import { jsonInterceptor } from '../api/json.interceptor';
import { mockRealtime, testChat, testMessage, testUser, wireChat } from '../api/testing';
import { encodeId } from '../api/snowflake-id';
import { shouldNotify } from '../pwa/notification-policy';
import { SessionStore } from '../session/session-store';
import { ChatStore } from './chat-store';

describe('notification preferences', () => {
  let store: ChatStore;
  let session: SessionStore;
  let http: HttpTestingController;
  let events: Subject<ServerWsMessage>;
  let resync: Subject<ResyncReason>;
  const endpoint = `/_api/group/${wireChat.id}/notification-setting`;
  const defaultsUrl = '/_api/users/me/notification-settings';
  const snapshot = (muteOverride?: boolean) => ({
    chatId: testChat.id,
    kind: GroupKind.group,
    archived: false,
    mutedUntil: undefined,
    muteOverride,
    isMuted: muteOverride ?? true,
  });
  beforeEach(() => {
    events = new Subject();
    resync = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([jsonInterceptor])),
        provideHttpClientTesting(),
        provideChahuaBaseUrl('/_api'),
        { provide: Connection, useValue: mockRealtime({ events$: events, resync$: resync }) },
      ],
    });
    session = TestBed.inject(SessionStore);
    session.user.set(testUser);
    store = TestBed.inject(ChatStore);
    http = TestBed.inject(HttpTestingController);
    TestBed.tick();
    store.acceptChats([{ ...testChat, muteOverride: undefined }], store.snapshot());
  });
  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  it('uses group/DM defaults and changes loaded chats without per-chat HTTP requests', async () => {
    expect(store.isMuted(testChat.id)).toBe(true);
    const save = store.setNotificationDefault(GroupKind.group, false);
    expect(store.isMuted(testChat.id)).toBe(false);
    const req = http.expectOne(defaultsUrl);
    expect(req.request.body).toEqual({ muteGroupChatsByDefault: false });
    req.flush({ muteGroupChatsByDefault: false, muteDirectChatsByDefault: false });
    await save;
    expect(store.notificationDefaults()?.muteDirectChatsByDefault).toBe(false);
    events.next({
      type: ServerWsMessageType.notificationSettingsChanged,
      payload: { muteGroupChatsByDefault: true, muteDirectChatsByDefault: false },
    });
    expect(store.isMuted(testChat.id)).toBe(true);
    store.acceptChats([{ ...testChat, kind: GroupKind.dm, muteOverride: undefined }], store.snapshot());
    expect(store.isMuted(testChat.id)).toBe(false);
  });

  it('does not roll a newer remote default back when a local save fails', async () => {
    const save = store.setNotificationDefault(GroupKind.group, false);
    const rejected = expect(save).rejects.toBeDefined();
    events.next({
      type: ServerWsMessageType.notificationSettingsChanged,
      payload: { muteGroupChatsByDefault: false, muteDirectChatsByDefault: true },
    });
    http.expectOne(defaultsUrl).flush('failed', { status: 500, statusText: 'Failed' });
    await rejected;
    expect(store.notificationDefaults()).toEqual({ muteGroupChatsByDefault: false, muteDirectChatsByDefault: true });
  });

  it('rolls a failed default save back and preserves the other category', async () => {
    const save = store.setNotificationDefault(GroupKind.dm, true);
    const rejected = expect(save).rejects.toBeDefined();
    http.expectOne(defaultsUrl).flush('failed', { status: 500, statusText: 'Failed' });
    await rejected;
    expect(store.notificationDefaults()).toEqual({ muteGroupChatsByDefault: true, muteDirectChatsByDefault: false });
  });

  it('ignores stale reconnect defaults after a WS update and retains known values while loading', async () => {
    resync.next(ResyncReason.Connected);
    const read = http.expectOne(defaultsUrl);
    expect(store.notificationDefaults()?.muteGroupChatsByDefault).toBe(true);
    events.next({
      type: ServerWsMessageType.notificationSettingsChanged,
      payload: { muteGroupChatsByDefault: false, muteDirectChatsByDefault: false },
    });
    read.flush({ muteGroupChatsByDefault: true, muteDirectChatsByDefault: true });
    await Promise.resolve();
    expect(store.notificationDefaults()?.muteGroupChatsByDefault).toBe(false);
    resync.next(ResyncReason.Foreground);
    http.expectNone(defaultsUrl);
  });

  it('defers reconnect calibration until a pending default write settles', async () => {
    const save = store.setNotificationDefault(GroupKind.group, false);
    const write = http.expectOne(defaultsUrl);
    resync.next(ResyncReason.Connected);
    http.expectNone(defaultsUrl);
    expect(store.isMuted(testChat.id)).toBe(false);
    write.flush({ muteGroupChatsByDefault: false, muteDirectChatsByDefault: false });
    await save;
    http.expectOne(defaultsUrl).flush({ muteGroupChatsByDefault: false, muteDirectChatsByDefault: false });
    await Promise.resolve();
    expect(store.isMuted(testChat.id)).toBe(false);
  });

  it('reruns a reconnect read if another reconnect occurs while it is pending', async () => {
    resync.next(ResyncReason.Connected);
    const first = http.expectOne(defaultsUrl);
    resync.next(ResyncReason.Connected);
    first.flush({ muteGroupChatsByDefault: false, muteDirectChatsByDefault: false });
    await Promise.resolve();
    expect(store.notificationDefaults()?.muteGroupChatsByDefault).toBe(true);
    http.expectOne(defaultsUrl).flush({ muteGroupChatsByDefault: true, muteDirectChatsByDefault: true });
    await Promise.resolve();
    expect(store.notificationDefaults()?.muteDirectChatsByDefault).toBe(true);
  });

  it('keeps preferences on archive-only events and applies explicit clears', () => {
    events.next({ type: ServerWsMessageType.chatNotificationSettingChanged, payload: snapshot(false) });
    events.next({
      type: ServerWsMessageType.chatArchiveStateChanged,
      payload: { chatId: testChat.id, archived: true },
    });
    expect(store.isMuted(testChat.id)).toBe(false);
    expect(store.chatState(testChat.id)?.muteOverride).toBe(false);
    events.next({
      type: ServerWsMessageType.chatNotificationSettingChanged,
      payload: { ...snapshot(), archived: true },
    });
    expect(store.isMuted(testChat.id)).toBe(true);
  });

  it('keeps a newer preference through late detail/list responses and a failed older write', async () => {
    const version = store.snapshot();
    const details = store.ensureDetails(testChat.id);
    const detail = http.expectOne(`/_api/group/${wireChat.id}`);
    const saving = store.setNotificationSetting(testChat.id, { mode: NotificationSettingMode.alwaysMuted });
    const rejected = expect(saving).rejects.toBeDefined();
    events.next({ type: ServerWsMessageType.chatNotificationSettingChanged, payload: snapshot(false) });
    detail.flush({ ...wireChat, muteOverride: true });
    await details;
    store.acceptChats([{ ...testChat, muteOverride: true }], version);
    http.expectOne(endpoint).flush('failed', { status: 500, statusText: 'Failed' });
    await rejected;
    expect(store.isMuted(testChat.id)).toBe(false);
  });

  it('rolls archive back independently of a concurrent successful notification change', async () => {
    const archive = store.setArchived(testChat.id, true);
    const rejected = expect(archive).rejects.toBeDefined();
    const mute = store.setNotificationSetting(testChat.id, { mode: NotificationSettingMode.alwaysUnmuted });
    http.expectOne(endpoint).flush({ ...snapshot(false), chatId: wireChat.id, archived: true });
    await mute;
    http.expectOne(`/_api/chats/${wireChat.id}/archive`).flush('failed', { status: 500, statusText: 'Failed' });
    await rejected;
    expect(store.chatState(testChat.id)?.archived).toBe(false);
    expect(store.isMuted(testChat.id)).toBe(false);
  });

  describe.each(['details', 'list', 'exceptions'] as const)('%s snapshots during saves', (source) => {
    it.each([
      { readFirst: true, succeeds: true },
      { readFirst: false, succeeds: true },
      { readFirst: true, succeeds: false },
      { readFirst: false, succeeds: false },
    ])('preserves the write and its rollback ($readFirst, $succeeds)', async ({ readFirst, succeeds }) => {
      const saving = store.setNotificationSetting(testChat.id, { mode: NotificationSettingMode.alwaysUnmuted });
      const completed = succeeds ? saving : expect(saving).rejects.toBeDefined();
      const write = http.expectOne(endpoint);
      const version = store.snapshot();
      const details = source === 'details' ? store.ensureDetails(testChat.id) : undefined;
      const detail = source === 'details' ? http.expectOne(`/_api/group/${wireChat.id}`) : undefined;
      const acceptRead = async () => {
        if (detail) {
          detail.flush({ ...wireChat, muteOverride: null, mutedUntil: null });
          await details;
        } else if (source === 'list') {
          store.acceptChats([{ ...testChat, muteOverride: undefined }], version);
        } else {
          store.acceptNotificationExceptions([{ ...snapshot(true), name: 'group' }], version);
        }
      };
      if (readFirst) {
        await acceptRead();
        expect(store.isMuted(testChat.id)).toBe(false);
      }
      if (succeeds) write.flush({ ...snapshot(false), chatId: wireChat.id });
      else write.flush('failed', { status: 500, statusText: 'Failed' });
      await completed;
      if (!readFirst) await acceptRead();
      expect(store.chatState(testChat.id)?.muteOverride).toBe(succeeds ? false : undefined);
      expect(store.isMuted(testChat.id)).toBe(!succeeds);
      // Once the write settles, genuinely newer reads are accepted again.
      store.acceptChats([{ ...testChat, muteOverride: true }], store.snapshot());
      expect(store.isMuted(testChat.id)).toBe(true);
    });
  });

  it.each([true, false])(
    'protects an archive 204 confirmation from mid-save reads (readFirst=%s)',
    async (readFirst) => {
      const saving = store.setArchived(testChat.id, true);
      const version = store.snapshot();
      const acceptRead = () => store.acceptChats([{ ...testChat, archived: false }], version);
      if (readFirst) {
        acceptRead();
        expect(store.chatState(testChat.id)?.archived).toBe(true);
      }
      http.expectOne(`/_api/chats/${wireChat.id}/archive`).flush(null);
      await saving;
      if (!readFirst) acceptRead();
      expect(store.chatState(testChat.id)?.archived).toBe(true);
    },
  );

  it('keeps a newer remote preference while an older local save and read finish', async () => {
    const saving = store.setNotificationSetting(testChat.id, { mode: NotificationSettingMode.alwaysUnmuted });
    const version = store.snapshot();
    events.next({ type: ServerWsMessageType.chatNotificationSettingChanged, payload: snapshot(true) });
    store.acceptChats([{ ...testChat, muteOverride: undefined }], version);
    http.expectOne(endpoint).flush({ ...snapshot(false), chatId: wireChat.id });
    await saving;
    expect(store.chatState(testChat.id)?.muteOverride).toBe(true);
  });

  it('loads archive state with details before deciding notifications for a chat outside loaded lists', async () => {
    const chatId = encodeId('9007199254741999');
    const load = store.ensureDetails(chatId);
    http.expectOne('/_api/group/9007199254741999').flush({
      ...wireChat,
      id: '9007199254741999',
      kind: GroupKind.dm,
      archived: true,
      mutedUntil: null,
      muteOverride: null,
      isMuted: false,
    });
    await load;
    const message = { ...testMessage, chatId, sender: { uid: 2, name: 'peer', gender: 0 } };
    const notify = () =>
      shouldNotify(
        message,
        testUser.uid,
        { ...store.get(chatId), ...store.chatState(chatId) },
        undefined,
        Date.now(),
        session.user(),
      );
    expect(store.isMuted(chatId)).toBe(false);
    expect(notify()).toBe(false);
    const unarchive = store.setArchived(chatId, false);
    http.expectOne('/_api/chats/9007199254741999/archive').flush(null);
    await unarchive;
    expect(notify()).toBe(true);
  });

  it('merges and clears a large exception batch while preserving archive and newer individual writes', () => {
    const rows = Array.from({ length: 5000 }, (_, index) => ({
      ...snapshot(false),
      chatId: encodeId(String(10000 + index)),
      archived: index % 2 === 0,
      name: `chat ${index}`,
    }));
    store.acceptNotificationExceptions(rows, store.snapshot());
    const stale = store.snapshot();
    events.next({
      type: ServerWsMessageType.notificationExceptionsCleared,
      payload: { kind: GroupKind.group, chatIds: rows.map((row) => row.chatId) },
    });
    events.next({
      type: ServerWsMessageType.chatNotificationSettingChanged,
      payload: { ...rows[0], muteOverride: false },
    });
    store.acceptNotificationExceptions(rows, stale);
    for (const [index, row] of rows.entries()) {
      expect(store.chatState(row.chatId)?.archived).toBe(row.archived);
      expect(store.chatState(row.chatId)?.muteOverride).toBe(index === 0 ? false : undefined);
      expect(store.isMuted(row.chatId)).toBe(index !== 0);
    }
  });

  it('temporary mute preserves the exception and restores it at expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T00:00:00Z'));
    events.next({ type: ServerWsMessageType.chatNotificationSettingChanged, payload: snapshot(false) });
    const save = store.setNotificationSetting(testChat.id, {
      mode: NotificationSettingMode.temporarilyMuted,
      durationSeconds: 1,
    });
    expect(store.isMuted(testChat.id)).toBe(true);
    http.expectOne(endpoint).flush({ ...snapshot(false), chatId: wireChat.id, mutedUntil: '2026-10-23T00:00:01Z' });
    await save;
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(1001);
    expect(store.isMuted(testChat.id)).toBe(false);
    expect(store.chatState(testChat.id)?.muteOverride).toBe(false);
    expect(store.chat(testChat.id).unreadCount).toBe(testChat.unreadCount);
  });

  it('new unmute preserves archive and restoring default clears temporary and explicit mute', async () => {
    store.acceptChats(
      [{ ...testChat, archived: true, mutedUntil: '9999-12-31T23:59:59Z', muteOverride: true }],
      store.snapshot(),
    );
    const unmute = store.setMuted(testChat.id, false);
    http.expectOne(endpoint).flush({ ...snapshot(false), chatId: wireChat.id, archived: true });
    await unmute;
    expect(store.chatState(testChat.id)?.archived).toBe(true);
    const reset = store.setNotificationSetting(testChat.id, { mode: NotificationSettingMode.inherit });
    http
      .expectOne(endpoint)
      .flush({ ...snapshot(), chatId: wireChat.id, archived: true, mutedUntil: null, muteOverride: null });
    await reset;
    expect(store.isMuted(testChat.id)).toBe(true);
    expect(store.chatState(testChat.id)?.muteOverride).toBeNull();
    expect(store.chatState(testChat.id)?.mutedUntil).toBeNull();
  });

  it('clears private preferences on account change and rejects the former account response', async () => {
    const save = store.setNotificationDefault(GroupKind.dm, true);
    session.user.set({ ...testUser, uid: 2 });
    TestBed.tick();
    expect(store.chatState(testChat.id)).toBeUndefined();
    http.expectOne(defaultsUrl).flush({ muteGroupChatsByDefault: false, muteDirectChatsByDefault: true });
    await save;
    expect(store.notificationDefaults()?.muteDirectChatsByDefault).toBe(false);
  });
  it('clears a category with one request, preserves archive and ignores older list snapshots', async () => {
    store.acceptChats([{ ...testChat, archived: true, muteOverride: false }], store.snapshot());
    const old = store.snapshot();
    const clear = store.clearNotificationExceptions(GroupKind.group);
    store.acceptChats([{ ...testChat, archived: true, muteOverride: false }], store.snapshot()); // in-flight old read
    const req = http.expectOne('/_api/users/me/notification-exceptions?kind=group');
    expect(req.request.method).toBe('DELETE');
    req.flush({ kind: 'group', chatIds: [wireChat.id] });
    await clear;
    expect(store.chatState(testChat.id)?.archived).toBe(true);
    expect(store.isMuted(testChat.id)).toBe(true);
    store.acceptChats([{ ...testChat, muteOverride: false }], old);
    expect(store.isMuted(testChat.id)).toBe(true);
  });

  it('applies a bulk WS result once and keeps a newer exception when HTTP finishes later', async () => {
    const changes = vi.fn();
    store.preferenceChanges$.subscribe(changes);
    const clear = store.clearNotificationExceptions(GroupKind.group);
    events.next({
      type: ServerWsMessageType.notificationExceptionsCleared,
      payload: { kind: GroupKind.group, chatIds: [testChat.id] },
    });
    events.next({ type: ServerWsMessageType.chatNotificationSettingChanged, payload: snapshot(false) });
    http
      .expectOne('/_api/users/me/notification-exceptions?kind=group')
      .flush({ kind: 'group', chatIds: [wireChat.id] });
    await clear;
    expect(store.isMuted(testChat.id)).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('leaves preferences intact on bulk failure and rejects a response from the previous account', async () => {
    store.acceptChats([{ ...testChat, muteOverride: false }], store.snapshot());
    const failed = store.clearNotificationExceptions(GroupKind.group);
    const rejected = expect(failed).rejects.toBeDefined();
    http
      .expectOne('/_api/users/me/notification-exceptions?kind=group')
      .flush('failed', { status: 500, statusText: 'Failed' });
    await rejected;
    expect(store.isMuted(testChat.id)).toBe(false);
    const clear = store.clearNotificationExceptions(GroupKind.group);
    session.user.set({ ...testUser, uid: 2 });
    TestBed.tick();
    store.acceptChats([{ ...testChat, muteOverride: false }], store.snapshot());
    http
      .expectOne('/_api/users/me/notification-exceptions?kind=group')
      .flush({ kind: 'group', chatIds: [wireChat.id] });
    await clear;
    expect(store.isMuted(testChat.id)).toBe(false);
  });
});
