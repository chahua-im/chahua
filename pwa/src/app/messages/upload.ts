import { computed, inject, Service, signal } from '@angular/core';
import { AsyncSubject, defer, share, type Observable, firstValueFrom, from, fromEvent, takeUntil, timeout } from 'rxjs';
import { RpcApi } from '../../generated/rpc-api';
import { AttachmentUploadPurpose, type AttachmentConfigResponse, type SnowflakeID } from '../../generated/models';
import { SessionStore } from '../session/session-store';
import { prepareMedia } from './media-processing/prepare-media';
import { detectFileMimeType, normalizeMimeType, withDetectedMimeType } from './media-processing/file-type';
import { Diagnostics, type DiagnosticDetails } from '../pwa/diagnostics';
import {
  StorageUploadError,
  UploadError,
  UploadErrorCode,
  UploadStage,
  uploadFailure,
  type UploadFailure,
} from './upload-error';

const IDLE_TIMEOUT = 30_000;

export enum UploadStatus {
  Processing,
  Uploading,
  Ready,
  Failed,
}

@Service()
export class AttachmentUploads {
  private readonly api = inject(RpcApi);
  private readonly diagnostics = inject(Diagnostics);
  private readonly session = inject(SessionStore);
  private readonly uid = computed(() => this.session.user()?.uid);
  private readonly config = computed(() => {
    this.uid();
    return defer(() => this.api.attachments.getConfig()).pipe(
      timeout(IDLE_TIMEOUT),
      share({ connector: () => new AsyncSubject<AttachmentConfigResponse>(), resetOnComplete: false }),
    );
  });

  create(file: File, purpose: AttachmentUploadPurpose) {
    return new AttachmentUpload(this.api, file, purpose, this.diagnostics, this.config());
  }
}

export class AttachmentUpload {
  readonly url: string;
  private readonly uploadState = signal<{
    status: UploadStatus;
    progress?: number;
    id?: SnowflakeID;
    width?: number;
    height?: number;
    contentType?: string;
    error?: UploadFailure;
  }>({ status: UploadStatus.Processing });
  readonly state = this.uploadState.asReadonly();
  private readonly controller = new AbortController();
  private prepared?: Awaited<ReturnType<typeof prepareMedia>>;
  private pending?: Promise<SnowflakeID | undefined>;
  private timer?: ReturnType<typeof setTimeout>;
  private retryDelay = 1_000;
  private attempt = 0;
  private lastFailureDetails?: DiagnosticDetails;
  private reconnect = false;
  retryable = true;
  private readonly online = () => {
    if (!this.retryable) return;
    this.reconnect = !!this.pending;
    void this.retry();
  };

  constructor(
    private readonly api: RpcApi,
    readonly file: File,
    readonly purpose: AttachmentUploadPurpose,
    private readonly diagnostics: Diagnostics,
    private readonly config: Observable<AttachmentConfigResponse>,
  ) {
    this.url = URL.createObjectURL(file);
    window.addEventListener('online', this.online);
    void this.retry();
  }

  retry(): Promise<SnowflakeID | undefined> {
    if (this.controller.signal.aborted) return Promise.resolve(undefined);
    if (this.state().status === UploadStatus.Ready) return Promise.resolve(this.state().id);
    if (this.state().error?.canRetry === false) return Promise.resolve(undefined);
    if (this.pending) return this.pending;
    clearTimeout(this.timer);
    this.retryable = true;
    this.pending = this.run().finally(() => {
      this.pending = undefined;
      if (!this.controller.signal.aborted && this.state().status === UploadStatus.Failed && this.retryable) {
        this.diagnostics.record('upload.retry.scheduled', {
          ...this.diagnosticDetails(),
          reconnectInMs: this.reconnect ? 0 : this.retryDelay,
        });
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
    window.removeEventListener('online', this.online);
    if (this.state().status !== UploadStatus.Ready)
      this.uploadState.update((state) => ({ ...state, status: UploadStatus.Failed }));
    URL.revokeObjectURL(this.url);
  }

  diagnosticDetails(): DiagnosticDetails {
    return this.lastFailureDetails ?? this.attemptDetails();
  }

  private attemptDetails(): DiagnosticDetails {
    const { progress } = this.state();
    const file = this.prepared?.file ?? this.file;
    return {
      operation: 'attachment.upload',
      uploadId: this.url.slice(this.url.lastIndexOf('/') + 1),
      purpose: this.purpose,
      attempt: this.attempt,
      fileSizeBytes: this.file.size,
      uploadSizeBytes: file.size,
      contentType: file.type || 'application/octet-stream',
      progress,
    };
  }

  private async run(): Promise<SnowflakeID | undefined> {
    const signal = this.controller.signal;
    const aborted = fromEvent(signal, 'abort');
    const processing = this.purpose === AttachmentUploadPurpose.media && !this.prepared;
    this.uploadState.update((state) => ({
      ...state,
      status: processing ? UploadStatus.Processing : UploadStatus.Uploading,
      progress: undefined,
    }));
    const progress = (progress: number) => {
      if (!signal.aborted) this.uploadState.update((state) => ({ ...state, progress }));
    };
    let stage = UploadStage.Config;
    const startedAt = Date.now();
    this.attempt++;
    const changeStage = (next: UploadStage) => {
      stage = next;
      this.diagnostics.record('upload.stage', {
        ...this.attemptDetails(),
        state: stage,
        durationMs: Date.now() - startedAt,
      });
    };
    changeStage(stage);
    let maximumSize: number | undefined;
    try {
      if (!this.file.size) throw new UploadError(UploadErrorCode.Empty);
      if (!this.file.name.trim()) throw new UploadError(UploadErrorCode.FilenameMissing);
      if (Array.from(this.file.name).length > 255) throw new UploadError(UploadErrorCode.FilenameTooLong);
      const config = await firstValueFrom(this.config.pipe(takeUntil(aborted)));
      maximumSize = config.maxFileSizeBytes;
      signal.throwIfAborted();
      if (processing) {
        changeStage(UploadStage.Processing);
        this.prepared = await firstValueFrom(from(prepareMedia(this.file, signal, progress)).pipe(takeUntil(aborted)));
        signal.throwIfAborted();
      }
      if (
        this.purpose === AttachmentUploadPurpose.file &&
        !this.prepared &&
        (!this.file.type || normalizeMimeType(this.file.type) === 'application/octet-stream')
      ) {
        changeStage(UploadStage.Processing);
        const contentType = await firstValueFrom(
          from(detectFileMimeType(this.file)).pipe(timeout(IDLE_TIMEOUT), takeUntil(aborted)),
        );
        signal.throwIfAborted();
        this.prepared = { file: withDetectedMimeType(this.file, contentType) };
        this.uploadState.update((state) => ({ ...state, contentType }));
      }
      const { file, dimensions } = this.prepared ?? { file: this.file, dimensions: undefined };
      changeStage(UploadStage.Signing);
      if (file.size > config.maxFileSizeBytes) {
        throw new UploadError(UploadErrorCode.TooLarge);
      }
      this.uploadState.update((state) => ({
        ...state,
        ...dimensions,
        status: UploadStatus.Uploading,
        progress: undefined,
      }));
      const response = await firstValueFrom(
        this.api.attachments
          .createUploadUrl({
            filename: file.name,
            contentType: file.type || 'application/octet-stream',
            size: file.size,
            purpose: this.purpose,
            ...dimensions,
          })
          .pipe(timeout(IDLE_TIMEOUT), takeUntil(aborted)),
      );
      signal.throwIfAborted();
      changeStage(UploadStage.Storage);
      progress(0);
      await uploadBlob(response.uploadUrl, file, response.uploadHeaders, signal, progress);
      signal.throwIfAborted();
      this.uploadState.update((state) => ({
        ...state,
        id: response.attachmentId,
        status: UploadStatus.Ready,
        progress: 1,
        error: undefined,
      }));
      this.lastFailureDetails = undefined;
      this.retryDelay = 1_000;
      this.diagnostics.record('upload.ready', {
        ...this.diagnosticDetails(),
        state: stage,
        durationMs: Date.now() - startedAt,
      });
      return response.attachmentId;
    } catch (error) {
      if (!this.controller.signal.aborted) {
        const failure = uploadFailure(error, stage, maximumSize);
        this.lastFailureDetails = {
          ...this.attemptDetails(),
          state: failure.stage,
          reason: failure.code,
          errorCode: failure.rpcCode,
          errorStatus: failure.storage?.status,
          storageCode: failure.storage?.code,
          ...(failure.storage?.requestId ? { requestId: failure.storage.requestId } : {}),
          autoRetry: failure.autoRetry,
          canRetry: failure.canRetry,
        };
        this.retryable = failure.autoRetry;
        this.uploadState.update((state) => ({ ...state, status: UploadStatus.Failed, error: failure }));
        this.diagnostics.recordError('upload.failed', error, {
          ...this.diagnosticDetails(),
          maxFileSizeBytes: maximumSize,
          durationMs: Date.now() - startedAt,
        });
      }
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
    let sent = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
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
        finish(new UploadError(sent ? UploadErrorCode.StorageResponseTimeout : UploadErrorCode.TransferStalled));
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
    xhr.upload.onload = () => {
      sent = true;
    };
    xhr.onload = () =>
      finish(xhr.status >= 200 && xhr.status < 300 ? undefined : new StorageUploadError(xhr.status, xhr.responseText));
    xhr.onerror = () => finish(new UploadError(UploadErrorCode.Network));
    xhr.onabort = () => finish(new DOMException('上传取消', 'AbortError'));
    if (signal?.aborted) {
      finish(new DOMException('上传取消', 'AbortError'));
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    activity();
    xhr.send(blob);
  });
}
