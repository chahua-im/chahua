import { TestBed } from '@angular/core/testing';
import { expectTypeOf } from 'vitest';

import { RpcApi } from '../../generated/rpc-api';
import { rpcEvents, rpcSchemas } from '../../generated/rpc-codecs';
import { MessageType, type ServiceTokenResponse } from '../../generated/models';
import type { MessagesListParams, SessionOpenResult } from '../../generated/rpc-models';
import { decodeJsonIds, encodeJsonIds } from './json-ids';
import { provideRpcTesting, RpcTestPeer } from './rpc-testing';
import { encodeId, type SnowflakeID } from './snowflake-id';

describe('RPC API boundary', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRpcTesting()] });
  });

  it('preserves source and result Snowflakes when creating a sticker through RPC', () => {
    const peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
    const received = vi.fn();
    TestBed.inject(RpcApi)
      .stickers.createFromMessage({
        packId: encodeId('9223372036854775807'),
        chatId: encodeId('9007199254740993'),
        messageId: encodeId('9007199254740995'),
        emoji: '🍵',
      })
      .subscribe(received);
    peer
      .expect('stickers.createFromMessage', {
        packId: '9223372036854775807',
        chatId: '9007199254740993',
        messageId: '9007199254740995',
        emoji: '🍵',
      })
      .flush({ id: '9007199254740997', media: { id: '9007199254740999' } });
    expect(received).toHaveBeenCalledWith({
      id: encodeId('9007199254740997'),
      media: { id: encodeId('9007199254740999') },
    });
    peer.verify();
  });

  it('serializes flat RPC params without losing Snowflakes, null, or zero', () => {
    const chatId = '9223372036854775806';
    const before = '9223372036854775805';
    const received = vi.fn();
    const peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();

    TestBed.inject(RpcApi)
      .messages.list({ chatId: encodeId(chatId), before: encodeId(before), max: 0 })
      .subscribe(received);

    peer.expect('messages.list', { chatId, before, max: 0 }).flush({
      messages: [{ id: before, chatId, message: null, sticker: null }],
      nextCursor: null,
      prevCursor: null,
      olderCursor: null,
      newerCursor: null,
    });

    expect(received).toHaveBeenCalledWith({
      messages: [{ id: encodeId(before), chatId: encodeId(chatId), message: null, sticker: null }],
      nextCursor: null,
      prevCursor: null,
      olderCursor: null,
      newerCursor: null,
    });
    TestBed.inject(RpcApi)
      .groups.update({ chatId: encodeId(chatId), avatarImageId: null })
      .subscribe();
    peer.expect('groups.update', { chatId, avatarImageId: null }).flush({});
    peer.verify();
  });

  it('keeps the timestamp-based global thread cursor as an exact string', () => {
    const cursor = '2026-10-31T12:34:56.123456Z';
    const received = vi.fn();
    const peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();

    TestBed.inject(RpcApi).threads.list().subscribe(received);
    peer.expect('threads.list', {}).flush({ threads: [], nextCursor: cursor });

    expect(received).toHaveBeenCalledWith({ threads: [], nextCursor: cursor });
    peer.verify();
  });

  it('converts explicitly marked service-token IDs and leaves ordinary values unchanged', () => {
    const wireId = '9223372036854775804';
    const value = {
      id: encodeId(wireId),
      createdByUid: 7,
      enabled: false,
      count: 0,
      empty: '',
      nullable: null,
      omitted: undefined,
    };

    const request = decodeJsonIds(value, rpcSchemas['ServiceTokenResponse'], rpcSchemas);
    expect(request).toEqual({
      id: wireId,
      createdByUid: 7,
      enabled: false,
      count: 0,
      empty: '',
      nullable: null,
      omitted: undefined,
    });
    expect(value.id).toBe(encodeId(wireId));

    const response = encodeJsonIds(request, rpcSchemas['ServiceTokenResponse'], rpcSchemas);
    expect(response).toEqual(value);
    expect(encodeJsonIds(response, rpcSchemas['ServiceTokenResponse'], rpcSchemas)).toEqual(response);
  });

  it('serializes marked attachment arrays through the real RPC peer and decodes nested pack-order events', () => {
    const chatId = '9223372036854775803';
    const attachmentId = '9223372036854775802';
    const packId = '9223372036854775801';
    const peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();

    TestBed.inject(RpcApi)
      .messages.send({
        chatId: encodeId(chatId),
        attachmentIds: [encodeId(attachmentId)],
        clientGeneratedId: 'attachment-regression',
        message: '',
        messageType: MessageType.text,
      })
      .subscribe();

    peer
      .expect('messages.send', {
        chatId,
        attachmentIds: [attachmentId],
        clientGeneratedId: 'attachment-regression',
        message: '',
        messageType: 'text',
      })
      .flush({ id: attachmentId, chatId, attachments: [{ id: attachmentId }] });

    expect(
      encodeJsonIds(
        { order: [{ stickerPackId: packId, position: 0 }] },
        rpcEvents['events.stickerPackOrderUpdated'],
        rpcSchemas,
      ),
    ).toEqual({ order: [{ stickerPackId: encodeId(packId), position: 0 }] });
    peer.verify();
  });

  it('exports literal session authentication variants and branded service-token IDs', () => {
    expectTypeOf<Extract<SessionOpenResult, { authenticated: true }>['protocolVersion']>().toEqualTypeOf<1>();
    expectTypeOf<Extract<SessionOpenResult, { authenticated: false }>['protocolVersion']>().toEqualTypeOf<1>();
    expectTypeOf<ServiceTokenResponse['id']>().toEqualTypeOf<SnowflakeID>();
    expectTypeOf<MessagesListParams['before']>().toEqualTypeOf<SnowflakeID | undefined>();
  });
});
