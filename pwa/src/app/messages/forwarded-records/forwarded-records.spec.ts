import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { IonRouterOutlet, NavController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { provideChahuaBaseUrl } from '../../../generated/endpoints/chahua.base-url';
import { ServerWsMessageType, type ServerWsMessage } from '../../../generated/models';
import { Connection, ResyncReason } from '../../api/connection';
import { RpcErrorCode } from '../../api/rpc-error';
import { provideRpcTesting, RpcTestPeer } from '../../api/rpc-testing';
import { mockRealtime, wireChat, wireMessage, testUser, testChat, testMessage } from '../../api/testing';
import { ChatChangeKind, ChatStore } from '../../chats/chat-store';
import { Preferences } from '../../settings/preferences';
import { SessionStore } from '../../session/session-store';
import { ForwardedRecords } from './forwarded-records';

const record = {
  originalMessageId: wireMessage.id,
  originalChatId: wireChat.id,
  originalCreatedAt: wireMessage.createdAt,
  message: 'captured content',
  messageType: 'text',
  sender: wireMessage.sender,
  attachments: [],
};

describe('ForwardedRecords', () => {
  let events: Subject<ServerWsMessage>;
  let resync: Subject<ResyncReason>;
  let changes: Subject<{ kind: ChatChangeKind; chatId: typeof testChat.id; threadId?: typeof testChat.id }>;
  const release = vi.fn();
  let peer: RpcTestPeer | undefined;
  const watchReadStates = vi.fn(() => release);

  beforeEach(() => {
    events = new Subject();
    resync = new Subject();
    changes = new Subject();
    release.mockClear();
    watchReadStates.mockClear();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    TestBed.configureTestingModule({
      providers: [
        provideChahuaBaseUrl('/_api'),
        provideRpcTesting(),
        { provide: Preferences, useValue: { showAllAvatars: signal(false), showDmDetails: signal(false) } },
        { provide: Connection, useValue: mockRealtime({ events$: events, resync$: resync }) },
        { provide: ChatStore, useValue: { changes$: changes, watchReadStates } },
        { provide: IonRouterOutlet, useValue: { canGoBack: vi.fn(() => true), pop: vi.fn() } },
      ],
    });
  });

  afterEach(() => {
    try {
      peer?.verify();
    } finally {
      peer = undefined;
      TestBed.resetTestingModule();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  function create(inputs: Record<string, string>) {
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
    TestBed.inject(SessionStore).user.set(testUser);
    const fixture = TestBed.createComponent(ForwardedRecords);
    for (const [key, value] of Object.entries(inputs)) fixture.componentRef.setInput(key, value);
    fixture.detectChanges();
    return { fixture, peer };
  }

  it.each([
    [
      'chat root',
      { id: wireChat.id, messageId: wireMessage.id },
      'messages.listForwardedMessages',
      { chatId: wireChat.id, messageId: wireMessage.id },
    ],
    [
      'chat child',
      { id: wireChat.id, messageId: wireMessage.id, bundleId: '456' },
      'messages.listForwardedBundleMessages',
      { chatId: wireChat.id, messageId: wireMessage.id, bundleId: '456' },
    ],
    ['saved root', { savedId: '123' }, 'savedMessages.listForwardedMessages', { savedMessageId: '123' }],
    [
      'saved child',
      { savedId: '123', bundleId: '456' },
      'savedMessages.listForwardedBundleMessages',
      { savedMessageId: '123', bundleId: '456' },
    ],
  ])('reads %s from its authorized RPC source', async (_name, inputs, method, params) => {
    const { fixture, peer } = create(inputs);
    peer.expect(method, params).flush({ total: 1, messages: [record] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('captured content');
  });

  it('uses browser history and an authorized fallback', async () => {
    const { fixture, peer } = create({ id: wireChat.id, messageId: wireMessage.id });
    peer
      .expect('messages.listForwardedMessages', { chatId: wireChat.id, messageId: wireMessage.id })
      .flush({ total: 1, messages: [record] });
    await fixture.whenStable();
    fixture.detectChanges();
    const outlet = TestBed.inject(IonRouterOutlet);
    const back = vi.spyOn(TestBed.inject(Location), 'back').mockImplementation(() => {});
    const navigate = vi.spyOn(TestBed.inject(NavController), 'navigateBack').mockResolvedValue(true);
    (fixture.nativeElement.querySelector('ion-header ion-buttons > *') as HTMLElement).click();
    expect(back).toHaveBeenCalledOnce();
    vi.mocked(outlet.canGoBack).mockReturnValue(false);
    fixture.componentInstance['back']();
    expect(navigate).toHaveBeenCalledWith(`/chats/chat/${wireChat.id}#msg=${wireMessage.id}`, { replaceUrl: true });
    peer.verify();
  });

  it('ignores a late response after the authorized record scope changes', async () => {
    const { fixture, peer } = create({ id: wireChat.id, messageId: wireMessage.id });
    const root = peer.expect('messages.listForwardedMessages', { chatId: wireChat.id, messageId: wireMessage.id });
    fixture.componentRef.setInput('bundleId', '103');
    fixture.detectChanges();
    peer
      .expect('messages.listForwardedBundleMessages', {
        chatId: wireChat.id,
        messageId: wireMessage.id,
        bundleId: '103',
      })
      .flush({ total: 1, messages: [{ ...record, message: 'child content' }] });
    await fixture.whenStable();
    fixture.detectChanges();
    root.flush({ total: 1, messages: [record] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('child content');
    expect(fixture.nativeElement.textContent).not.toContain('captured content');
    peer.verify();
  });

  it.each([
    [
      'message deletion',
      () => events.next({ type: ServerWsMessageType.messageDeleted, payload: { ...testMessage, isDeleted: true } }),
    ],
    [
      'bulk deletion',
      () =>
        events.next({
          type: ServerWsMessageType.messagesBulkDeleted,
          payload: { chatId: testChat.id, messageIds: [testMessage.id] },
        }),
    ],
    ['membership revocation', () => changes.next({ kind: ChatChangeKind.Removed, chatId: testChat.id })],
  ])('clears records after %s and cannot restore them from a late response', async (_name, revoke) => {
    const { fixture, peer } = create({ id: wireChat.id, messageId: wireMessage.id });
    peer
      .expect('messages.listForwardedMessages', { chatId: wireChat.id, messageId: wireMessage.id })
      .flush({ total: 1, messages: [record] });
    await fixture.whenStable();
    fixture.detectChanges();
    resync.next(ResyncReason.Connected);
    const refresh = peer.expect('messages.listForwardedMessages', { chatId: wireChat.id, messageId: wireMessage.id });
    revoke();
    expect(fixture.componentInstance['unavailable']()).toBe(true);
    refresh.flush({ total: 1, messages: [record] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance['data']()).toBeUndefined();
    peer.verify();
  });

  it('retains known records for transport failure but clears confirmed RPC permission loss', async () => {
    const { fixture, peer } = create({ id: wireChat.id, messageId: wireMessage.id });
    peer
      .expect('messages.listForwardedMessages', { chatId: wireChat.id, messageId: wireMessage.id })
      .flush({ total: 1, messages: [record] });
    await fixture.whenStable();
    fixture.detectChanges();
    const node = fixture.nativeElement.querySelector('app-message');
    resync.next(ResyncReason.Connected);
    peer
      .expect('messages.listForwardedMessages', { chatId: wireChat.id, messageId: wireMessage.id })
      .error(RpcErrorCode.Unavailable);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-message')).toBe(node);
    resync.next(ResyncReason.Connected);
    peer
      .expect('messages.listForwardedMessages', { chatId: wireChat.id, messageId: wireMessage.id })
      .error(RpcErrorCode.Forbidden);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance['unavailable']()).toBe(true);
    peer.verify();
  });

  it('keeps saved records after source deletion or membership loss', async () => {
    const { fixture, peer } = create({ savedId: '123' });
    peer
      .expect('savedMessages.listForwardedMessages', { savedMessageId: '123' })
      .flush({ total: 1, messages: [record] });
    await fixture.whenStable();
    fixture.detectChanges();
    events.next({ type: ServerWsMessageType.messageDeleted, payload: { ...testMessage, isDeleted: true } });
    changes.next({ kind: ChatChangeKind.Removed, chatId: testChat.id });
    expect(fixture.componentInstance['data']()?.messages).toHaveLength(1);
    expect(watchReadStates).not.toHaveBeenCalled();
    peer.verify();
  });
});
