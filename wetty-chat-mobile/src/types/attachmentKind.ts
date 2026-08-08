export type AttachmentMimeCategory = 'image' | 'video' | 'audio' | 'other';

const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const HEIC_EXTENSION_PATTERN = /\.(heic|heif)(?:$|[?#])/i;

function normalizeMimeType(mimeType?: string | null) {
  return mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function isHeicFileName(fileName?: string | null) {
  return fileName != null && HEIC_EXTENSION_PATTERN.test(fileName);
}

export function categorizeAttachmentKind(kind: string): AttachmentMimeCategory {
  if (kind.startsWith('image/')) return 'image';
  if (kind.startsWith('video/')) return 'video';
  if (kind.startsWith('audio/')) return 'audio';
  return 'other';
}

export function isHeicLikeMedia({
  mimeType,
  fileName,
  url,
}: {
  mimeType?: string | null;
  fileName?: string | null;
  url?: string | null;
}) {
  return HEIC_MIME_TYPES.has(normalizeMimeType(mimeType)) || isHeicFileName(fileName) || isHeicFileName(url);
}

export function isImageKind(kind: string, meta?: { fileName?: string | null; url?: string | null }) {
  return normalizeMimeType(kind).startsWith('image/') || isHeicLikeMedia({ mimeType: kind, ...meta });
}

export function isImageFile(file: File) {
  return file.type.startsWith('image/') || isHeicFileName(file.name);
}

export function isSupportedMediaFile(file: File) {
  return isImageFile(file) || file.type.startsWith('video/');
}

export function getUploadMimeType(file: File) {
  if (file.type) return file.type;
  if (isHeicFileName(file.name)) return 'image/heic';
  return 'application/octet-stream';
}
