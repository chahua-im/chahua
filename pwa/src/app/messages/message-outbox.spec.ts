import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { AlertController } from '@ionic/angular';
import {
  AttachmentUploadPurpose,
  MessageType,
  SpeakingMode,
  ServerWsMessageType,
  type MessageResponse,
  type ServerWsMessage,
} from '../../generated/models';
import { Connection } from '../api/connection';
import { RpcErrorCode } from '../api/rpc-error';
import { provideRpcTesting, RpcTestPeer } from '../api/rpc-testing';
import { decodeId, encodeId, type SnowflakeID } from '../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser, wireMessage } from '../api/testing';
import { SessionStore } from '../session/session-store';
import { MessageDelivery } from './message-delivery';
import { MessageOutbox } from './message-outbox';
import { UploadStatus, type AttachmentUpload } from './upload';

const text = { messageType: MessageType.text, attachmentIds: [] };
const chatId = decodeId(testChat.id);

function wireAccepted(clientGeneratedId: string, id = '9007199254741100', message?: string) {
  return { ...wireMessage, id, clientGeneratedId, ...(message === undefined ? {} : { message }) };
}

describe('MessageOutbox', () => {
  let outbox: MessageOutbox;
  let peer: RpcTestPeer;
  let live: Subject<MessageResponse>;
  let resync: Subject<void>;
  let events: Subject<ServerWsMessage>;
  let session: { user: WritableSignal<typeof testUser | undefined> };

  let alertController: Pick<AlertController, 'create'>;

  beforeEach(() => {
    events = new Subject();
    live = new Subject();
    resync = new Subject();
    session = { user: signal<typeof testUser | undefined>(testUser) };
    alertController = { create: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        ...provideRpcTesting(),
        { provide: Connection, useValue: mockRealtime({ messages$: live, resync$: resync, events$: events }) },
        { provide: SessionStore, useValue: session },
        { provide: AlertController, useValue: alertController },
      ],
    });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
    outbox = TestBed.inject(MessageOutbox);
  });

  afterEach(() => {
    try {
      peer.verify();
    } finally {
      TestBed.resetTestingModule();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  function accepted(item: { clientGeneratedId: string }, index = 0, message?: string) {
    return wireAccepted(item.clientGeneratedId, String(9007199254741100n + BigInt(index)), message);
  }

  function upload() {
    let finish!: (id: SnowflakeID | undefined) => void;
    const result = new Promise<SnowflakeID | undefined>((resolve) => (finish = resolve));
    const item = {
      file: new File(['data'], 'photo.jpg', { type: 'image/jpeg' }),
      url: 'blob:local-photo',
      purpose: AttachmentUploadPurpose.media,
      state: signal({
        status: UploadStatus.Uploading,
        progress: 0.25,
        width: 320,
        height: 200,
        id: undefined as SnowflakeID | undefined,
      }),
      retry: vi.fn(() => result),
      dispose: vi.fn(),
    };
    return {
      item: item as unknown as AttachmentUpload,
      finish: (id: SnowflakeID | undefined) => {
        item.state.update((state) => ({ ...state, id, status: id == null ? UploadStatus.Failed : UploadStatus.Ready }));
        finish(id);
      },
      state: item.state,
      dispose: item.dispose,
    };
  }

  it('sends decimal IDs in one flat request and accepts its confirmation through Connection', async () => {
    const item = outbox.enqueue(testChat.id, undefined, '保留消息', text, testMessage);
    const request = peer.expect('messages.send', {
      chatId,
      clientGeneratedId: item.clientGeneratedId,
      messageType: MessageType.text,
      message: '保留消息',
      attachmentIds: [],
      replyToId: decodeId(testMessage.id),
    });
    request.flush(wireAccepted(item.clientGeneratedId));
    await item.operation;
    expect(item.delivery()).toBe(MessageDelivery.Sent);
    expect(item.confirmed()?.id).toBe(encodeId('9007199254741100'));
  });

  it('keeps same-conversation creates serial while another conversation progresses', async () => {
    const first = outbox.enqueue(testChat.id, undefined, 'first', text);
    const second = outbox.enqueue(testChat.id, undefined, 'second', text);
    const otherChat = encodeId('9007199254741999');
    const other = outbox.enqueue(otherChat, undefined, 'other', text);
    const firstRequest = peer.expect('messages.send', (params) => params['message'] === 'first');
    const otherRequest = peer.expect('messages.send', (params) => params['message'] === 'other');
    peer.expectNone('messages.send');
    otherRequest.flush({ ...wireAccepted(other.clientGeneratedId, '9007199254741101'), chatId: decodeId(otherChat) });
    firstRequest.flush(wireAccepted(first.clientGeneratedId));
    await Promise.all([first.operation, other.operation]);
    peer
      .expect('messages.send', {
        chatId,
        clientGeneratedId: second.clientGeneratedId,
        messageType: MessageType.text,
        message: 'second',
        attachmentIds: [],
      })
      .flush(wireAccepted(second.clientGeneratedId, '9007199254741102'));
    await second.operation;
  });

  it('retains a stable operation ID and retries only transient failures', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'retry', text);
    const first = peer.expect('messages.send');
    first.error(RpcErrorCode.Unavailable);
    await item.operation;
    expect(item.delivery()).toBe(MessageDelivery.Failed);
    const retry = outbox.retry(item);
    peer
      .expect('messages.send', {
        chatId,
        clientGeneratedId: item.clientGeneratedId,
        messageType: MessageType.text,
        message: 'retry',
        attachmentIds: [],
      })
      .flush(wireAccepted(item.clientGeneratedId));
    await retry;
    expect(item.delivery()).toBe(MessageDelivery.Sent);
  });

  it('does not retry a speaking restriction on resync and preserves its explicit retry identity', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'restricted', text);
    peer.expect('messages.send').error(RpcErrorCode.SpeakingRestricted, 'Speaking is restricted', {
      code: 'speakingRestricted',
      effectiveSpeakingMode: SpeakingMode.readOnly,
    });
    await item.operation;
    expect(item.delivery()).toBe(MessageDelivery.Failed);
    expect(item.speakingRestriction?.()).toBe(SpeakingMode.readOnly);
    resync.next();
    peer.expectNone('messages.send');
    const retry = outbox.retry(item);
    peer
      .expect('messages.send', (params) => params['clientGeneratedId'] === item.clientGeneratedId)
      .flush(wireAccepted(item.clientGeneratedId));
    await retry;
  });

  it('lets an echo win over a late failed response without replaying the mutation', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'echo', text);
    const request = peer.expect('messages.send');
    live.next({ ...testMessage, sender: item.message().sender, clientGeneratedId: item.clientGeneratedId });
    request.error(RpcErrorCode.Internal);
    await item.operation;
    expect(item.delivery()).toBe(MessageDelivery.Sent);
    peer.expectNone('messages.send');
  });

  it('edits only after the create acknowledgement and preserves the newest body', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'original', text);
    const create = peer.expect('messages.send');
    outbox.edit(item, 'latest edit', text);
    create.flush(wireAccepted(item.clientGeneratedId));
    (
      await peer.expectAsync('messages.edit', {
        chatId,
        messageId: '9007199254741100',
        message: 'latest edit',
        attachmentIds: [],
      })
    ).flush({ ...wireAccepted(item.clientGeneratedId), message: 'latest edit', isEdited: true });
    await item.operation;
    expect(item.message().message).toBe('latest edit');
  });

  it('cancels a sent create, ignores its late result for display, and deletes the discovered server message', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'cancel', text);
    const create = peer.expect('messages.send');
    await outbox.cancel(item);
    expect(item.cancelled()).toBe(true);
    create.flush(wireAccepted(item.clientGeneratedId));
    await item.operation;
    (await peer.expectAsync('messages.delete', { chatId, messageId: '9007199254741100' })).flush(null);
    expect(item.message().message).toBeUndefined();
  });

  it('sends forward placeholders only after an explicit BadRequest confirmation', async () => {
    let dismiss!: (detail: { role?: string }) => void;
    const dismissal = new Promise<{ role?: string }>((resolve) => {
      dismiss = resolve;
    });
    const alert = {
      present: vi.fn(async () => {}),
      dismiss: vi.fn(async () => true),
      onDidDismiss: () => dismissal,
    };
    alertController.create = vi.fn(async () => alert as never);
    const item = outbox.enqueueForward(testChat.id, undefined, [testMessage]);
    peer
      .expect('messages.forwardOne')
      .error(RpcErrorCode.BadRequest, 'Audio messages cannot be forwarded until transcoding finishes');
    await vi.waitFor(() => expect(alert.present).toHaveBeenCalledOnce());
    dismiss({ role: 'confirm' });
    await vi.waitFor(() => {
      const retry = peer.expect('messages.forwardOne');
      if (!retry.params) throw new Error('Forward retry had no named params');
      expect(retry.params['allowPlaceholders']).toBe(true);
      retry.flush(wireAccepted(item.clientGeneratedId));
    });
    await item.operation;
  });

  it('sends a single selection to a thread through forwardOne and confirms forwarded audio immediately', async () => {
    const threadId = encodeId('9007199254741888');
    const source = { ...testMessage, messageType: MessageType.audio };
    const item = outbox.enqueueForward(testChat.id, threadId, [source]);
    peer
      .expect('messages.forwardOne', (params) => params['threadId'] === decodeId(threadId))
      .flush({
        ...accepted(item),
        messageType: MessageType.audio,
        replyRootId: decodeId(threadId),
      });
    await item.operation;
    expect(item.published()).toBe(true);
  });

  it('serializes merged forwards with ordinary sends and retains their retry key', async () => {
    const first = outbox.enqueue(testChat.id, undefined, 'before', text);
    const forward = outbox.enqueueForward(testChat.id, undefined, [
      { ...testMessage, id: encodeId('9007199254741999') },
      testMessage,
    ]);
    peer.expect('messages.send').flush(accepted(first));
    await first.operation;
    const request = peer.expect('messages.forward');
    expect(request.params?.['messageIds']).toEqual([decodeId(testMessage.id), '9007199254741999']);
    request.error(RpcErrorCode.Unavailable);
    await forward.operation;
    const retry = outbox.retry(forward);
    peer.expect('messages.forward').flush(accepted(forward));
    await retry;
  });

  it('forwards a nested card without another bundle or visible origin', () => {
    const source = {
      ...testMessage,
      messageType: MessageType.forwarded,
      forwardedBundleId: encodeId('999'),
      forwardedPreview: { total: 3, containsForwardedMessages: true, messages: [] },
    };
    const item = outbox.enqueueForward(testChat.id, undefined, [source]);
    expect(item.message().forwardedBundleId).toBe(source.forwardedBundleId);
    expect(item.message().forwardedFrom).toBeUndefined();
    peer.expect('messages.forwardOne').error(RpcErrorCode.Forbidden);
  });

  it('lets a realtime confirmation win over a failed forward response', async () => {
    const item = outbox.enqueueForward(testChat.id, undefined, [testMessage]);
    const request = peer.expect('messages.forwardOne');
    live.next({ ...testMessage, sender: item.message().sender, clientGeneratedId: item.clientGeneratedId });
    request.error(RpcErrorCode.Internal);
    await item.operation;
    expect(item.delivery()).toBe(MessageDelivery.Sent);
  });

  it.each([
    { count: 1, threadId: undefined },
    { count: 2, threadId: encodeId('999') },
  ])('sends the comment to the destination after forwarding $count messages', async ({ count, threadId }) => {
    const item = outbox.enqueueForward(
      testChat.id,
      threadId,
      Array.from({ length: count }, (_, index) => ({ ...testMessage, id: encodeId(String(100 + index)) })),
      { comment: '  看看这个\n很有意思  ' },
    );
    peer.expect(count === 1 ? 'messages.forwardOne' : 'messages.forward').flush(accepted(item));
    await item.operation;
    const comment = outbox.items()[1];
    peer
      .expect(
        threadId ? 'messages.sendInThread' : 'messages.send',
        (params) => params['message'] === '看看这个\n很有意思',
      )
      .flush(accepted(comment, 1, '看看这个\n很有意思'));
    await comment.operation;
    expect(comment.delivery()).toBe(MessageDelivery.Sent);
  });

  it('retains a comment through forward failure and retries only its failed send', async () => {
    const forward = outbox.enqueueForward(testChat.id, undefined, [testMessage], { comment: '附言' });
    peer.expect('messages.forwardOne').error(RpcErrorCode.Unavailable);
    await forward.operation;
    const forwarding = outbox.retry(forward);
    peer.expect('messages.forwardOne').flush(accepted(forward));
    await forwarding;
    const comment = outbox.items()[1];
    peer.expect('messages.send').error(RpcErrorCode.Unavailable);
    await comment.operation;
    const retry = outbox.retry(comment);
    peer.expect('messages.send').flush(accepted(comment, 2, '附言'));
    await retry;
  });

  it('sends one comment when a realtime echo confirms a failed forward', async () => {
    const item = outbox.enqueueForward(testChat.id, undefined, [testMessage], { comment: '附言' });
    const request = peer.expect('messages.forwardOne');
    live.next({ ...testMessage, sender: item.message().sender, clientGeneratedId: item.clientGeneratedId });
    request.error(RpcErrorCode.Internal);
    await item.operation;
    const comment = outbox.items()[1];
    peer.expect('messages.send').flush(accepted(comment, 1, '附言'));
    await comment.operation;
  });

  it.each(['', ' \n '])('does not send an empty forward comment (%j)', async (comment) => {
    const item = outbox.enqueueForward(testChat.id, undefined, [testMessage], { comment });
    peer.expect('messages.forwardOne').flush(accepted(item));
    await item.operation;
    peer.expectNone('messages.send');
  });

  it('discards a forward comment cancelled before a late acknowledgement', async () => {
    const item = outbox.enqueueForward(testChat.id, undefined, [testMessage], { comment: '附言' });
    const request = peer.expect('messages.forwardOne');
    await outbox.cancel(item);
    request.flush(accepted(item));
    await item.operation;
    peer.expect('messages.delete').flush(null);
    peer.expectNone('messages.send');
  });

  it('discards unsent forward comments on account change', async () => {
    const item = outbox.enqueueForward(testChat.id, undefined, [testMessage], { comment: '附言' });
    const request = peer.expect('messages.forwardOne');
    session.user.set({ ...testUser, uid: 2 });
    await vi.waitFor(() => expect(outbox.items()).toEqual([]));
    request.flush(accepted(item));
    await item.operation;
    peer.expectNone('messages.delete');
    peer.expectNone('messages.send');
  });

  it.each([
    'Audio messages cannot be forwarded until transcoding finishes',
    'Forwarded messages cannot include nested forwarded messages',
  ])('retries the same forward key only after fallback consent: %s', async (message) => {
    let dismiss!: (result: { role?: string }) => void;
    const dismissed = new Promise<{ role?: string }>((resolve) => (dismiss = resolve));
    const alert = { present: vi.fn(), dismiss: vi.fn(), onDidDismiss: () => dismissed };
    alertController.create = vi.fn(async () => alert as never);
    const item = outbox.enqueueForward(testChat.id, undefined, [testMessage]);
    peer.expect('messages.forwardOne').error(RpcErrorCode.BadRequest, message);
    await vi.waitFor(() => expect(alert.present).toHaveBeenCalledOnce());
    dismiss({ role: 'confirm' });
    const retry = await vi.waitFor(() => peer.expect('messages.forwardOne'));
    expect(retry.params?.['allowPlaceholders']).toBe(true);
    retry.flush(accepted(item));
    await item.operation;
  });

  it('leaves a rejected fallback failed without automatic retry', async () => {
    let dismiss!: (result: { role?: string }) => void;
    const dismissed = new Promise<{ role?: string }>((resolve) => (dismiss = resolve));
    const alert = { present: vi.fn(), dismiss: vi.fn(), onDidDismiss: () => dismissed };
    alertController.create = vi.fn(async () => alert as never);
    const item = outbox.enqueueForward(testChat.id, undefined, [testMessage]);
    peer
      .expect('messages.forwardOne')
      .error(RpcErrorCode.BadRequest, 'Audio messages cannot be forwarded until transcoding finishes');
    await vi.waitFor(() => expect(alert.present).toHaveBeenCalledOnce());
    dismiss({ role: 'cancel' });
    await item.operation;
    expect(item.delivery()).toBe(MessageDelivery.Failed);
    resync.next();
    peer.expectNone('messages.forwardOne');
  });

  it('dismisses fallback confirmation on account change', async () => {
    let dismiss!: (result: { role?: string }) => void;
    const dismissed = new Promise<{ role?: string }>((resolve) => (dismiss = resolve));
    const alert = {
      present: vi.fn(),
      dismiss: vi.fn(async (_data?: unknown, role?: string) => {
        dismiss({ role });
        return true;
      }),
      onDidDismiss: () => dismissed,
    };
    alertController.create = vi.fn(async () => alert as never);
    const item = outbox.enqueueForward(testChat.id, undefined, [testMessage]);
    peer
      .expect('messages.forwardOne')
      .error(RpcErrorCode.BadRequest, 'Audio messages cannot be forwarded until transcoding finishes');
    await vi.waitFor(() => expect(alert.present).toHaveBeenCalledOnce());
    session.user.set({ ...testUser, uid: 2 });
    await item.operation;
    expect(alert.dismiss).toHaveBeenCalledWith(undefined, 'cancel');
  });
  it('stages acknowledged audio as server data and releases its upload only after range handoff', async () => {
    const media = upload();
    media.finish(encodeId('123'));
    const item = outbox.enqueue(testChat.id, undefined, '', {
      messageType: MessageType.audio,
      attachmentIds: [],
      uploads: [media.item],
    });
    peer.expect('messages.send').flush({ ...accepted(item), messageType: MessageType.audio });
    await item.operation;
    expect(item.published()).toBe(false);
    live.next({
      ...testMessage,
      id: encodeId('9007199254741100'),
      clientGeneratedId: item.clientGeneratedId,
      messageType: MessageType.audio,
    });
    outbox.release([item.confirmed()!]);
    expect(media.dispose).toHaveBeenCalledOnce();
  });

  it('waits for audio publication without cancelling the selected row', async () => {
    const item = outbox.enqueue(testChat.id, undefined, '', { messageType: MessageType.audio, attachmentIds: [] });
    peer.expect('messages.send').flush({ ...accepted(item), messageType: MessageType.audio });
    await item.operation;
    const waiting = outbox.waitForPublication(item);
    live.next({
      ...testMessage,
      id: encodeId('9007199254741100'),
      clientGeneratedId: item.clientGeneratedId,
      messageType: MessageType.audio,
    });
    await expect(waiting).resolves.toMatchObject({ clientGeneratedId: item.clientGeneratedId });
    expect(item.cancelled()).toBe(false);
  });

  it('times out publication waiting while retaining acknowledged audio', async () => {
    vi.useFakeTimers();
    const item = outbox.enqueue(testChat.id, undefined, '', { messageType: MessageType.audio, attachmentIds: [] });
    peer.expect('messages.send').flush({ ...accepted(item), messageType: MessageType.audio });
    await item.operation;
    const waiting = outbox.waitForPublication(item).catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await waiting).name).toBe('TimeoutError');
    expect(item.confirmed()).toBeDefined();
  });

  it('publishes a complete local row and releases it only after range handoff', async () => {
    const item = outbox.enqueue(testChat.id, undefined, '本地消息', text, testMessage);
    expect(item.message()).toMatchObject({
      message: '本地消息',
      sender: testMessage.sender,
      replyToMessage: testMessage,
    });
    peer
      .expect('messages.send', (params) => params['replyToId'] === decodeId(testMessage.id))
      .flush(accepted(item, 0, '本地消息'));
    await item.operation;
    outbox.release([item.confirmed()!]);
    expect(outbox.items()).toEqual([]);
  });

  it('lets text pass uploads and queues ready attachments behind a create', async () => {
    const media = upload();
    const attachment = outbox.enqueue(testChat.id, undefined, '', { ...text, uploads: [media.item] });
    const message = outbox.enqueue(testChat.id, undefined, '边传边聊', text);
    peer.expect('messages.send', (params) => params['message'] === '边传边聊').flush(accepted(message, 1, '边传边聊'));
    await message.operation;
    media.finish(encodeId('7'));
    await vi.waitFor(() =>
      peer
        .expect('messages.send', (params) => (params['attachmentIds'] as unknown[]).includes('7'))
        .flush({
          ...accepted(attachment),
          attachments: [{ id: '7', url: '/photo', fileName: 'photo.jpg', kind: 'image/jpeg', size: 4 }],
        }),
    );
    await attachment.operation;
    outbox.release([attachment.confirmed()!]);
    expect(media.dispose).toHaveBeenCalledOnce();
  });

  it('keeps a realtime confirmation when its RPC response later fails', async () => {
    const item = outbox.enqueue(testChat.id, undefined, '已被服务器接收', text);
    const request = peer.expect('messages.send');
    live.next({ ...testMessage, sender: item.message().sender, clientGeneratedId: item.clientGeneratedId });
    request.error(RpcErrorCode.Internal);
    await item.operation;
    expect(item.delivery()).toBe(MessageDelivery.Sent);
  });

  it('does not send failed uploads and retains their preview for retry', async () => {
    const media = upload();
    const item = outbox.enqueue(testChat.id, undefined, '', { ...text, uploads: [media.item] });
    media.finish(undefined);
    await item.operation;
    peer.expectNone('messages.send');
    expect(item.message().attachments[0].url).toBe(media.item.url);
  });

  it('retries selected failed uploads and sends after all uploads are ready', async () => {
    const first = upload();
    const second = upload();
    first.item.retryable = second.item.retryable = false;
    const item = outbox.enqueue(testChat.id, undefined, '', { ...text, uploads: [first.item, second.item] });
    first.finish(undefined);
    second.finish(undefined);
    await item.operation;
    vi.mocked(first.item.retry).mockImplementation(async () => {
      const id = encodeId('7');
      first.state.update((state) => ({ ...state, id, status: UploadStatus.Ready }));
      return id;
    });
    vi.mocked(second.item.retry).mockImplementation(async () => {
      const id = encodeId('8');
      second.state.update((state) => ({ ...state, id, status: UploadStatus.Ready }));
      return id;
    });
    await outbox.retryUpload(item, first.item);
    const retry = outbox.retryUpload(item, second.item);
    (await peer.expectAsync('messages.send', (params) => (params['attachmentIds'] as unknown[]).length === 2)).flush(
      accepted(item),
    );
    await retry;
  });

  it.each([MessageType.file, MessageType.audio, MessageType.text])(
    'removes an empty local %s row after its only failed upload',
    async (messageType) => {
      const media = upload();
      const item = outbox.enqueue(testChat.id, undefined, '', {
        messageType,
        attachmentIds: [],
        uploads: [media.item],
      });
      media.finish(undefined);
      await item.operation;
      outbox.removeUpload(item, media.item);
      expect(outbox.items()).not.toContain(item);
      peer.expectNone('messages.send');
    },
  );

  it('drops empty edits whose only newly selected upload fails', async () => {
    const media = upload();
    const item = outbox.enqueueEdit(testMessage, undefined, '', { ...text, uploads: [media.item] });
    media.finish(undefined);
    await item.operation;
    outbox.removeUpload(item, media.item);
    expect(outbox.items()).not.toContain(item);
    peer.expectNone('messages.edit');
  });

  it('retains another new attachment after removing a failed edit upload', async () => {
    const ready = upload();
    const failed = upload();
    const item = outbox.enqueueEdit(testMessage, undefined, testMessage.message!, {
      ...text,
      uploads: [ready.item, failed.item],
    });
    ready.finish(encodeId('7'));
    failed.finish(undefined);
    await item.operation;
    outbox.removeUpload(item, failed.item);
    await vi.waitFor(() =>
      peer
        .expect('messages.edit', (params) => (params['attachmentIds'] as unknown[]).includes('7'))
        .flush(accepted(item)),
    );
    await item.operation;
  });

  it('acknowledges audio but retains local playback until publication', async () => {
    const item = outbox.enqueue(testChat.id, undefined, '', {
      messageType: MessageType.audio,
      attachmentIds: [encodeId('7')],
    });
    const local = item.message();
    peer.expect('messages.send').flush({ ...accepted(item), messageType: MessageType.audio });
    await item.operation;
    expect(item.message()).toEqual(local);
    live.next({
      ...testMessage,
      id: encodeId('9007199254741100'),
      clientGeneratedId: item.clientGeneratedId,
      messageType: MessageType.audio,
      message: '音频已发布',
    });
    expect(item.published()).toBe(true);
  });

  it('does not overwrite early audio publication with a late creation response', async () => {
    const item = outbox.enqueue(testChat.id, undefined, '', { messageType: MessageType.audio, attachmentIds: [] });
    const published = {
      ...testMessage,
      sender: item.message().sender,
      clientGeneratedId: item.clientGeneratedId,
      messageType: MessageType.audio,
      message: '发布后信息',
    };
    live.next(published);
    peer.expect('messages.send').flush({ ...accepted(item), messageType: MessageType.audio });
    await item.operation;
    expect(item.message()).toBe(published);
  });

  it('checks acknowledged audio on resync and retains it when get returns NotFound', async () => {
    const item = outbox.enqueue(testChat.id, undefined, '', { messageType: MessageType.audio, attachmentIds: [] });
    peer.expect('messages.send').flush({ ...accepted(item), messageType: MessageType.audio });
    await item.operation;
    resync.next();
    peer.expect('messages.get', { chatId, messageId: '9007199254741100' }).error(RpcErrorCode.NotFound);
    expect(item.delivery()).toBe(MessageDelivery.Sent);
    const publication = await vi.waitFor(() => {
      resync.next();
      return peer.expect('messages.get', { chatId, messageId: '9007199254741100' });
    });
    publication.flush({ ...accepted(item), messageType: MessageType.audio });
    await vi.waitFor(() => expect(item.published()).toBe(true));
  });

  it('keeps thread sends separate and cancels queued uploads on account change', async () => {
    const threadId = encodeId('9');
    const topic = outbox.enqueue(testChat.id, threadId, '话题', text);
    peer.expect('messages.sendInThread', (params) => params['threadId'] === decodeId(threadId)).flush(accepted(topic));
    await topic.operation;
    const media = upload();
    const pending = outbox.enqueue(testChat.id, undefined, '', { ...text, uploads: [media.item] });
    session.user.set(undefined);
    await vi.waitFor(() => expect(media.dispose).toHaveBeenCalledOnce());
    media.finish(encodeId('7'));
    await pending.operation;
    peer.expectNone('messages.send');
  });

  it('lets later messages pass rejected creates and makes manual retry wait for their acknowledgement', async () => {
    const first = outbox.enqueue(testChat.id, undefined, 'first', text);
    const second = outbox.enqueue(testChat.id, undefined, 'second', text);
    peer.expect('messages.send', (params) => params['message'] === 'first').error(RpcErrorCode.BadRequest);
    await first.operation;
    peer.expect('messages.send', (params) => params['message'] === 'second').flush(accepted(second, 1, 'second'));
    const retry = outbox.retry(first);
    await second.operation;
    peer.expect('messages.send', (params) => params['message'] === 'first').flush(accepted(first, 2, 'first'));
    await retry;
  });

  it('makes automatic transient retry wait behind a newer create', async () => {
    vi.useFakeTimers();
    const first = outbox.enqueue(testChat.id, undefined, 'first', text);
    const second = outbox.enqueue(testChat.id, undefined, 'second', text);
    peer.expect('messages.send', (params) => params['message'] === 'first').error(RpcErrorCode.Unavailable);
    await first.operation;
    peer.expect('messages.send', (params) => params['message'] === 'second').flush(accepted(second, 1, 'second'));
    await second.operation;
    await vi.advanceTimersByTimeAsync(1_000);
    peer.expect('messages.send', (params) => params['message'] === 'first').flush(accepted(first, 2, 'first'));
    await first.operation;
  });

  it('edits before a create starts and disposes unfinished uploads without a patch', async () => {
    const media = upload();
    const item = outbox.enqueue(testChat.id, undefined, 'old', { ...text, uploads: [media.item] });
    outbox.edit(item, 'new', text);
    await vi.waitFor(() =>
      peer.expect('messages.send', (params) => params['message'] === 'new').flush(accepted(item, 0, 'new')),
    );
    await item.operation;
    expect(media.dispose).toHaveBeenCalledOnce();
    peer.expectNone('messages.edit');
  });
  it('freezes a started create across retry and patches only after acknowledgement', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'original', text);
    const first = peer.expect('messages.send');
    outbox.edit(item, 'latest edit', text);
    first.error(RpcErrorCode.Unavailable);
    await item.operation;
    const retry = outbox.retry(item);
    peer.expect('messages.send', (params) => params['message'] === 'original').flush(accepted(item));
    await vi.waitFor(() =>
      peer
        .expect('messages.edit', (params) => params['message'] === 'latest edit')
        .flush({ ...accepted(item), message: 'latest edit', isEdited: true }),
    );
    await retry;
  });

  it('allows the next create after an echo while its HTTP-era equivalent acknowledgement and edit remain pending', async () => {
    const first = outbox.enqueue(testChat.id, undefined, 'first', text);
    const request = peer.expect('messages.send');
    const second = outbox.enqueue(testChat.id, undefined, 'second', text);
    outbox.edit(first, 'edited', text);
    live.next({ ...testMessage, sender: first.message().sender, clientGeneratedId: first.clientGeneratedId });
    peer.expect('messages.send', (params) => params['message'] === 'second').flush(accepted(second, 1, 'second'));
    request.flush(accepted(first));
    await vi.waitFor(() =>
      peer.expect('messages.edit').flush({ ...accepted(first), message: 'edited', isEdited: true }),
    );
    await Promise.all([first.operation, second.operation]);
  });

  it('coalesces edits, ignores older acknowledgements and releases only the final range', async () => {
    const item = outbox.enqueueEdit(testMessage, undefined, 'one', text);
    const first = peer.expect('messages.edit');
    expect(outbox.enqueueEdit(testMessage, undefined, 'two', text)).toBe(item);
    outbox.edit(item, 'three', text);
    const older = { ...testMessage, message: 'one', isEdited: true };
    events.next({ type: ServerWsMessageType.messageUpdated, payload: older });
    first.flush({ ...wireMessage, message: 'one', isEdited: true });
    await vi.waitFor(() =>
      peer
        .expect('messages.edit', (params) => params['message'] === 'three')
        .flush({ ...wireMessage, message: 'three', isEdited: true }),
    );
    await item.operation;
    outbox.release([older]);
    expect(outbox.items()).toContain(item);
    const latest = { ...testMessage, message: 'three', isEdited: true };
    outbox.release([latest]);
    expect(outbox.items()).toEqual([]);
  });

  it('retains removed uploads referenced by an uncertain create until acknowledgement', async () => {
    const media = upload();
    const item = outbox.enqueue(testChat.id, undefined, 'photo', { ...text, uploads: [media.item] });
    media.finish(encodeId('7'));
    const request = await vi.waitFor(() => peer.expect('messages.send'));
    outbox.edit(item, 'text only', text);
    request.error(RpcErrorCode.Unavailable);
    await item.operation;
    expect(media.dispose).not.toHaveBeenCalled();
    const retry = outbox.retry(item);
    peer
      .expect('messages.send', (params) => (params['attachmentIds'] as unknown[]).includes('7'))
      .flush(accepted(item));
    await vi.waitFor(() =>
      peer
        .expect('messages.edit', (params) => (params['attachmentIds'] as unknown[]).length === 0)
        .flush({ ...accepted(item), message: 'text only', isEdited: true }),
    );
    await retry;
    expect(media.dispose).toHaveBeenCalledOnce();
  });

  it.each([UploadStatus.Processing, UploadStatus.Uploading])(
    'cancels attachment work in %s and lets the next create run',
    async (status) => {
      const media = upload();
      media.state.update((state) => ({ ...state, status }));
      const item = outbox.enqueue(testChat.id, undefined, '', { ...text, uploads: [media.item] });
      const next = outbox.enqueue(testChat.id, undefined, 'next', text);
      await outbox.cancel(item);
      peer.expect('messages.send', (params) => params['message'] === 'next').flush(accepted(next));
      await next.operation;
      expect(media.dispose).toHaveBeenCalledOnce();
    },
  );

  it('deletes a discovered cancelled create independently of its late send response', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'cancel', text);
    const request = peer.expect('messages.send');
    await outbox.cancel(item);
    live.next({ ...testMessage, sender: item.message().sender, clientGeneratedId: item.clientGeneratedId });
    peer.expect('messages.delete').flush(null);
    request.flush(accepted(item));
    await item.operation;
    expect(item.cancelled()).toBe(true);
  });

  it('discovers an unknown cancelled create from a normal range', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'unknown', text);
    const request = peer.expect('messages.send');
    await outbox.cancel(item);
    request.error(RpcErrorCode.Internal);
    await item.operation;
    const created = { ...testMessage, sender: item.message().sender, clientGeneratedId: item.clientGeneratedId };
    outbox.release([created]);
    peer.expect('messages.delete').flush(null);
    expect(item.cancelled()).toBe(true);
  });

  it('waits for audio publication before deleting an acknowledged cancelled create', async () => {
    const item = outbox.enqueue(testChat.id, undefined, '', { messageType: MessageType.audio, attachmentIds: [] });
    const request = peer.expect('messages.send');
    await outbox.cancel(item);
    request.flush({ ...accepted(item), messageType: MessageType.audio });
    await item.operation;
    peer.expectNone('messages.delete');
    resync.next();
    peer.expect('messages.get').flush({ ...accepted(item), messageType: MessageType.audio });
    await vi.waitFor(() => peer.expect('messages.delete').flush(null));
  });

  it('recovers a timed out send on resync with its frozen client ID', async () => {
    vi.useFakeTimers();
    const item = outbox.enqueue(testChat.id, undefined, 'retry', text);
    const timedOut = peer.expect('messages.send');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(item.delivery()).toBe(MessageDelivery.Failed);
    timedOut.flush(accepted(item));
    resync.next();
    peer
      .expect('messages.send', (params) => params['clientGeneratedId'] === item.clientGeneratedId)
      .flush(accepted(item));
    await item.operation;
  });

  it('aborts offline work and retries online without losing local content', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'offline', text);
    const offline = peer.expect('messages.send');
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    await item.operation;
    offline.flush(accepted(item));
    online.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    peer.expect('messages.send').flush(accepted(item));
    await item.operation;
  });

  it('retries transient deletes but stops automatic attempts after a permanent rejection', async () => {
    vi.useFakeTimers();
    const item = outbox.enqueue(testChat.id, undefined, 'cancel', text);
    peer.expect('messages.send').flush(accepted(item));
    await item.operation;
    const cancellation = outbox.cancel(item);
    peer.expect('messages.delete').error(RpcErrorCode.Unavailable);
    await cancellation;
    await vi.advanceTimersByTimeAsync(1_000);
    peer.expect('messages.delete').error(RpcErrorCode.Forbidden);
    await vi.advanceTimersByTimeAsync(60_000);
    peer.expectNone('messages.delete');
  });

  it('saves an editor after handoff using server attachment metadata rather than a disposed blob', async () => {
    const media = upload();
    const item = outbox.enqueue(testChat.id, undefined, 'before', { ...text, uploads: [media.item] });
    media.finish(encodeId('7'));
    const create = await vi.waitFor(() => peer.expect('messages.send'));
    const attachment = { id: '7', url: '/media/published', fileName: 'photo.jpg', kind: 'image/jpeg', size: 4 };
    create.flush({ ...accepted(item), attachments: [attachment], hasAttachments: true });
    await item.operation;
    outbox.release([item.confirmed()!]);
    const edit = outbox.edit(item, 'after', { ...text, uploads: [media.item] });
    peer
      .expect('messages.edit', (params) => (params['attachmentIds'] as unknown[]).includes('7'))
      .flush({ ...accepted(edit), attachments: [attachment], message: 'after', isEdited: true });
    await edit.operation;
  });

  it('restores a released item as a cancellation tombstone for an open recall menu', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'before', text);
    peer.expect('messages.send').flush(accepted(item));
    await item.operation;
    outbox.release([item.confirmed()!]);
    const cancellation = outbox.cancel(item);
    peer.expect('messages.delete').flush(null);
    await cancellation;
    expect(item.cancelled()).toBe(true);
  });

  it('disposes newly selected uploads when editing races with cancellation', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'cancel', text);
    const request = peer.expect('messages.send');
    await outbox.cancel(item);
    const media = upload();
    outbox.edit(item, 'late edit', { ...text, uploads: [media.item] });
    expect(media.dispose).toHaveBeenCalledOnce();
    request.flush(accepted(item));
    (await peer.expectAsync('messages.delete')).flush(null);
    await item.operation;
  });

  it('lets text pass failed uploads and failed attachment sends', async () => {
    const media = upload();
    const attachment = outbox.enqueue(testChat.id, undefined, 'media', { ...text, uploads: [media.item] });
    media.finish(undefined);
    await attachment.operation;
    const textItem = outbox.enqueue(testChat.id, undefined, 'chatting', text);
    peer.expect('messages.send', (params) => params['message'] === 'chatting').flush(accepted(textItem));
    await textItem.operation;
    expect(attachment.delivery()).toBe(MessageDelivery.Failed);
  });

  it('releases attachments on recall while retaining operation identity for a late response', async () => {
    const media = upload();
    const item = outbox.enqueue(testChat.id, undefined, 'large attachment', { ...text, uploads: [media.item] });
    media.finish(encodeId('7'));
    const request = await vi.waitFor(() => peer.expect('messages.send'));
    await outbox.cancel(item);
    expect(media.dispose).toHaveBeenCalledOnce();
    request.error(RpcErrorCode.Internal);
    await item.operation;
    expect(item.clientGeneratedId).toBeTruthy();
  });

  it('continues the latest edit when an event acknowledges a failed earlier patch', async () => {
    const item = outbox.enqueueEdit(testMessage, undefined, 'one', text);
    peer.expect('messages.edit').error(RpcErrorCode.Unavailable);
    outbox.edit(item, 'two', text);
    await item.operation;
    events.next({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...testMessage, message: 'one', isEdited: true },
    });
    peer
      .expect('messages.edit', (params) => params['message'] === 'two')
      .flush({ ...wireMessage, message: 'two', isEdited: true });
    await item.operation;
  });

  it('does not revive a permanently rejected edit when a duplicate create echo arrives', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'created', text);
    peer.expect('messages.send').flush(accepted(item));
    await item.operation;
    outbox.edit(item, 'rejected edit', text);
    peer.expect('messages.edit').error(RpcErrorCode.Forbidden);
    await item.operation;
    live.next({ ...testMessage, sender: item.message().sender, clientGeneratedId: item.clientGeneratedId });
    expect(item.delivery()).toBe(MessageDelivery.Failed);
  });
});
