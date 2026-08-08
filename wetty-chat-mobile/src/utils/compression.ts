import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  VIDEO_CODECS,
} from 'mediabunny';

export interface CompressVideoOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

export interface CompressImageOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

export function calculateTargetVideoDimensions(
  width: number,
  height: number,
  max = 1280,
): { width?: number; height?: number } {
  if (width <= max && height <= max) {
    return {};
  }

  if (width > height) {
    return { width: max };
  } else {
    return { height: max };
  }
}

export const ceilToMultipleOfTwo = (v: number) => (v % 2 === 0 ? v : v + 1);

export function calculateOutputVideoDimensions(
  originalWidth: number,
  originalHeight: number,
  targetDims: { width?: number; height?: number },
): { width: number; height: number } {
  const aspectRatio = originalWidth / originalHeight;

  if (targetDims.width !== undefined) {
    const width = ceilToMultipleOfTwo(targetDims.width);
    return {
      width,
      height: ceilToMultipleOfTwo(Math.round(width / aspectRatio)),
    };
  }

  if (targetDims.height !== undefined) {
    const height = ceilToMultipleOfTwo(targetDims.height);
    return {
      width: ceilToMultipleOfTwo(Math.round(height * aspectRatio)),
      height,
    };
  }

  return {
    width: ceilToMultipleOfTwo(originalWidth),
    height: ceilToMultipleOfTwo(originalHeight),
  };
}

// @ts-expect-error force change readonly value.
VIDEO_CODECS.splice(0, VIDEO_CODECS.length, 'hevc', 'av1', 'vp9', 'avc', 'vp8');

export async function compressVideo(
  file: File,
  dimensions: { width?: number; height?: number },
  { signal, onProgress }: CompressVideoOptions = {},
): Promise<File> {
  const originalWidth = dimensions.width;
  const originalHeight = dimensions.height;
  if (!originalWidth || !originalHeight || !('VideoEncoder' in window)) return file;

  const targetDims = calculateTargetVideoDimensions(originalWidth, originalHeight);

  // TODO: 开始压缩之前预检一下源文件的分辨率和码率，以及支持的格式。如果预期压缩无法取得显著成效，就应该放弃压缩，改用源文件。
  try {
    const target = new BufferTarget();
    const conversion = await Conversion.init({
      input: new Input({ source: new BlobSource(file), formats: ALL_FORMATS }),
      output: new Output({ format: new Mp4OutputFormat(), target }),
      tracks: 'primary',
      video: { ...targetDims, quality: new Quality('low') },
      audio: { quality: new Quality('low') },
    });

    conversion.onProgress = onProgress;

    const abortHandler = () => {
      conversion.cancel().catch(console.error);
    };
    signal?.addEventListener('abort', abortHandler);

    try {
      if (signal?.aborted) abortHandler();
      await conversion.execute();
    } finally {
      signal?.removeEventListener('abort', abortHandler);
    }

    console.log('[upload:compression] Compression finished:', target.buffer!.byteLength);
    // 压缩后再检查一遍，如果压缩没有取得显著成效，就应该放弃压缩后的，改用源文件。
    if (target.buffer!.byteLength < file.size * 0.5) {
      const outputDims = calculateOutputVideoDimensions(originalWidth, originalHeight, targetDims);
      dimensions.width = outputDims.width;
      dimensions.height = outputDims.height;

      return new File([target.buffer!], file.name + '.mp4', { type: 'video/mp4' });
    } else {
      console.log('[upload:compression] Compression not significant, use original file:', file);
      return file;
    }
  } catch (error) {
    console.warn('[upload:compression] Compression skipped/failed:', error);
    return file;
  }
}

export function calculateTargetImageDimensions(
  width: number,
  height: number,
  max = 1280,
): { resizeWidth?: number; resizeHeight?: number } {
  if (width <= max && height <= max) {
    return {};
  }

  if (width > height) {
    return { resizeWidth: max };
  } else {
    return { resizeHeight: max };
  }
}

export async function compressImage(
  file: File,
  dimensions: { width?: number; height?: number },
  { signal, onProgress }: CompressImageOptions = {},
): Promise<File> {
  if (signal?.aborted) return file;
  if (!dimensions.width || !dimensions.height) return file;
  const targetDims = calculateTargetImageDimensions(dimensions.width, dimensions.height);
  const bitmap = await createImageBitmap(file, {
    imageOrientation: 'from-image',
    ...targetDims,
    resizeQuality: 'high',
  });

  if (signal?.aborted) {
    bitmap.close();
    return file;
  }

  onProgress?.(0.5);

  let blob: Blob | null = null;
  let selectedExt = '';

  const exportFormats = [
    { type: 'image/avif', quality: 0.6, ext: '.avif' },
    { type: 'image/webp', quality: 0.6, ext: '.webp' },
    { type: 'image/jpeg', quality: 0.8, ext: '.jpg' },
  ];

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  for (const { type, quality, ext } of exportFormats) {
    if (signal?.aborted) return file;
    try {
      const b = await canvas.convertToBlob({ type, quality });
      if (b.type === type) {
        blob = b;
        selectedExt = ext;
        break;
      }
    } catch {
      // Ignore and try next format
    }
  }

  if (signal?.aborted) return file;

  if (blob) {
    onProgress?.(1.0);
  }

  // 压缩后再检查一遍，如果体积小于原来的 75%，则认为压缩有效
  if (blob && blob.size < file.size * 0.75) {
    dimensions.width = bitmap.width;
    dimensions.height = bitmap.height;
    return new File([blob], file.name + selectedExt, { type: blob.type });
  }

  return file;
}
