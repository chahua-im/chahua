import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { ChatsService } from '../../generated/endpoints/chats/chats.service';
import { AttachmentUploadPurpose, MessageType, type MessageResponse } from '../../generated/models';
import { Connection } from '../api/connection';
import { encodeId } from '../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser } from '../api/testing';
import { SessionStore } from '../session/session-store';
import { MessageOutbox } from './message-outbox';
import { MessageDelivery } from './message-status';
import { UploadStatus, type AttachmentUpload } from './upload';

describe('MessageOutbox', () => {
  let outbox: MessageOutbox;
  let replies: Subject<MessageResponse>[];
  let live: Subject<MessageResponse>;
  let resync: Subject<void>;
  let session: { user: ReturnType<typeof signal<typeof testUser | undefined>> };
  const api = { postMessage: vi.fn(), postThreadMessage: vi.fn(), getMessage: vi.fn() };
  const text = { messageType: MessageType.text, attachmentIds: [] };
  beforeEach(() => {
    replies = [];
    live = new Subject();
    resync = new Subject();
    session = { user: signal<typeof testUser | undefined>(testUser) };
    const post = () => {
      const response = new Subject<MessageResponse>();
      replies.push(response);
      return response;
    };
    api.postMessage.mockReset().mockImplementation(post);
    api.postThreadMessage.mockReset().mockImplementation(post);
    api.getMessage.mockReset();
    TestBed.configureTestingModule({
      providers: [
        { provide: ChatsService, useValue: api },
        { provide: Connection, useValue: mockRealtime({ messages$: live, resync$: resync }) },
        { provide: SessionStore, useValue: session },
      ],
    });
    outbox = TestBed.inject(MessageOutbox);
  });
  function accepted(index = 0) {
    const [, body] = api.postMessage.mock.calls[index];
    return {
      ...testMessage,
      id: encodeId(String(9007199254741100n + BigInt(index))),
      message: body.message,
      clientGeneratedId: body.clientGeneratedId,
    };
  }
  function upload() {
    let finish!: (id: ReturnType<typeof encodeId> | undefined) => void;
    const result = new Promise<ReturnType<typeof encodeId> | undefined>((resolve) => {
      finish = resolve;
    });
    const item = {
      file: new File(['data'], 'photo.jpg', { type: 'image/jpeg' }),
      url: 'blob:local-photo',
      purpose: AttachmentUploadPurpose.media,
      state: signal({ status: UploadStatus.Uploading, progress: 0.25, width: 320, height: 200 }),
      retry: vi.fn(() => result),
      dispose: vi.fn(),
    };
    return { item: item as unknown as AttachmentUpload, finish, dispose: item.dispose };
  }
  it('publishes a complete local row before confirmation and releases it only after range handoff', async () => {
    const item = outbox.enqueue(testChat.id, undefined, '本地消息', text, testMessage);
    expect(item.message()).toMatchObject({
      message: '本地消息',
      sender: { uid: testUser.uid },
      replyToMessage: testMessage,
    });
    expect(item.message().id).toBeUndefined();
    expect(item.delivery()).toBe(MessageDelivery.Sending);
    expect(api.postMessage.mock.calls[0][1].replyToId).toBe(testMessage.id);
    const message = accepted();
    replies[0].next(message);
    await item.operation;
    expect(item.delivery()).toBe(MessageDelivery.Sent);
    expect(item.message()).toBe(message);
    expect(outbox.items()).toContain(item);
    outbox.release([message]);
    expect(outbox.items()).toEqual([]);
  });
  it('waits for upload completion and serializes creation while preserving another conversation independence', async () => {
    const media = upload();
    const first = outbox.enqueue(testChat.id, undefined, '', { ...text, uploads: [media.item] });
    const second = outbox.enqueue(testChat.id, undefined, '后面的文字', text);
    expect(api.postMessage).not.toHaveBeenCalled();
    expect(first.message().attachments[0]).toMatchObject({ url: 'blob:local-photo', width: 320, height: 200 });
    const other = outbox.enqueue(encodeId('2'), undefined, '另一会话', text);
    expect(api.postMessage).toHaveBeenCalledOnce();
    replies[0].next({ ...accepted(), chatId: encodeId('2') });
    await other.operation;
    media.finish(encodeId('7'));
    await vi.waitFor(() => expect(api.postMessage).toHaveBeenCalledTimes(2));
    expect(api.postMessage.mock.calls[1][1].attachmentIds).toEqual([encodeId('7')]);
    replies[1].next(accepted(1));
    await first.operation;
    await vi.waitFor(() => expect(api.postMessage).toHaveBeenCalledTimes(3));
    replies[2].next(accepted(2));
    await second.operation;
    expect(media.dispose).not.toHaveBeenCalled();
    outbox.release([accepted(1)]);
    expect(media.dispose).toHaveBeenCalledOnce();
  });
  it('keeps a WebSocket confirmation when HTTP later fails', async () => {
    const item = outbox.enqueue(testChat.id, undefined, '已被服务器接收', text);
    const response = accepted();
    live.next(response);
    expect(item.delivery()).toBe(MessageDelivery.Sent);
    replies[0].error(new Error('connection closed'));
    await item.operation;
    expect(item.message()).toBe(response);
    expect(item.delivery()).toBe(MessageDelivery.Sent);
    await outbox.retry(item);
    expect(api.postMessage).toHaveBeenCalledOnce();
  });
  it('retries the immutable request with the same client ID and does not duplicate a running retry', async () => {
    const item = outbox.enqueue(testChat.id, undefined, '重试这条', text);
    const body = structuredClone(api.postMessage.mock.calls[0][1]);
    replies[0].error(new Error('offline'));
    await item.operation;
    expect(item.delivery()).toBe(MessageDelivery.Failed);
    const retry = outbox.retry(item);
    expect(outbox.retry(item)).toBe(retry);
    expect(api.postMessage.mock.calls[1][1]).toEqual(body);
    replies[1].next(accepted(1));
    await retry;
    expect(item.delivery()).toBe(MessageDelivery.Sent);
    expect(outbox.items()).toHaveLength(1);
  });
  it('does not POST when an upload fails and keeps its local preview for retry', async () => {
    const media = upload();
    const item = outbox.enqueue(testChat.id, undefined, '', { ...text, uploads: [media.item] });
    media.finish(undefined);
    await item.operation;
    expect(api.postMessage).not.toHaveBeenCalled();
    expect(item.delivery()).toBe(MessageDelivery.Failed);
    expect(item.message().attachments[0].url).toBe(media.item.url);
    expect(media.dispose).not.toHaveBeenCalled();
  });
  it('acknowledges audio over HTTP but retains local playback until its published WebSocket event', async () => {
    const item = outbox.enqueue(testChat.id, undefined, '', {
      messageType: MessageType.audio,
      attachmentIds: [encodeId('7')],
    });
    const local = item.message();
    const response = { ...accepted(), messageType: MessageType.audio };
    replies[0].next(response);
    await item.operation;
    expect(item.delivery()).toBe(MessageDelivery.Sent);
    expect(item.published()).toBe(false);
    expect(item.message()).toEqual(local);
    const published = { ...response, message: '音频已发布' };
    live.next(published);
    expect(item.message()).toBe(published);
    expect(item.published()).toBe(true);
  });
  it('does not overwrite an early audio publication with the later creation response', async () => {
    const item = outbox.enqueue(testChat.id, undefined, '', {
      messageType: MessageType.audio,
      attachmentIds: [encodeId('7')],
    });
    const response = { ...accepted(), messageType: MessageType.audio };
    const published = { ...response, message: '发布后信息' };
    live.next(published);
    replies[0].next(response);
    await item.operation;
    expect(item.message()).toBe(published);
  });
  it('checks acknowledged audio once on reconnect without turning a 404 into send failure', async () => {
    const item = outbox.enqueue(testChat.id, undefined, '', {
      messageType: MessageType.audio,
      attachmentIds: [encodeId('7')],
    });
    const response = { ...accepted(), messageType: MessageType.audio };
    replies[0].next(response);
    await item.operation;
    const lookup = new Subject<MessageResponse>();
    api.getMessage.mockReturnValue(lookup);
    resync.next();
    expect(api.getMessage).toHaveBeenCalledWith(testChat.id, response.id);
    lookup.error(new Error('404'));
    await Promise.resolve();
    expect(item.delivery()).toBe(MessageDelivery.Sent);
    expect(item.published()).toBe(false);
    const success = new Subject<MessageResponse>();
    api.getMessage.mockReturnValue(success);
    resync.next();
    success.next(response);
    await vi.waitFor(() => expect(item.published()).toBe(true));
  });
  it('keeps topic requests separate and cancels queued uploads when the account changes', async () => {
    const topic = outbox.enqueue(testChat.id, encodeId('9'), '话题', text);
    expect(api.postThreadMessage.mock.calls[0].slice(0, 2)).toEqual([testChat.id, encodeId('9')]);
    replies[0].next({ ...testMessage, clientGeneratedId: topic.clientGeneratedId, replyRootId: encodeId('9') });
    await topic.operation;
    const media = upload();
    const pending = outbox.enqueue(testChat.id, undefined, '', { ...text, uploads: [media.item] });
    session.user.set(undefined);
    TestBed.tick();
    expect(outbox.items()).toEqual([]);
    expect(media.dispose).toHaveBeenCalledOnce();
    media.finish(encodeId('7'));
    await pending.operation;
    expect(api.postMessage).not.toHaveBeenCalled();
  });
});
