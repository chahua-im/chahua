import { signal } from '@angular/core';
import { firstValueFrom, from, fromEvent, takeUntil, timeout } from 'rxjs';
import { AttachmentsService } from '../../generated/endpoints/attachments/attachments.service';
import { AttachmentUploadPurpose, type SnowflakeID } from '../../generated/models';
import { prepareMedia } from './media-processing/prepare-media';

const IDLE_TIMEOUT = 30_000;

export enum UploadStatus {
  Processing,
  Uploading,
  Ready,
  Failed,
}

export class AttachmentUpload {
  readonly url: string;
  private readonly uploadState = signal<{
    status: UploadStatus;
    progress: number;
    id?: SnowflakeID;
    width?: number;
    height?: number;
  }>({ status: UploadStatus.Processing, progress: 0 });
  readonly state = this.uploadState.asReadonly();
  private readonly controller = new AbortController();
  private prepared?: Awaited<ReturnType<typeof prepareMedia>>;
  private pending?: Promise<SnowflakeID | undefined>;
  private attempt?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private retryDelay = 1_000;
  private reconnect = false;
  retryable = true;
  private readonly offline = () => this.attempt?.abort();
  private readonly online = () => {
    if (!this.retryable) return;
    this.reconnect = !!this.pending;
    void this.retry();
  };

  constructor(
    private readonly api: AttachmentsService,
    readonly file: File,
    readonly purpose: AttachmentUploadPurpose,
  ) {
    this.url = URL.createObjectURL(file);
    window.addEventListener('offline', this.offline);
    window.addEventListener('online', this.online);
    void this.retry();
  }

  retry(): Promise<SnowflakeID | undefined> {
    if (this.controller.signal.aborted) return Promise.resolve(undefined);
    if (this.state().status === UploadStatus.Ready) return Promise.resolve(this.state().id);
    if (this.pending) return this.pending;
    clearTimeout(this.timer);
    this.retryable = true;
    this.attempt = new AbortController();
    this.pending = this.run().finally(() => {
      this.pending = undefined;
      this.attempt = undefined;
      if (
        !this.controller.signal.aborted &&
        this.state().status === UploadStatus.Failed &&
        this.retryable &&
        navigator.onLine !== false
      ) {
        this.timer = setTimeout(() => void this.retry(), this.reconnect ? 0 : this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
      }
      this.reconnect = false;
    });
    return this.pending;
  }

  dispose() {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    clearTimeout(this.timer);
    window.removeEventListener('offline', this.offline);
    window.removeEventListener('online', this.online);
    if (this.state().status !== UploadStatus.Ready)
      this.uploadState.update((state) => ({ ...state, status: UploadStatus.Failed }));
    URL.revokeObjectURL(this.url);
  }

  private async run(): Promise<SnowflakeID | undefined> {
    const signal = AbortSignal.any([this.controller.signal, this.attempt!.signal]);
    const aborted = fromEvent(signal, 'abort');
    const processing = this.purpose === AttachmentUploadPurpose.media && !this.prepared;
    this.uploadState.update((state) => ({
      ...state,
      status: processing ? UploadStatus.Processing : UploadStatus.Uploading,
      progress: 0,
    }));
    const progress = (progress: number) => {
      if (!signal.aborted) this.uploadState.update((state) => ({ ...state, progress }));
    };
    try {
      if (navigator.onLine === false) throw new Error('Offline');
      const config = await firstValueFrom(this.api.getConfig().pipe(timeout(IDLE_TIMEOUT), takeUntil(aborted)));
      signal.throwIfAborted();
      if (processing) {
        this.prepared = await firstValueFrom(from(prepareMedia(this.file, signal, progress)).pipe(takeUntil(aborted)));
        signal.throwIfAborted();
      }
      const { file, dimensions } = this.prepared ?? { file: this.file, dimensions: undefined };
      if (file.size > config.maxFileSizeBytes) {
        this.retryable = false;
        throw new Error('文件过大');
      }
      this.uploadState.set({ ...dimensions, status: UploadStatus.Uploading, progress: 0 });
      const response = await firstValueFrom(
        this.api
          .postUploadUrl({
            filename: file.name,
            contentType: file.type || 'application/octet-stream',
            size: file.size,
            purpose: this.purpose,
            ...dimensions,
          })
          .pipe(timeout(IDLE_TIMEOUT), takeUntil(aborted)),
      );
      signal.throwIfAborted();
      await uploadBlob(response.uploadUrl, file, response.uploadHeaders, signal, progress);
      signal.throwIfAborted();
      this.uploadState.update((state) => ({
        ...state,
        id: response.attachmentId,
        status: UploadStatus.Ready,
        progress: 1,
      }));
      this.retryDelay = 1_000;
      return response.attachmentId;
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
      this.retryable =
        this.retryable && (status == null || status === 0 || status === 408 || status === 429 || status >= 500);
      if (!this.controller.signal.aborted)
        this.uploadState.update((state) => ({ ...state, status: UploadStatus.Failed }));
      return undefined;
    }
  }
}

export function uploadBlob(
  url: string,
  blob: Blob,
  headers: Record<string, string>,
  signal?: AbortSignal,
  progress?: (value: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    let loaded = 0;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      window.removeEventListener('offline', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      finish(new DOMException('上传取消', 'AbortError'));
      xhr.abort();
    };
    const activity = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        finish(new DOMException('上传无进度超时', 'TimeoutError'));
        xhr.abort();
      }, IDLE_TIMEOUT);
    };
    xhr.upload.onprogress = (event) => {
      if (settled) return;
      // Repeated events reporting the same byte count do not extend a stalled attempt.
      if (event.loaded > loaded) {
        loaded = event.loaded;
        activity();
      }
      if (event.lengthComputable) progress?.(event.loaded / event.total);
    };
    xhr.onload = () =>
      finish(
        xhr.status >= 200 && xhr.status < 300
          ? undefined
          : Object.assign(new Error('上传失败'), { status: xhr.status }),
      );
    xhr.onerror = () => finish(new Error('上传失败'));
    xhr.onabort = () => finish(new DOMException('上传取消', 'AbortError'));
    if (signal?.aborted || navigator.onLine === false) {
      finish(new DOMException('上传取消', 'AbortError'));
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    window.addEventListener('offline', abort, { once: true });
    activity();
    xhr.send(blob);
  });
}
