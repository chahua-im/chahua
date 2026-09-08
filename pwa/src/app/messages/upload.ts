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
