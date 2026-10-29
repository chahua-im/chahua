import { MessageType, type MessageResponse } from '../../../generated/models';

export function canCreateSticker(
  message: Pick<MessageResponse, 'isDeleted' | 'messageType' | 'message' | 'attachments'>,
): boolean {
  return (
    !message.isDeleted &&
    message.messageType === MessageType.text &&
    !message.message?.trim() &&
    message.attachments.length === 1 &&
    message.attachments[0].kind.startsWith('image/') &&
    message.attachments[0].size <= 10 * 1024 * 1024
  );
}
