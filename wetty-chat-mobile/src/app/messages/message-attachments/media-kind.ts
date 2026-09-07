export enum MediaKind {
  File,
  Audio,
  Image,
  Video,
}
export function mediaKind(mime?: string) {
  if (mime?.startsWith('audio/')) return MediaKind.Audio;
  if (mime?.startsWith('image/')) return MediaKind.Image;
  if (mime?.startsWith('video/')) return MediaKind.Video;
  return MediaKind.File;
}

export function attachmentKind(type: MessageType, mime: string) {
  if (type === MessageType.file) return MediaKind.File;
  if (type === MessageType.audio) return MediaKind.Audio;
  return mediaKind(mime);
}
import { MessageType } from '../../../generated/models';
