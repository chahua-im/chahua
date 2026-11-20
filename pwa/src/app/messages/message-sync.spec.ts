import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { vi } from 'vitest';
import { Connection, ResyncReason } from '../api/connection';
import { RpcTestPeer, provideRpcTesting, type RpcTestRequest } from '../api/rpc-testing';
import { RpcTransport } from '../api/rpc-transport';
import { decodeId, encodeId } from '../api/snowflake-id';
import { wireChat, wireMessage } from '../api/testing';
import { MessageSync } from './message-sync';

const chatId = wireChat.id;

function open(peer: RpcTestPeer, uid = 1) {
  TestBed.inject(RpcTransport).open({ token: 'fixture', appVersion: 'test' }).subscribe();
  peer.open();
  peer
    .expect('session.open')
    .flush({ protocolVersion: 1, authenticated: true, uid, clientId: 'fixture', messageSync: 1 });
}

function baseline(peer: RpcTestPeer, chatId: string, cursor: string) {
  peer.notify('events.messageSyncReset', { chatId, cursor, reason: 'noBaseline' });
}

describe('MessageSync', () => {
  let peer: RpcTestPeer;
  let sync: MessageSync;
  let connection: Connection;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRpcTesting()] });
    peer = TestBed.inject(RpcTestPeer);
    connection = TestBed.inject(Connection);
    sync = TestBed.inject(MessageSync);
  });

  afterEach(() => {
    try {
      peer.verify();
    } finally {
      TestBed.resetTestingModule();
      vi.restoreAllMocks();
    }
  });

  it('starts an empty resume before publishing Connected and sends 129 checkpoints in two chunks', async () => {
    let claimed: RpcTestRequest | undefined;
    const watching = connection.resync$.subscribe((state) => {
      if (state === ResyncReason.Connected) claimed = peer.expect('messageSync.resume');
    });
    open(peer);
    watching.unsubscribe();
    expect(claimed?.params).toEqual({ chats: [], last: true });
    const ids = Array.from({ length: 129 }, (_, index) => String(9007199254740993n + BigInt(index)));
    for (const [index, id] of ids.entries()) baseline(peer, id, `cursor-${index}`);
    claimed!.flush({});
    await sync.waitForResume();

    const owner = {};
    sync.setPriority(encodeId(ids[128]), owner);
    sync.clearPriority({});
    open(peer);
    const first = peer.expect('messageSync.resume');
    expect(first.params).toEqual({
      chats: ids.slice(0, 128).map((chatId, index) => ({ chatId, cursor: `cursor-${index}` })),
      last: false,
    });
    peer.expectNone('messageSync.resume');
    first.flush({});
    const second = await peer.expectAsync('messageSync.resume');
    expect(second.params).toEqual({
      chats: [{ chatId: ids[128], cursor: 'cursor-128' }],
      last: true,
      priorityChatId: ids[128],
    });
    second.flush({});
    await sync.waitForResume();
  });

  it.each(['wrong', undefined])(
    'reconnects and applies nothing when the installed baseline does not match (%s)',
    (from) => {
      const reconnect = vi.spyOn(TestBed.inject(RpcTransport), 'reconnect');
      const changes = vi.fn();
      connection.changes$.subscribe(changes);
      open(peer);
      const resume = peer.expect('messageSync.resume');
      if (from != null) baseline(peer, chatId, 'baseline');
      resume.flush({});
      peer.notify('events.messageSyncBatch', {
        chatId,
        from: from ?? 'missing checkpoint',
        to: 'next',
        changes: [{ kind: 'upsert', appeared: true, message: wireMessage }],
      });
      expect(reconnect).toHaveBeenCalledOnce();
      expect(changes).not.toHaveBeenCalled();
    },
  );

  it('ignores an old acknowledgement across account switches and keeps wire IDs lossless', async () => {
    open(peer);
    baseline(peer, chatId, 'first user');
    const prior = peer.expect('messageSync.resume');
    const previous = sync.waitForResume().catch((error: unknown) => error);
    open(peer, 2);
    const current = peer.expect('messageSync.resume', { chats: [], last: true });
    prior.flush({});
    expect(await previous).toEqual(expect.objectContaining({ kind: 'disconnected' }));
    const settled = vi.fn();
    const wait = sync.waitForResume().then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    const id = '9223372036854775807';
    baseline(peer, id, 'new baseline');
    current.flush({});
    await wait;
    const changes = vi.fn();
    connection.changes$.subscribe(changes);
    peer.notify('events.messageSyncBatch', {
      chatId: id,
      from: 'new baseline',
      to: 'next',
      changes: [{ kind: 'delete', messageId: '9223372036854775806', threadRootId: '9223372036854775805' }],
    });
    const [{ payload }] = changes.mock.calls[0];
    expect(decodeId(payload.chatId)).toBe(id);
    expect(payload.messageIds.map(decodeId)).toEqual(['9223372036854775806']);
    expect(payload.threadRootIds.map(decodeId)).toEqual(['9223372036854775805']);
  });

  it('round-trips a page request ID above 32 bits through the generated codec', async () => {
    open(peer);
    const resume = peer.expect('messageSync.resume');
    baseline(peer, chatId, 'baseline');
    resume.flush({});
    sync['requestId'] = 2 ** 32 - 1;
    const loaded = firstValueFrom(sync.page({ chatId: encodeId(chatId) }, () => {}));
    const page = await peer.expectAsync('messageSync.page', { chatId, requestId: 2 ** 32 });
    peer.notify('events.messageSyncPageResult', { chatId, requestId: 2 ** 32, at: null, page: null });
    page.flush({});
    expect(await loaded).toEqual({ chatId: encodeId(chatId), requestId: 2 ** 32, at: null, page: null });
  });
});
