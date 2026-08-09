import { isHeicLikeMedia } from '@/types/attachmentKind';
import { isAnimatedImageFile } from '@/utils/animatedImage';

interface Dimensions {
  width: number;
  height: number;
}

interface MediaProcessingOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

interface CompressedMedia {
  file: File;
  dimensions?: Dimensions;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function appendFileExtension(fileName: string, extension: string) {
  return `${fileName}${extension}`;
}

const MAX_MEDIA_DIMENSION = 1280;
const VIDEO_COMPRESSION_RATIO = 0.5;
const IMAGE_COMPRESSION_RATIO = 0.75;
const IMAGE_EXPORT_FORMATS = [
  { type: 'image/avif', quality: 0.6, extension: '.avif' },
  { type: 'image/webp', quality: 0.6, extension: '.webp' },
  { type: 'image/jpeg', quality: 0.8, extension: '.jpg' },
] as const;

function calculateTargetVideoDimensions(
  width: number,
  height: number,
  max = MAX_MEDIA_DIMENSION,
): { width?: number; height?: number } {
  if (width <= max && height <= max) {
    return {};
  }

  return width > height ? { width: max } : { height: max };
}

const ceilToMultipleOfTwo = (value: number) => (value % 2 === 0 ? value : value + 1);

function calculateOutputVideoDimensions(
  originalWidth: number,
  originalHeight: number,
  target: { width?: number; height?: number },
): Dimensions {
  const aspectRatio = originalWidth / originalHeight;

  if (target.width !== undefined) {
    const width = ceilToMultipleOfTwo(target.width);
    return { width, height: ceilToMultipleOfTwo(Math.round(width / aspectRatio)) };
  }

  if (target.height !== undefined) {
    const height = ceilToMultipleOfTwo(target.height);
    return { width: ceilToMultipleOfTwo(Math.round(height * aspectRatio)), height };
  }

  return {
    width: ceilToMultipleOfTwo(originalWidth),
    height: ceilToMultipleOfTwo(originalHeight),
  };
}

export async function compressVideo(
  file: File,
  dimensions?: Dimensions,
  { signal, onProgress }: MediaProcessingOptions = {},
): Promise<CompressedMedia> {
  if (!dimensions) return { file };

  const targetDimensions = calculateTargetVideoDimensions(dimensions.width, dimensions.height);

  try {
    const {
      ALL_FORMATS,
      BlobSource,
      BufferTarget,
      Conversion,
      getFirstEncodableVideoCodec,
      Input,
      Mp4OutputFormat,
      Output,
      Quality,
    } = await import('mediabunny');

    throwIfAborted(signal);
    const codec = await getFirstEncodableVideoCodec(['hevc', 'av1', 'vp9', 'avc', 'vp8'], {
      ...targetDimensions,
      quality: new Quality('low'),
    });
    throwIfAborted(signal);
    if (!codec) return { file, dimensions };

    const target = new BufferTarget();
    const conversion = await Conversion.init({
      input: new Input({ source: new BlobSource(file), formats: ALL_FORMATS }),
      output: new Output({ format: new Mp4OutputFormat(), target }),
      tracks: 'primary',
      video: { codec, ...targetDimensions, quality: new Quality('low') },
      audio: { quality: new Quality('low') },
      showWarnings: false,
    });

    if (conversion.discardedTracks.length > 0) {
      console.warn('[upload:compression] Video compression skipped, conversion would drop tracks', {
        discarded: conversion.discardedTracks.map(({ track, reason }) => ({ type: track.type, reason })),
      });
      return { file, dimensions };
    }

    conversion.onProgress = onProgress;
    const abortHandler = () => {
      void conversion.cancel();
    };
    signal?.addEventListener('abort', abortHandler);

    try {
      throwIfAborted(signal);
      await conversion.execute();
    } finally {
      signal?.removeEventListener('abort', abortHandler);
    }

    throwIfAborted(signal);
    const buffer = target.buffer;
    if (!buffer || buffer.byteLength >= file.size * VIDEO_COMPRESSION_RATIO) {
      return { file, dimensions };
    }

    const outputDimensions = calculateOutputVideoDimensions(dimensions.width, dimensions.height, targetDimensions);
    return {
      file: new File([buffer], appendFileExtension(file.name, '.mp4'), { type: 'video/mp4' }),
      dimensions: outputDimensions,
    };
  } catch (error) {
    throwIfAborted(signal);
    console.warn('[upload:compression] Video compression skipped/failed', error);
    return { file, dimensions };
  }
}

function calculateTargetImageDimensions(width: number, height: number, max = MAX_MEDIA_DIMENSION): Dimensions {
  if (width <= max && height <= max) {
    return { width, height };
  }

  const scale = max / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

let heicToModulePromise: Promise<typeof import('heic-to/csp')> | undefined;
let heicConversionTail = Promise.resolve();

function loadHeicTo() {
  heicToModulePromise ??= import('heic-to/csp');
  return heicToModulePromise;
}

function runHeicConversion<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const guardedOperation = () => {
    throwIfAborted(signal);
    return operation();
  };
  const result = heicConversionTail.then(guardedOperation);
  heicConversionTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const heicSourceConversions = new Map<string, Promise<Blob>>();

export function convertHeicSourceToWebpBlob(src: string) {
  const cached = heicSourceConversions.get(src);
  if (cached) return cached;

  const conversion = runHeicConversion(async () => {
    const response = await fetch(src);
    if (!response.ok) {
      throw new Error(`Failed to load HEIC media: ${response.status}`);
    }
    const { heicTo } = await loadHeicTo();
    return heicTo({ blob: await response.blob(), type: 'image/webp', quality: 0.8 });
  });

  heicSourceConversions.set(src, conversion);
  const clearConversion = () => {
    heicSourceConversions.delete(src);
  };
  void conversion.then(clearConversion, clearConversion);
  return conversion;
}

async function compressImageSource(
  file: File,
  source: File | ImageBitmap,
  sourceDimensions: Dimensions,
  { signal, onProgress }: MediaProcessingOptions = {},
): Promise<CompressedMedia> {
  throwIfAborted(signal);

  const outputDimensions = calculateTargetImageDimensions(sourceDimensions.width, sourceDimensions.height);
  const isFileSource = source instanceof File;
  const bitmap = isFileSource
    ? await createImageBitmap(source, {
        imageOrientation: 'from-image',
        resizeWidth: outputDimensions.width,
        resizeHeight: outputDimensions.height,
        resizeQuality: 'high',
      })
    : source;

  const canvas = new OffscreenCanvas(outputDimensions.width, outputDimensions.height);
  try {
    throwIfAborted(signal);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create image compression canvas');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, outputDimensions.width, outputDimensions.height);
  } finally {
    bitmap.close();
  }
  onProgress?.(0.5);

  for (const format of IMAGE_EXPORT_FORMATS) {
    throwIfAborted(signal);
    try {
      const blob = await canvas.convertToBlob({ type: format.type, quality: format.quality });
      if (blob.type !== format.type) continue;

      throwIfAborted(signal);
      onProgress?.(1);
      if (!isFileSource || blob.size < file.size * IMAGE_COMPRESSION_RATIO) {
        return {
          file: new File([blob], appendFileExtension(file.name, format.extension), { type: blob.type }),
          dimensions: outputDimensions,
        };
      }
      break;
    } catch (error) {
      throwIfAborted(signal);
      console.debug('[upload:compression] Image format unavailable', { type: format.type, error });
    }
  }

  return { file, dimensions: sourceDimensions };
}

export async function compressImage(
  file: File,
  dimensions?: Dimensions,
  options: MediaProcessingOptions = {},
): Promise<CompressedMedia> {
  if (await isAnimatedImageFile(file)) {
    return { file, dimensions };
  }

  if (dimensions) {
    return compressImageSource(file, file, dimensions, options);
  }

  if (!isHeicLikeMedia({ fileName: file.name, mimeType: file.type })) {
    return { file };
  }

  return runHeicConversion(async () => {
    const { heicTo } = await loadHeicTo();
    throwIfAborted(options.signal);
    const bitmap = await heicTo({ blob: file, type: 'bitmap' });
    return compressImageSource(file, bitmap, { width: bitmap.width, height: bitmap.height }, options);
  }, options.signal);
}
