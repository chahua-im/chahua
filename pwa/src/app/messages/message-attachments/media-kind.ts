import { MessageType } from '../../../generated/models';
import { normalizeMimeType } from '../media-processing/file-type';

export enum MediaKind {
  File,
  Audio,
  Image,
  Video,
}
export function mediaKind(mime?: string) {
  const type = normalizeMimeType(mime);
  if (type.startsWith('audio/')) return MediaKind.Audio;
  if (type.startsWith('image/')) return MediaKind.Image;
  if (type.startsWith('video/')) return MediaKind.Video;
  return MediaKind.File;
}

export function attachmentKind(type: MessageType, mime: string) {
  if (type === MessageType.file) return MediaKind.File;
  if (type === MessageType.audio) return MediaKind.Audio;
  return mediaKind(mime);
}
