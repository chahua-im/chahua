import { computed, DestroyRef, effect, inject, Service, signal, type Signal, type WritableSignal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, from, fromEvent, merge, Subject, takeUntil, timeout, type Observable } from 'rxjs';
import { ChatsService } from '../../generated/endpoints/chats/chats.service';
import { MessageType, ServerWsMessageType, type CreateMessageBody, type MessageResponse } from '../../generated/models';
import { Connection } from '../api/connection';
import type { SnowflakeID } from '../api/snowflake-id';
import { SessionStore } from '../session/session-store';
import type { Composition } from './message-composer/message-composer';
import { MessageDelivery } from './message-delivery';
import type { MessageContent } from './message/message';
import { UploadStatus, type AttachmentUpload } from './upload';

const REQUEST_TIMEOUT = 30_000;

export interface OutgoingMessage {
  readonly clientGeneratedId: string;
  readonly chatId: SnowflakeID;
  readonly editId?: SnowflakeID;
  readonly threadId?: SnowflakeID;
  readonly message: Signal<MessageContent>;
  readonly uploads: readonly AttachmentUpload[];
  readonly delivery: WritableSignal<MessageDelivery>;
  readonly confirmed: WritableSignal<MessageResponse | undefined>;
  readonly published: WritableSignal<boolean>;
  readonly cancelled: Signal<boolean>;
  readonly body: CreateMessageBody;
  operation?: Promise<void>;
  disposed: boolean;
}

interface Submission {
  body: CreateMessageBody;
  uploads: readonly AttachmentUpload[];
  revision: number;
}
interface Intent extends Submission {
  local: MessageContent;
}
interface Task {
  intent: WritableSignal<Intent>;
  acknowledged: WritableSignal<number>;
  cancelled: WritableSignal<boolean>;
  owned: Set<AttachmentUpload>;
  changed: Subject<void>;
  stopped: Subject<void>;
  ready?: Submission;
  create?: Submission;
  patch?: Submission;
  inflight?: Submission;
  deletion?: Promise<void>;
  deleted?: boolean;
  compacted?: boolean;
  checking?: boolean;
  retryable: boolean;
  reconnect?: boolean;
  retryDelay: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Owns submitted content and uploads independently of the mounted conversation. */
@Service()
export class MessageOutbox {
  private readonly api = inject(ChatsService);
  private readonly connection = inject(Connection);
  private readonly session = inject(SessionStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly pending = signal<OutgoingMessage[]>([]);
  private readonly tasks = new WeakMap<OutgoingMessage, Task>();
  readonly items = this.pending.asReadonly();

  constructor() {
    let owner = this.session.user()?.uid;
    effect(() => {
      const uid = this.session.user()?.uid;
      if (uid !== owner) {
        owner = uid;
        this.clear();
      }
    });
    this.connection.messages$.pipe(takeUntilDestroyed()).subscribe((message) => {
      const item = this.pending().find((item) => !item.editId && this.matches(item, message));
      if (item) this.created(item, message, true);
    });
    this.connection.changes$.pipe(takeUntilDestroyed()).subscribe((event) => {
      for (const item of this.pending()) {
        if (item.chatId !== event.payload.chatId) continue;
        const id = item.editId ?? item.confirmed()?.id;
        const task = this.tasks.get(item)!;
        if (event.type === ServerWsMessageType.messageUpdated && event.payload.id === id) {
          if (task.patch && matchesBody(event.payload, task.patch.body)) {
            this.acknowledge(item, event.payload, task.patch, true);
            this.pump();
          }
          if (item.cancelled()) void this.delete(item);
        } else if (
          (event.type === ServerWsMessageType.messageDeleted && event.payload.id === id) ||
          (event.type === ServerWsMessageType.messagesBulkDeleted &&
            id != null &&
            event.payload.messageIds.includes(id))
        ) {
          task.cancelled.set(true);
          task.deleted = true;
          task.changed.next();
          this.cleanUploads(item);
          this.pump();
        }
      }
    });
    merge(this.connection.resync$, fromEvent(window, 'online'))
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        for (const item of this.pending()) {
          const task = this.tasks.get(item)!;
          const message = item.confirmed();
          if (message && !item.published()) void this.checkPublished(item, message.id);
          if (!task.retryable) continue;
          task.reconnect = !!(item.operation || task.deletion);
          void this.retry(item);
        }
      });
    this.destroyRef.onDestroy(() => this.clear());
  }

  private readonly sender = computed(() => {
    const user = this.session.user();
    return (
      user && {
        uid: user.uid,
        name: user.username,
        gender: user.gender,
        avatarUrl: user.avatarUrl,
        userGroup: user.userGroup,
      }
    );
  });

  enqueue(
    chatId: SnowflakeID,
    threadId: SnowflakeID | undefined,
    text: string,
    composition: Composition,
    replyTo?: MessageResponse,
    replyToId = replyTo?.id,
  ) {
    return this.add(chatId, threadId, {
      body: {
        clientGeneratedId: crypto.randomUUID(),
        messageType: composition.messageType,
        message: composition.messageType === MessageType.text ? text : undefined,
        attachmentIds: [...composition.attachmentIds],
        stickerId: composition.sticker?.id,
        replyToId,
      },
      uploads: [...(composition.uploads ?? [])],
      revision: 0,
      local: {
        sender: this.sender()!,
        createdAt: new Date().toISOString(),
        messageType: composition.messageType,
        mentions: composition.mentions,
        replyToMessage: replyTo && { ...replyTo, mentions: replyTo.mentions ?? [] },
        sticker: composition.sticker,
        attachments: [],
      },
    });
  }

  enqueueEdit(
    original: MessageResponse,
    threadId: SnowflakeID | undefined,
    text: string,
    composition: Composition,
  ): OutgoingMessage {
    const existing = this.pending().find((item) => this.matches(item, original));
    if (existing) {
      this.edit(existing, text, composition);
      return existing;
    }
    composition = existingUploads(composition, original);
    return this.add(
      original.chatId,
      threadId,
      {
        body: {
          clientGeneratedId: original.clientGeneratedId,
          messageType: MessageType.text,
          message: text,
          attachmentIds: [...composition.attachmentIds],
        },
        uploads: [...(composition.uploads ?? [])],
        revision: 0,
        local: {
          ...original,
          isEdited: true,
          mentions: composition.mentions,
          attachments: original.attachments.filter((attachment) => composition.attachmentIds.includes(attachment.id)),
        },
      },
      original,
    );
  }

  edit(item: OutgoingMessage, text: string, composition: Composition): OutgoingMessage {
    if (item.cancelled() || (item.disposed && !item.confirmed())) {
      const owned = this.tasks.get(item)!.owned;
      for (const upload of composition.uploads ?? []) if (!owned.has(upload)) upload.dispose();
      return item;
    }
    if (item.disposed) {
      const original = item.confirmed();
      if (original)
        return this.enqueueEdit(original, item.threadId, text, existingUploads(composition, original, true));
      return item;
    }
    composition = existingUploads(composition, item.confirmed());
    const task = this.tasks.get(item)!;
    const current = item.message();
    const previous = task.intent();
    const uploads = [...(composition.uploads ?? [])];
    for (const upload of uploads) task.owned.add(upload);
    task.intent.set({
      body: { ...previous.body, message: text, attachmentIds: [...composition.attachmentIds] },
      uploads,
      revision: previous.revision + 1,
      local: {
        ...current,
        isEdited: true,
        mentions: composition.mentions,
        attachments: (item.confirmed()?.attachments ?? current.attachments).filter(
          (attachment) => attachment.id != null && composition.attachmentIds.includes(attachment.id),
        ),
      },
    });
    task.changed.next();
    this.cleanUploads(item);
    void this.retry(item);
    return item;
  }

  cancel(item: OutgoingMessage): Promise<void> {
    const task = this.tasks.get(item)!;
    task.cancelled.set(true);
    if (item.disposed) {
      const original = item.confirmed();
      if (!original) return Promise.resolve();
      const existing = this.pending().find((candidate) => this.matches(candidate, original));
      if (existing) return this.cancel(existing);
      // A menu may outlive range handoff. Restore only its tombstone, never its create operation.
      item.disposed = false;
      this.pending.update((items) => [...items, item]);
    }
    task.retryable = true;
    task.changed.next();
    clearTimeout(task.timer);
    this.cleanUploads(item);
    // No POST has started: there can be no server copy or late acknowledgement.
    if (!task.create && !item.editId) this.remove(item);
    this.pump();
    return this.delete(item);
  }

  private add(chatId: SnowflakeID, threadId: SnowflakeID | undefined, initial: Intent, original?: MessageResponse) {
    const intent = signal(initial);
    const acknowledged = signal(-1);
    const confirmed = signal(original);
    const published = signal(!!original);
    const cancelled = signal(false);
    const item: OutgoingMessage = {
      clientGeneratedId: initial.body.clientGeneratedId,
      chatId,
      threadId,
      editId: original?.id,
      get body() {
        return intent().body;
      },
      get uploads() {
        return intent().uploads;
      },
      message: computed(() => {
        const latest = intent();
        const response = confirmed();
        // Audio's HTTP response only acknowledges transcoding; keep its blob until publication.
        if (response && published() && acknowledged() === latest.revision) return response;
        const ids = new Set(latest.local.attachments.map((attachment) => attachment.id));
        return {
          ...latest.local,
          sender: this.sender() ?? latest.local.sender,
          id: published() ? (response?.id ?? latest.local.id) : latest.local.id,
          message: latest.body.message,
          attachments: [
            ...latest.local.attachments,
            ...localAttachments(
              latest.uploads.filter((upload) => upload.state().id == null || !ids.has(upload.state().id)),
            ),
          ],
        };
      }),
      confirmed,
      published,
      cancelled: cancelled.asReadonly(),
      delivery: signal(MessageDelivery.Sending),
      disposed: false,
    };
    this.tasks.set(item, {
      intent,
      acknowledged,
      cancelled,
      owned: new Set(initial.uploads),
      changed: new Subject(),
      stopped: new Subject(),
      retryable: true,
      retryDelay: 1_000,
    });
    this.pending.update((items) => [...items, item]);
    this.pump();
    return item;
  }

  retry(item: OutgoingMessage): Promise<void> {
    if (item.disposed) return Promise.resolve();
    const task = this.tasks.get(item)!;
    clearTimeout(task.timer);
    task.retryable = true;
    if (item.cancelled()) return this.delete(item);
    if (item.operation) return item.operation;
    if (this.needsSend(item)) item.delivery.set(MessageDelivery.Sending);
    this.pump();
    return item.operation ?? Promise.resolve();
  }

  private needsSend(item: OutgoingMessage) {
    const task = this.tasks.get(item)!;
    return !item.disposed && !item.cancelled() && task.acknowledged() < task.intent().revision;
  }

  private pump() {
    const heads = new Map<string, OutgoingMessage>();
    // An attachment may become ready before a younger text POST returns. That POST keeps its slot.
    for (const item of this.pending()) {
      if (
        !item.disposed &&
        !item.cancelled() &&
        !item.editId &&
        !item.confirmed() &&
        item.delivery() !== MessageDelivery.Failed &&
        this.tasks.get(item)!.inflight
      ) {
        heads.set(`${item.chatId}/${item.threadId ?? ''}`, item);
      }
    }
    for (const item of this.pending()) {
      if (item.disposed || item.cancelled() || item.delivery() === MessageDelivery.Failed) continue;
      const task = this.tasks.get(item)!;
      const intent = task.intent();
      if (this.needsSend(item) && (item.confirmed() || !task.create) && task.ready?.revision !== intent.revision) {
        if (intent.uploads.every((upload) => upload.state().status === UploadStatus.Ready)) {
          task.ready = submission(
            intent,
            intent.uploads.map((upload) => upload.state().id!),
          );
        } else if (!item.operation && item.delivery() !== MessageDelivery.Failed) {
          this.run(item, this.prepare(item));
        }
      }
      if (!item.editId && !item.confirmed()) {
        // Uploading/failed uploads do not reserve a slot. Once ready, re-enter this same queue.
        if (!task.create && task.ready?.revision !== intent.revision) continue;
        const key = `${item.chatId}/${item.threadId ?? ''}`;
        const head = heads.get(key);
        if (head && head !== item) continue;
        heads.set(key, item);
      }
      if (!this.needsSend(item) || item.operation || item.delivery() === MessageDelivery.Failed) continue;
      this.run(item, this.send(item));
    }
  }

  private run(item: OutgoingMessage, operation: Promise<void>) {
    item.operation = operation.finally(() => {
      item.operation = undefined;
      this.cleanUploads(item);
      if (item.cancelled()) void this.delete(item);
      this.pump();
    });
  }

  private async prepare(item: OutgoingMessage) {
    const task = this.tasks.get(item)!;
    while (this.needsSend(item)) {
      const intent = task.intent();
      const ids = await firstValueFrom(
        from(Promise.all(intent.uploads.map((upload) => upload.retry()))).pipe(
          takeUntil(merge(task.changed, task.stopped)),
        ),
        { defaultValue: [] },
      );
      if (!this.needsSend(item)) return;
      if (intent !== task.intent()) continue;
      if (ids.some((id) => id == null)) {
        task.retryable = intent.uploads.every((upload) => upload.retryable !== false);
        item.delivery.set(MessageDelivery.Failed);
        this.schedule(item);
      } else {
        task.ready = submission(intent, ids as SnowflakeID[]);
      }
      return;
    }
  }

  private async send(item: OutgoingMessage) {
    const task = this.tasks.get(item)!;
    const submitted = (!item.confirmed() && task.create) || task.ready!;
    try {
      if (navigator.onLine === false) throw new Error('Offline');
      const id = item.editId ?? item.confirmed()?.id;
      task.inflight = submitted;
      if (id == null) task.create = submitted;
      else task.patch = submitted;
      const response = await this.request(
        item,
        id != null
          ? this.api.patchMessage(item.chatId, id, {
              message: submitted.body.message!,
              attachmentIds: submitted.body.attachmentIds,
            })
          : item.threadId != null
            ? this.api.postThreadMessage(item.chatId, item.threadId, submitted.body)
            : this.api.postMessage(item.chatId, submitted.body),
      );
      if (item.disposed) return;
      if (id == null) {
        this.created(item, response, submitted.body.messageType !== MessageType.audio);
        if (!item.cancelled() && item.published() && task.acknowledged() === submitted.revision) {
          this.connection.accept(item.confirmed()!);
        }
      } else {
        const accepted = this.acknowledge(item, response, submitted, true);
        if (accepted && !item.cancelled()) {
          this.connection.acceptChange({ type: ServerWsMessageType.messageUpdated, payload: item.confirmed()! });
        }
      }
      if (!item.cancelled()) {
        task.retryDelay = 1_000;
        task.retryable = true;
      }
    } catch (error) {
      if (!this.needsSend(item)) return;
      // A WS acknowledgement wins over failed HTTP; pump will submit any newer edit.
      if (task.inflight && task.acknowledged() >= task.inflight.revision) return;
      item.delivery.set(MessageDelivery.Failed);
      task.retryable = task.retryable && retryable(error);
      this.schedule(item);
    } finally {
      task.inflight = undefined;
      this.cleanUploads(item);
    }
  }

  private created(item: OutgoingMessage, message: MessageResponse, published: boolean) {
    const task = this.tasks.get(item)!;
    if (item.disposed || !task.create) return;
    this.acknowledge(item, message, task.create, published);
    if (item.cancelled()) void this.delete(item);
    this.pump();
  }

  private acknowledge(item: OutgoingMessage, message: MessageResponse, submission: Submission, published: boolean) {
    const task = this.tasks.get(item)!;
    if (submission.revision < task.acknowledged() || (submission.revision === task.acknowledged() && item.published()))
      return false;
    item.confirmed.set(item.cancelled() ? tombstone(message) : message);
    task.acknowledged.set(submission.revision);
    if (published) item.published.set(true);
    if (!this.needsSend(item)) item.delivery.set(MessageDelivery.Sent);
    else item.delivery.set(MessageDelivery.Sending);
    if (!item.cancelled()) clearTimeout(task.timer);
    return true;
  }

  private delete(item: OutgoingMessage): Promise<void> {
    const task = this.tasks.get(item)!;
    const message = item.confirmed();
    if (task.deletion) return task.deletion;
    if (item.disposed || !item.cancelled() || task.deleted || !task.retryable || !message || !item.published())
      return Promise.resolve();
    task.deletion = (async () => {
      try {
        await this.request(item, this.api.deleteMessage(item.chatId, message.id));
      } catch (error) {
        if (item.disposed || task.deleted) return;
        // Missing or already deleted is success; other 4xx require intervention.
        const status = errorStatus(error);
        if (status !== 404 && status !== 410) {
          task.retryable = retryable(error);
          item.delivery.set(MessageDelivery.Failed);
          this.schedule(item);
          return;
        }
      }
      if (item.disposed) return;
      task.deleted = true;
      item.delivery.set(MessageDelivery.Sent);
      this.connection.acceptChange({
        type: ServerWsMessageType.messageDeleted,
        payload: {
          ...message,
          isDeleted: true,
          message: undefined,
          attachments: [],
          hasAttachments: false,
          sticker: undefined,
          reactions: [],
        },
      });
    })().finally(() => {
      task.deletion = undefined;
    });
    return task.deletion;
  }

  private schedule(item: OutgoingMessage) {
    const task = this.tasks.get(item)!;
    clearTimeout(task.timer);
    if (!task.retryable || item.disposed || navigator.onLine === false) return;
    task.timer = setTimeout(() => void this.retry(item), task.reconnect ? 0 : task.retryDelay);
    task.reconnect = false;
    task.retryDelay = Math.min(task.retryDelay * 2, 30_000);
  }

  private request<T>(item: OutgoingMessage, request: Observable<T>) {
    return firstValueFrom(
      request.pipe(
        timeout(REQUEST_TIMEOUT),
        takeUntil(merge(this.tasks.get(item)!.stopped, fromEvent(window, 'offline'))),
        takeUntilDestroyed(this.destroyRef),
      ),
    );
  }

  private async checkPublished(item: OutgoingMessage, id: SnowflakeID) {
    const task = this.tasks.get(item)!;
    if (task.checking) return;
    task.checking = true;
    try {
      const message = await this.request(item, this.api.getMessage(item.chatId, id));
      if (item.disposed || item.published()) return;
      this.created(item, message, true);
      if (!item.cancelled()) this.connection.accept(message);
    } catch {
      // Audio returns 404 during transcoding; retain its ACK and local playback for the next resync.
    } finally {
      task.checking = false;
    }
  }

  /** Normal range responses also discover IDs for cancelled creates whose ACK was lost. */
  release(messages: readonly MessageResponse[]) {
    for (const item of this.pending()) {
      const message = messages.find((message) => this.matches(item, message));
      if (!message) continue;
      const task = this.tasks.get(item)!;
      if (item.cancelled()) {
        if (message.isDeleted) {
          task.deleted = true;
          this.cleanUploads(item);
        } else {
          this.created(item, message, true);
          void this.delete(item);
        }
      } else if (item.published() && !this.needsSend(item) && matchesBody(message, item.confirmed()!)) {
        this.remove(item);
      }
    }
  }

  private matches(item: OutgoingMessage, message: MessageResponse) {
    return (
      item.chatId === message.chatId &&
      item.message().sender.uid === message.sender.uid &&
      (item.clientGeneratedId === message.clientGeneratedId || (item.editId ?? item.confirmed()?.id) === message.id)
    );
  }

  private cleanUploads(item: OutgoingMessage) {
    const task = this.tasks.get(item)!;
    const keep = new Set(
      item.cancelled() || item.disposed
        ? []
        : [
            ...item.uploads,
            ...(task.inflight?.uploads ?? []),
            ...(!item.confirmed() ? (task.create?.uploads ?? []) : []),
          ],
    );
    for (const upload of task.owned) {
      if (keep.has(upload)) continue;
      upload.dispose();
      task.owned.delete(upload);
    }
    if (item.cancelled() && !task.compacted) {
      task.compacted = true;
      const intent = task.intent();
      const body = { clientGeneratedId: item.clientGeneratedId, messageType: intent.body.messageType };
      task.intent.set({
        body,
        revision: intent.revision,
        uploads: [],
        local: {
          sender: intent.local.sender,
          createdAt: intent.local.createdAt,
          messageType: body.messageType,
          attachments: [],
        },
      });
      task.ready = undefined;
      if (task.create) task.create = { body, revision: task.create.revision, uploads: [] };
      task.patch = undefined;
      const confirmed = item.confirmed();
      if (confirmed) item.confirmed.set(tombstone(confirmed));
      // The request body contains attachment IDs; the active round no longer needs local files.
      if (task.inflight) task.inflight.uploads = [];
    }
  }

  private remove(item: OutgoingMessage) {
    item.disposed = true;
    const task = this.tasks.get(item)!;
    clearTimeout(task.timer);
    task.stopped.next();
    this.cleanUploads(item);
    this.pending.update((items) => items.filter((candidate) => candidate !== item));
  }

  private clear() {
    for (const item of this.pending()) this.remove(item);
  }
}

function matchesBody(
  message: MessageResponse,
  body: Pick<CreateMessageBody, 'message' | 'attachmentIds'> | MessageResponse,
) {
  const ids = 'attachments' in body ? body.attachments.map((attachment) => attachment.id) : (body.attachmentIds ?? []);
  return (
    message.message === body.message &&
    message.attachments.length === ids.length &&
    message.attachments.every((attachment) => ids.includes(attachment.id))
  );
}
function errorStatus(error: unknown) {
  return error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
}
function retryable(error: unknown) {
  const status = errorStatus(error);
  return status == null || status === 0 || status === 408 || status === 429 || status >= 500;
}
function localAttachments(uploads: readonly AttachmentUpload[]) {
  return uploads.map((upload) => {
    const state = upload.state();
    return {
      url: upload.url,
      fileName: upload.file.name,
      kind: upload.file.type,
      size: upload.file.size,
      width: state.width,
      height: state.height,
    };
  });
}

/** Borrowed uploads already owned by a server attachment no longer need a blob URL. */
function existingUploads(composition: Composition, original?: MessageResponse, disposed = false): Composition {
  const ids = new Set(composition.attachmentIds);
  const uploads = (composition.uploads ?? []).filter((upload) => {
    const id = upload.state().id;
    if (id == null || (!disposed && !original?.attachments.some((attachment) => attachment.id === id))) return true;
    ids.add(id);
    return false;
  });
  return { ...composition, attachmentIds: [...ids], uploads };
}

function submission(intent: Intent, ids: SnowflakeID[]): Submission {
  return {
    revision: intent.revision,
    uploads: intent.uploads,
    body: { ...intent.body, attachmentIds: [...new Set([...(intent.body.attachmentIds ?? []), ...ids])] },
  };
}

function tombstone(message: MessageResponse): MessageResponse {
  return {
    ...message,
    message: undefined,
    attachments: [],
    hasAttachments: false,
    mentions: undefined,
    reactions: [],
    replyToMessage: undefined,
    sticker: undefined,
  };
}
