import { compressImage, compressVideo } from './compression';
import { detectFileMimeType, withDetectedMimeType } from './file-type';
import { mediaDimensions } from '../upload';

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
