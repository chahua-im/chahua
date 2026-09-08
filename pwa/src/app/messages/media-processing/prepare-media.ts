import { compressImage, compressVideo } from './compression';
import { detectFileMimeType, withDetectedMimeType } from './file-type';

/** Only the photo picker calls this; file attachments preserve their original bytes. */
export async function prepareMedia(source: File, signal: AbortSignal, onProgress?: (value: number) => void) {
  const file = withDetectedMimeType(source, await detectFileMimeType(source));
  const size = await mediaDimensions(file).catch(() => ({}) as { width?: number; height?: number });
  const dimensions = size.width && size.height ? { width: size.width, height: size.height } : undefined;
  signal.throwIfAborted();
  if (!/^(image|video)\//.test(file.type)) throw new Error('请选择图片或视频');
  try {
    return await (file.type.startsWith('image/') ? compressImage : compressVideo)(file, dimensions, {
      signal,
      onProgress,
    });
  } catch {
    signal.throwIfAborted();
    return { file, dimensions };
  }
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
