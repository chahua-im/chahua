import { firstValueFrom, from, fromEvent, takeUntil } from 'rxjs';
import { compressImage, compressVideo, type MediaProcessingOptions } from './compression';
import { detectFileMimeType, withDetectedMimeType } from './file-type';
import { UploadError, UploadErrorCode } from '../upload-error';

const PROCESSING_IDLE_TIMEOUT = 30_000;

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await firstValueFrom(from(work).pipe(takeUntil(fromEvent(signal, 'abort'))));
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}

/** Media selections try compression; file attachments preserve their original bytes. */
export async function prepareMedia(source: File, signal: AbortSignal, onProgress?: (value: number) => void) {
  signal.throwIfAborted();
  const controller = new AbortController();
  const processingSignal = AbortSignal.any([signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let progress = 0;
  const activity = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new UploadError(UploadErrorCode.ProcessingTimeout)),
      PROCESSING_IDLE_TIMEOUT,
    );
  };
  activity();
  try {
    return await abortable(
      processMedia(source, processingSignal, {
        onProgress: (value) => {
          if (processingSignal.aborted) return;
          if (value > progress) {
            progress = value;
            activity();
          }
          onProgress?.(value);
        },
        onQueueWait: (waiting) => {
          if (processingSignal.aborted) return;
          if (waiting) clearTimeout(timer);
          else activity();
        },
      }),
      processingSignal,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function processMedia(source: File, signal: AbortSignal, options: MediaProcessingOptions) {
  const file = withDetectedMimeType(source, await detectFileMimeType(source));
  signal.throwIfAborted();
  if (!/^(image|video)\//.test(file.type)) throw new UploadError(UploadErrorCode.UnsupportedMedia);
  const size = await mediaDimensions(file, signal).catch(() => ({}) as { width?: number; height?: number });
  const dimensions = size.width && size.height ? { width: size.width, height: size.height } : undefined;
  signal.throwIfAborted();
  try {
    return await (file.type.startsWith('image/') ? compressImage : compressVideo)(file, dimensions, {
      signal,
      ...options,
    });
  } catch {
    signal.throwIfAborted();
    return { file, dimensions };
  }
}

export async function mediaDimensions(file: File, signal?: AbortSignal): Promise<{ width?: number; height?: number }> {
  signal?.throwIfAborted();
  if (!/^(image|video)\//.test(file.type)) return {};
  const url = URL.createObjectURL(file);
  let image: HTMLImageElement | undefined;
  let video: HTMLVideoElement | undefined;
  try {
    if (file.type.startsWith('image/')) {
      image = new Image();
      image.src = url;
      await (signal ? abortable(image.decode(), signal) : image.decode());
      return { width: image.naturalWidth, height: image.naturalHeight };
    }
    const element = document.createElement('video');
    video = element;
    const metadata = new Promise<{ width?: number; height?: number }>((resolve, reject) => {
      element.preload = 'metadata';
      element.onloadedmetadata = () => {
        resolve({ width: element.videoWidth, height: element.videoHeight });
      };
      element.onerror = () => reject(new Error('无法读取视频'));
      element.src = url;
    });
    return await (signal ? abortable(metadata, signal) : metadata);
  } finally {
    if (image) image.removeAttribute('src');
    if (video) {
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
    }
    URL.revokeObjectURL(url);
  }
}
