import {
  Input,
  Output,
  Conversion,
  BlobSource,
  BufferTarget,
  Mp4OutputFormat,
  ALL_FORMATS,
  Quality,
  VIDEO_CODECS,
} from 'mediabunny';

export interface CompressVideoOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
  originalWidth?: number;
  originalHeight?: number;
}

export function calculateTargetVideoDimensions(width: number, height: number, max = 1280): { width?: number; height?: number } {
  if (width <= max && height <= max) {
    return {};
  }
  
  if (width > height) {
    return { width: max };
  } else {
    return { height: max };
  }
}

// @ts-expect-error force change readonly value.
VIDEO_CODECS.splice(0, VIDEO_CODECS.length, 'hevc', 'av1', 'vp9', 'avc', 'vp8');

export async function compressVideo(
  file: File,
  { signal, onProgress, originalWidth, originalHeight }: CompressVideoOptions = {},
): Promise<File> {
  if (!originalWidth || !originalHeight || !('VideoEncoder' in window)) return file;

  const dimensions = calculateTargetVideoDimensions(originalWidth, originalHeight);

  // TODO: 开始压缩之前预检一下源文件的分辨率和码率，以及支持的格式。如果预期压缩无法取得显著成效，就应该放弃压缩，改用源文件。
  try {
    const target = new BufferTarget();
    const conversion = await Conversion.init({
      input: new Input({ source: new BlobSource(file), formats: ALL_FORMATS }),
      output: new Output({ format: new Mp4OutputFormat(), target }),
      tracks: 'primary',
      video: { ...dimensions, quality: new Quality('low') },
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

    console.log('[upload:compression] Compression finished:', target.buffer?.byteLength);
    // TODO: 压缩后再检查一遍，如果压缩没有取得显著成效，就应该放弃压缩后的，改用源文件。

    return new File([target.buffer!], file.name.replace(/\.[^/.]+$/, '.mp4'), { type: 'video/mp4' });
  } catch (error) {
    console.warn('[upload:compression] Compression skipped/failed:', error);
    return file;
  }
}
