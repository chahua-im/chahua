import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { vi } from 'vitest';
import { ChatsService } from '../../generated/endpoints/chats/chats.service';
import {
  AttachmentUploadPurpose,
  MessageType,
  ServerWsMessageType,
  type MessageResponse,
  type ServerWsMessage,
} from '../../generated/models';
import { Connection } from '../api/connection';
import { encodeId } from '../api/snowflake-id';
import { mockRealtime, testChat, testMessage, testUser } from '../api/testing';
import { SessionStore } from '../session/session-store';
import { MessageDelivery } from './message-delivery';
import { MessageOutbox } from './message-outbox';
import { UploadStatus, type AttachmentUpload } from './upload';

describe('MessageOutbox', () => {
  let outbox: MessageOutbox;
  let replies: Subject<MessageResponse>[];
  let live: Subject<MessageResponse>;
  let resync: Subject<void>;
  let events: Subject<ServerWsMessage>;
  let patches: Subject<MessageResponse>[];
  let deletions: Subject<void>[];
  let session: { user: ReturnType<typeof signal<typeof testUser | undefined>> };
  const api = {
    postMessage: vi.fn(),
    postThreadMessage: vi.fn(),
    getMessage: vi.fn(),
    patchMessage: vi.fn(),
    deleteMessage: vi.fn(),
  };
  const text = { messageType: MessageType.text, attachmentIds: [] };
  beforeEach(() => {
    replies = [];
    patches = [];
    deletions = [];
    events = new Subject();
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
    api.patchMessage.mockReset().mockImplementation(() => {
      const response = new Subject<MessageResponse>();
      patches.push(response);
      return response;
    });
    api.deleteMessage.mockReset().mockImplementation(() => {
      const response = new Subject<void>();
      deletions.push(response);
      return response;
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: ChatsService, useValue: api },
        { provide: Connection, useValue: mockRealtime({ messages$: live, resync$: resync, events$: events }) },
        { provide: SessionStore, useValue: session },
      ],
    });
    outbox = TestBed.inject(MessageOutbox);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.restoreAllMocks();
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
      state: signal<{
        status: UploadStatus;
        progress: number;
        width: number;
        height: number;
        id?: ReturnType<typeof encodeId>;
      }>({ status: UploadStatus.Uploading, progress: 0.25, width: 320, height: 200 }),
      retry: vi.fn(() => result),
      dispose: vi.fn(),
    };
    return {
      item: item as unknown as AttachmentUpload,
      finish: (id: ReturnType<typeof encodeId> | undefined) => {
        item.state.update((state) => ({ ...state, id, status: id == null ? UploadStatus.Failed : UploadStatus.Ready }));
        finish(id);
      },
      dispose: item.dispose,
      state: item.state,
    };
  }
  it('publishes a complete local row before confirmation and releases it only after range handoff', async () => {
    const user = {
      ...testUser,
      gender: 2,
      avatarUrl: 'https://example.com/me.jpg',
      userGroup: {
        groupId: 3,
        name: '三水',
        chatGroupColor: '#4087d2',
        chatGroupColorDark: '#72a7de',
      },
    };
    session.user.set(user);
    const item = outbox.enqueue(testChat.id, undefined, '本地消息', text, testMessage);
    expect(item.message()).toMatchObject({
      message: '本地消息',
      sender: {
        uid: user.uid,
        name: user.username,
        gender: user.gender,
        avatarUrl: user.avatarUrl,
        userGroup: user.userGroup,
      },
      replyToMessage: testMessage,
    });
    const updated = {
      ...user,
      username: '新名字',
      avatarUrl: 'https://example.com/new.jpg',
      gender: 1,
      userGroup: { ...user.userGroup, groupId: 4, name: '四水' },
    };
    session.user.set(updated);
    expect(item.message().sender).toMatchObject({
      name: updated.username,
      gender: updated.gender,
      avatarUrl: updated.avatarUrl,
      userGroup: updated.userGroup,
    });
    expect(api.postMessage).toHaveBeenCalledOnce();
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
  it('lets text pass uploading attachments, then queues ready attachments behind an actual create', async () => {
    const media = upload();
    const first = outbox.enqueue(testChat.id, undefined, '', { ...text, uploads: [media.item] });
    const second = outbox.enqueue(testChat.id, undefined, '边传边聊', text);
    expect(api.postMessage).toHaveBeenCalledOnce();
    expect(api.postMessage.mock.calls[0][1].message).toBe('边传边聊');
    expect(first.message().attachments[0]).toMatchObject({ url: 'blob:local-photo', width: 320, height: 200 });
    const other = outbox.enqueue(encodeId('2'), undefined, '另一会话', text);
    expect(api.postMessage).toHaveBeenCalledTimes(2);
    replies[1].next({ ...accepted(1), chatId: encodeId('2') });
    await other.operation;
    media.finish(encodeId('7'));
    await first.operation;
    expect(api.postMessage).toHaveBeenCalledTimes(2);
    replies[0].next(accepted());
    await second.operation;
    await vi.waitFor(() => expect(api.postMessage).toHaveBeenCalledTimes(3));
    expect(api.postMessage.mock.calls[2][1].attachmentIds).toEqual([encodeId('7')]);
    replies[2].next({
      ...accepted(2),
      attachments: [{ id: encodeId('7'), url: '/photo', fileName: 'photo.jpg', kind: 'image/jpeg', size: 4 }],
    });
    await first.operation;
    expect(media.dispose).not.toHaveBeenCalled();
    outbox.release([first.confirmed()!]);
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

  it('lets later messages pass a rejected create and makes manual retry wait for the active ACK', async () => {
    const first = outbox.enqueue(testChat.id, undefined, 'first', text);
    const second = outbox.enqueue(testChat.id, undefined, 'second', text);
    replies[0].error({ status: 400 });
    await first.operation;
    expect(api.postMessage.mock.calls[1][1].message).toBe('second');
    expect(first.delivery()).toBe(MessageDelivery.Failed);
    resync.next();
    expect(first.delivery()).toBe(MessageDelivery.Failed);
    await outbox.retry(first);
    expect(api.postMessage).toHaveBeenCalledTimes(2);
    replies[1].next(accepted(1));
    await second.operation;
    expect(api.postMessage.mock.calls[2][1].message).toBe('first');
    expect(api.postMessage.mock.calls[2][1].clientGeneratedId).toBe(first.clientGeneratedId);
    replies[2].next(accepted(2));
    await first.operation;
  });

  it('makes automatic retry wait behind a newer POST without issuing concurrent creates', async () => {
    vi.useFakeTimers();
    const first = outbox.enqueue(testChat.id, undefined, 'first', text);
    const second = outbox.enqueue(testChat.id, undefined, 'second', text);
    replies[0].error({ status: 503 });
    await first.operation;
    expect(api.postMessage.mock.calls[1][1].message).toBe('second');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.postMessage).toHaveBeenCalledTimes(2);
    replies[1].next(accepted(1));
    await second.operation;
    expect(api.postMessage.mock.calls[2][1].message).toBe('first');
    replies[2].next(accepted(2));
    await first.operation;
  });
  it('edits immediately before POST and drops an unfinished upload without waiting for it', async () => {
    const media = upload();
    const item = outbox.enqueue(testChat.id, undefined, 'old', { ...text, uploads: [media.item] });
    outbox.edit(item, 'new', text);
    expect(item.message().message).toBe('new');
    expect(item.uploads).toEqual([]);
    expect(media.dispose).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(api.postMessage).toHaveBeenCalledOnce());
    expect(api.postMessage.mock.calls[0][1]).toMatchObject({ message: 'new', attachmentIds: [] });
    replies[0].next(accepted());
    await item.operation;
    media.finish(encodeId('7'));
    expect(api.patchMessage).not.toHaveBeenCalled();
  });

  it('freezes a started create across retry, merges edits and patches only after its ACK', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'original', text);
    const body = structuredClone(api.postMessage.mock.calls[0][1]);
    outbox.edit(item, 'edit one', text);
    outbox.edit(item, 'latest edit', text);
    expect(item.message().message).toBe('latest edit');
    replies[0].error({ status: 0 });
    await item.operation;
    const retry = outbox.retry(item);
    expect(api.postMessage.mock.calls[1][1]).toEqual(body);
    expect(api.patchMessage).not.toHaveBeenCalled();
    const created = accepted(1);
    replies[1].next(created);
    await vi.waitFor(() => expect(api.patchMessage).toHaveBeenCalledOnce());
    expect(api.patchMessage.mock.calls[0]).toEqual([
      testChat.id,
      created.id,
      { message: 'latest edit', attachmentIds: [] },
    ]);
    expect(item.message().message).toBe('latest edit');
    patches[0].next({ ...created, message: 'latest edit', isEdited: true });
    await retry;
    expect(item.delivery()).toBe(MessageDelivery.Sent);
  });

  it('allows the next create after a WS ACK even when HTTP and an edit are still pending', async () => {
    const first = outbox.enqueue(testChat.id, undefined, 'first', text);
    const second = outbox.enqueue(testChat.id, undefined, 'second', text);
    outbox.edit(first, 'edited', text);
    live.next(accepted());
    expect(api.postMessage).toHaveBeenCalledTimes(2);
    replies[0].next(accepted());
    await vi.waitFor(() => expect(api.patchMessage).toHaveBeenCalledOnce());
    expect(api.postMessage.mock.calls[1][1].message).toBe('second');
    replies[1].next(accepted(1));
    await second.operation;
    patches[0].next({ ...accepted(), message: 'edited', isEdited: true });
    await first.operation;
  });

  it('coalesces edits on one row, ignores older acknowledgements and releases only the final range', async () => {
    const item = outbox.enqueueEdit(testMessage, undefined, 'one', text);
    expect(outbox.enqueueEdit(testMessage, undefined, 'two', text)).toBe(item);
    outbox.edit(item, 'three', text);
    expect(outbox.items()).toEqual([item]);
    expect(item.message().message).toBe('three');
    const older = { ...testMessage, message: 'one', isEdited: true };
    events.next({ type: ServerWsMessageType.messageUpdated, payload: older });
    patches[0].next(older);
    await vi.waitFor(() => expect(api.patchMessage).toHaveBeenCalledTimes(2));
    expect(api.patchMessage.mock.calls[1][2].message).toBe('three');
    outbox.release([older]);
    expect(outbox.items()).toContain(item);
    const latest = { ...testMessage, message: 'three', isEdited: true };
    events.next({ type: ServerWsMessageType.messageUpdated, payload: latest });
    patches[1].next(latest);
    await item.operation;
    events.next({ type: ServerWsMessageType.messageUpdated, payload: older });
    expect(item.message().message).toBe('three');
    outbox.release([older]);
    expect(outbox.items()).toContain(item);
    outbox.release([latest]);
    expect(outbox.items()).toEqual([]);
  });

  it('retains removed uploads referenced by an uncertain create until its ACK', async () => {
    const media = upload();
    const item = outbox.enqueue(testChat.id, undefined, 'photo', { ...text, uploads: [media.item] });
    media.finish(encodeId('7'));
    await vi.waitFor(() => expect(api.postMessage).toHaveBeenCalledOnce());
    outbox.edit(item, 'text only', text);
    expect(media.dispose).not.toHaveBeenCalled();
    replies[0].error({ status: 0 });
    await item.operation;
    expect(media.dispose).not.toHaveBeenCalled();
    const retry = outbox.retry(item);
    expect(api.postMessage.mock.calls[1][1].attachmentIds).toEqual([encodeId('7')]);
    replies[1].next(accepted(1));
    await vi.waitFor(() => expect(api.patchMessage).toHaveBeenCalledOnce());
    expect(media.dispose).toHaveBeenCalledOnce();
    expect(api.patchMessage.mock.calls[0][2].attachmentIds).toEqual([]);
    patches[0].next({ ...accepted(1), message: 'text only', isEdited: true });
    await retry;
  });

  it.each([UploadStatus.Processing, UploadStatus.Uploading])(
    'immediately cancels attachment work in state %s and lets the next create run',
    async (status) => {
      const media = upload();
      media.state.update((state) => ({ ...state, status }));
      const item = outbox.enqueue(testChat.id, undefined, '', { ...text, uploads: [media.item] });
      const next = outbox.enqueue(testChat.id, undefined, 'next', text);
      await outbox.cancel(item);
      expect(item.cancelled()).toBe(true);
      expect(media.dispose).toHaveBeenCalledOnce();
      expect(api.postMessage.mock.calls[0][1].message).toBe('next');
      expect(api.deleteMessage).not.toHaveBeenCalled();
      replies[0].next(accepted());
      await next.operation;
      media.finish(encodeId('7'));
      await item.operation;
      expect(api.postMessage).toHaveBeenCalledOnce();
    },
  );

  it('deletes on a WS ID independently of the pending POST and retains a hidden tombstone', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'cancel', text);
    const created = accepted();
    await outbox.cancel(item);
    live.next(created);
    expect(api.deleteMessage).toHaveBeenCalledWith(testChat.id, created.id);
    deletions[0].next();
    await outbox.cancel(item);
    replies[0].next(created);
    await item.operation;
    live.next(created);
    outbox.release([created]);
    outbox.release([{ ...created, isDeleted: true }]);
    resync.next();
    await outbox.retry(item);
    expect(outbox.items()).toContain(item);
    expect(item.cancelled()).toBe(true);
    expect(api.postMessage).toHaveBeenCalledOnce();
    expect(api.deleteMessage).toHaveBeenCalledOnce();
  });

  it('keeps an unknown cancellation after timeout and discovers its ID from a normal range', async () => {
    vi.useFakeTimers();
    const item = outbox.enqueue(testChat.id, undefined, 'unknown', text);
    const created = accepted();
    await outbox.cancel(item);
    await vi.advanceTimersByTimeAsync(30_000);
    resync.next();
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(60_000);
    outbox.release([]);
    expect(outbox.items()).toContain(item);
    expect(api.postMessage).toHaveBeenCalledOnce();
    outbox.release([created]);
    expect(api.deleteMessage).toHaveBeenCalledWith(testChat.id, created.id);
    deletions[0].next();
    await outbox.cancel(item);
    expect(item.cancelled()).toBe(true);
  });

  it('waits for audio publication before deleting an acknowledged cancelled create', async () => {
    const item = outbox.enqueue(testChat.id, undefined, '', { messageType: MessageType.audio, attachmentIds: [] });
    const response = { ...accepted(), messageType: MessageType.audio };
    await outbox.cancel(item);
    replies[0].next(response);
    await item.operation;
    expect(item.published()).toBe(false);
    expect(api.deleteMessage).not.toHaveBeenCalled();
    const lookup = new Subject<MessageResponse>();
    api.getMessage.mockReturnValue(lookup);
    resync.next();
    lookup.next(response);
    await vi.waitFor(() => expect(api.deleteMessage).toHaveBeenCalledWith(testChat.id, response.id));
    deletions[0].next();
    await outbox.cancel(item);
    expect(api.postMessage).toHaveBeenCalledOnce();
  });

  it('recovers a timed out POST on resync with the frozen client ID', async () => {
    vi.useFakeTimers();
    const item = outbox.enqueue(testChat.id, undefined, 'retry', text);
    const body = structuredClone(api.postMessage.mock.calls[0][1]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(item.delivery()).toBe(MessageDelivery.Failed);
    expect(replies[0].observed).toBe(false);
    resync.next();
    expect(api.postMessage.mock.calls[1][1]).toEqual(body);
    replies[1].next(accepted(1));
    await item.operation;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.postMessage).toHaveBeenCalledTimes(2);
  });

  it('aborts an offline round and retries on online without losing local content', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'offline', text);
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    await item.operation;
    expect(item.delivery()).toBe(MessageDelivery.Failed);
    expect(replies[0].observed).toBe(false);
    online.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    expect(api.postMessage).toHaveBeenCalledTimes(2);
    replies[1].next(accepted(1));
    await item.operation;
    expect(item.delivery()).toBe(MessageDelivery.Sent);
  });

  it('retries a transient DELETE but stops automatic attempts on a permanent rejection', async () => {
    vi.useFakeTimers();
    const item = outbox.enqueue(testChat.id, undefined, 'cancel', text);
    replies[0].next(accepted());
    await item.operation;
    const cancellation = outbox.cancel(item);
    deletions[0].error({ status: 503 });
    await cancellation;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.deleteMessage).toHaveBeenCalledTimes(2);
    deletions[1].error({ status: 403 });
    await vi.advanceTimersByTimeAsync(60_000);
    resync.next();
    outbox.release([accepted()]);
    expect(api.deleteMessage).toHaveBeenCalledTimes(2);
    expect(item.cancelled()).toBe(true);
    const retry = outbox.retry(item);
    deletions[2].next();
    await retry;
  });

  it('saves an editor opened before handoff using server attachment metadata instead of a disposed blob', async () => {
    const media = upload();
    const item = outbox.enqueue(testChat.id, undefined, 'before', { ...text, uploads: [media.item] });
    media.finish(encodeId('7'));
    await vi.waitFor(() => expect(api.postMessage).toHaveBeenCalledOnce());
    const attachment = {
      id: encodeId('7'),
      url: '/media/published',
      fileName: 'photo.jpg',
      kind: 'image/jpeg',
      size: 4,
    };
    const created = { ...accepted(), attachments: [attachment], hasAttachments: true };
    replies[0].next(created);
    await item.operation;
    outbox.release([created]);
    expect(item.disposed).toBe(true);
    expect(media.dispose).toHaveBeenCalledOnce();
    const edit = outbox.edit(item, 'after', { ...text, uploads: [media.item] });
    expect(edit).not.toBe(item);
    expect(edit.editId).toBe(created.id);
    expect(edit.message().attachments).toEqual([attachment]);
    expect(edit.uploads).toEqual([]);
    expect(api.patchMessage.mock.calls[0][2]).toEqual({ message: 'after', attachmentIds: [attachment.id] });
    patches[0].next({ ...created, message: 'after', isEdited: true });
    await edit.operation;
  });

  it('restores a released item as a cancellation tombstone when an open menu recalls it', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'before', text);
    const created = accepted();
    replies[0].next(created);
    await item.operation;
    outbox.release([created]);
    expect(item.disposed).toBe(true);
    const cancellation = outbox.cancel(item);
    expect(outbox.items()).toContain(item);
    expect(item.cancelled()).toBe(true);
    expect(api.deleteMessage).toHaveBeenCalledWith(testChat.id, created.id);
    deletions[0].next();
    await cancellation;
    outbox.release([{ ...created, isDeleted: true }]);
    live.next(created);
    expect(outbox.items()).toContain(item);
    expect(api.postMessage).toHaveBeenCalledOnce();
  });

  it('disposes newly selected uploads when an edit races with cancellation', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'cancel', text);
    await outbox.cancel(item);
    const fresh = upload();
    outbox.edit(item, 'late edit', { ...text, uploads: [fresh.item] });
    expect(fresh.dispose).toHaveBeenCalledOnce();
    expect(api.patchMessage).not.toHaveBeenCalled();
  });

  it('lets text pass both failed uploads and failed attachment POSTs', async () => {
    const media = upload();
    const item = outbox.enqueue(testChat.id, undefined, 'media', { ...text, uploads: [media.item] });
    media.finish(undefined);
    await item.operation;
    const chatting = outbox.enqueue(testChat.id, undefined, 'chatting', text);
    expect(api.postMessage).toHaveBeenCalledOnce();
    replies[0].next(accepted());
    await chatting.operation;
    const ready = upload();
    ready.finish(encodeId('8'));
    outbox.edit(item, 'media retry', { ...text, uploads: [ready.item] });
    expect(api.postMessage).toHaveBeenCalledTimes(2);
    replies[1].error({ status: 400 });
    await item.operation;
    const queued = outbox.enqueue(testChat.id, undefined, 'can continue', text);
    expect(api.postMessage.mock.calls[2][1].message).toBe('can continue');
    await outbox.retry(item);
    expect(api.postMessage).toHaveBeenCalledTimes(3);
    replies[2].next(accepted(2));
    await queued.operation;
    expect(api.postMessage.mock.calls[3][1].message).toBe('media retry');
    replies[3].next(accepted(3));
    await item.operation;
  });

  it('immediately releases attachments on recall while retaining identity for a late acknowledgement', async () => {
    const media = upload();
    const item = outbox.enqueue(testChat.id, undefined, 'large attachment', { ...text, uploads: [media.item] });
    media.finish(encodeId('7'));
    await vi.waitFor(() => expect(api.postMessage).toHaveBeenCalledOnce());
    await outbox.cancel(item);
    expect(item.uploads).toEqual([]);
    expect(item.message().attachments).toEqual([]);
    expect(item.message().message).toBeUndefined();
    expect(media.dispose).toHaveBeenCalledOnce();
    replies[0].error({ status: 0 });
    await item.operation;
    expect(media.dispose).toHaveBeenCalledOnce();
    expect(outbox.items()).toContain(item);
    expect(item.cancelled()).toBe(true);
    expect(item.clientGeneratedId).toBeTruthy();
  });

  it('continues the latest edit when a late WS update acknowledges a failed earlier PATCH', async () => {
    const item = outbox.enqueueEdit(testMessage, undefined, 'one', text);
    outbox.edit(item, 'two', text);
    patches[0].error({ status: 503 });
    await item.operation;
    expect(item.delivery()).toBe(MessageDelivery.Failed);
    events.next({
      type: ServerWsMessageType.messageUpdated,
      payload: { ...testMessage, message: 'one', isEdited: true },
    });
    expect(api.patchMessage.mock.calls[1][2].message).toBe('two');
    patches[1].next({ ...testMessage, message: 'two', isEdited: true });
    await item.operation;
    expect(item.message().message).toBe('two');
  });

  it('does not revive a permanently rejected edit when a duplicate create echo arrives', async () => {
    const item = outbox.enqueue(testChat.id, undefined, 'created', text);
    replies[0].next(accepted());
    await item.operation;
    outbox.edit(item, 'rejected edit', text);
    patches[0].error({ status: 403 });
    await item.operation;
    live.next(accepted());
    expect(api.patchMessage).toHaveBeenCalledOnce();
    expect(item.delivery()).toBe(MessageDelivery.Failed);
  });
});
