import { MessageType } from '../../generated/models';
import { attachmentKind, MediaKind } from './message-attachments/media-kind';

/** Images, videos and stickers without a caption carry their time on the media. */
export function mediaOverlay(message: {
  messageType: MessageType;
  message?: string;
  attachments: readonly { kind: string }[];
}) {
  return (
    message.messageType === MessageType.sticker ||
    (!message.message?.trim() &&
      message.attachments.length > 0 &&
      message.attachments.every((attachment) => {
        const kind = attachmentKind(message.messageType, attachment.kind);
        return kind === MediaKind.Image || kind === MediaKind.Video;
      }))
  );
}
