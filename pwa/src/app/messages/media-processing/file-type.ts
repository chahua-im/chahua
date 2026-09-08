import { fileTypeFromBuffer } from 'file-type/core';

export type AttachmentMimeCategory = 'image' | 'video' | 'audio' | 'other';

const DETECTION_PREFIX_BYTES = 4100;
const HEIC_MIME_TYPES: Record<string, true> = {
  'image/heic': true,
  'image/heif': true,
  'image/heic-sequence': true,
  'image/heif-sequence': true,
};
const HEIC_EXTENSION_PATTERN = /\.(heic|heif)(?:$|[?#])/i;
const MEDIA_EXTENSION_PATTERN = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|heic|heif|mp4|m4v|mov|webm|mkv|avi)(?:$|[?#])/i;

const CONTAINER_BY_DETECTED_EXT: Record<string, string> = {
  mp4: 'isobmff',
  m4a: 'isobmff',
  m4b: 'isobmff',
  m4v: 'isobmff',
  f4a: 'isobmff',
  f4b: 'isobmff',
  f4v: 'isobmff',
  mov: 'isobmff',
  heic: 'isobmff',
  avif: 'isobmff',
  '3gp': 'isobmff',
  webm: 'ebml',
  mkv: 'ebml',
  opus: 'ogg',
  oga: 'ogg',
  ogv: 'ogg',
  ogm: 'ogg',
  ogx: 'ogg',
  spx: 'ogg',
  ogg: 'ogg',
  webp: 'riff',
  wav: 'riff',
  avi: 'riff',
};

const CONTAINER_BY_DECLARED_SUBTYPE: Record<string, string> = {
  mp4: 'isobmff',
  m4a: 'isobmff',
  'x-m4a': 'isobmff',
  m4v: 'isobmff',
  'x-m4v': 'isobmff',
  quicktime: 'isobmff',
  heic: 'isobmff',
  heif: 'isobmff',
  'heic-sequence': 'isobmff',
  'heif-sequence': 'isobmff',
  avif: 'isobmff',
  '3gpp': 'isobmff',
  '3gpp2': 'isobmff',
  webm: 'ebml',
  'x-matroska': 'ebml',
  ogg: 'ogg',
  opus: 'ogg',
  'x-opus': 'ogg',
  webp: 'riff',
  wav: 'riff',
  'x-wav': 'riff',
  'vnd.wave': 'riff',
  'x-msvideo': 'riff',
};

export function normalizeMimeType(mimeType?: string | null): string {
  return mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function isHeicFileName(fileName?: string | null): boolean {
  return fileName != null && HEIC_EXTENSION_PATTERN.test(fileName);
}

export function isHeicLikeMedia({
  mimeType,
  fileName,
  url,
}: {
  mimeType?: string | null;
  fileName?: string | null;
  url?: string | null;
}): boolean {
  return Boolean(HEIC_MIME_TYPES[normalizeMimeType(mimeType)]) || isHeicFileName(fileName) || isHeicFileName(url);
}

export function categorizeAttachmentKind(kind: string): AttachmentMimeCategory {
  const mimeType = normalizeMimeType(kind);
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'other';
}

export function isImageKind(kind: string, meta?: { fileName?: string | null; url?: string | null }): boolean {
  return normalizeMimeType(kind).startsWith('image/') || isHeicLikeMedia({ mimeType: kind, ...meta });
}

export function mayBeMediaFile(file: File): boolean {
  const declared = normalizeMimeType(file.type);
  return (
    declared.startsWith('image/') ||
    declared.startsWith('video/') ||
    (!declared && MEDIA_EXTENSION_PATTERN.test(file.name))
  );
}

export async function detectFileMimeType(file: File): Promise<string> {
  const declared = file.type.trim();

  try {
    const header = new Uint8Array(await file.slice(0, DETECTION_PREFIX_BYTES).arrayBuffer());
    const detected = await fileTypeFromBuffer(header);

    if (detected) {
      const detectedContainer = CONTAINER_BY_DETECTED_EXT[detected.ext] ?? detected.ext;
      const normalizedDeclared = normalizeMimeType(declared);
      const declaredSubtype = normalizedDeclared.split('/', 2)[1] ?? normalizedDeclared;
      const declaredContainer = CONTAINER_BY_DECLARED_SUBTYPE[declaredSubtype] ?? declaredSubtype;
      if (declared && detectedContainer === declaredContainer) {
        return declared;
      }

      return detected.mime;
    }
  } catch (error) {
    console.debug('[upload:mime] detection failed', error);
  }

  if (declared) return declared;
  return isHeicLikeMedia({ fileName: file.name }) ? 'image/heic' : 'application/octet-stream';
}

export function withDetectedMimeType(file: File, mimeType: string): File {
  if (file.type === mimeType) return file;
  return new File([file], file.name, { type: mimeType, lastModified: file.lastModified });
}
