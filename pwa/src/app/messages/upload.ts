import { signal } from '@angular/core';
import { firstValueFrom, from, fromEvent, takeUntil } from 'rxjs';
import { AttachmentsService } from '../../generated/endpoints/attachments/attachments.service';
import { AttachmentUploadPurpose, type SnowflakeID } from '../../generated/models';
import { prepareMedia } from './media-processing/prepare-media';

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

  constructor(
    private readonly api: AttachmentsService,
    readonly file: File,
    readonly purpose: AttachmentUploadPurpose,
  ) {
    this.url = URL.createObjectURL(file);
    void this.retry();
  }

  retry(): Promise<SnowflakeID | undefined> {
    if (this.state().status === UploadStatus.Ready) return Promise.resolve(this.state().id);
    if (this.pending) return this.pending;
    if (this.controller.signal.aborted) return Promise.resolve(undefined);
    this.pending = this.run().finally(() => (this.pending = undefined));
    return this.pending;
  }

  dispose() {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    if (this.state().status !== UploadStatus.Ready)
      this.uploadState.update((state) => ({ ...state, status: UploadStatus.Failed }));
    URL.revokeObjectURL(this.url);
  }

  private async run(): Promise<SnowflakeID | undefined> {
    const signal = this.controller.signal;
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
      const config = await firstValueFrom(this.api.getConfig().pipe(takeUntil(aborted)));
      signal.throwIfAborted();
      if (processing) {
        this.prepared = await firstValueFrom(from(prepareMedia(this.file, signal, progress)).pipe(takeUntil(aborted)));
        signal.throwIfAborted();
      }
      const { file, dimensions } = this.prepared ?? { file: this.file, dimensions: undefined };
      if (file.size > config.maxFileSizeBytes) throw new Error('文件过大');
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
          .pipe(takeUntil(aborted)),
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
      return response.attachmentId;
    } catch {
      if (!signal.aborted) this.uploadState.update((state) => ({ ...state, status: UploadStatus.Failed }));
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
    const abort = () => xhr.abort();
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress?.(event.loaded / event.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('上传失败')));
    xhr.onerror = () => reject(new Error('上传失败'));
    xhr.onabort = () => reject(new DOMException('上传取消', 'AbortError'));
    xhr.onloadend = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) {
      reject(new DOMException('上传取消', 'AbortError'));
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    xhr.send(blob);
  });
}
export async function mediaDimensions(file: File): Promise<{ width?: number; height?: number }> {
  if (!/^(image|video)\//.test(file.type)) return {};
  const url = URL.createObjectURL(file);
  try {
    if (file.type.startsWith('image/')) {
      const image = new Image();
      image.src = url;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    }
    return await new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        resolve({ width: video.videoWidth, height: video.videoHeight });
        video.removeAttribute('src');
        video.load();
      };
      video.onerror = () => reject(new Error('无法读取视频'));
      video.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
