import type { Attachment, MessageResponse } from '@/api/messages';
import type { GroupRole } from '@/api/group';
import type { ComposeUploadedAttachment } from '@/components/chat/compose/MessageComposeBar';
import { createClientGeneratedId } from '@/utils/clientGeneratedId';

function isSameDay(d1: Date, d2: Date): boolean {
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}

export function formatDateSeparator(iso: string, locale: string, labels: { today: string; yesterday: string }): string {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();

  if (isSameDay(date, now)) return labels.today;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return labels.yesterday;

  return date.toLocaleDateString(locale, {
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    month: 'short',
    day: 'numeric',
  });
}

export function generateClientId(): string {
  return createClientGeneratedId('cg_');
}

export function parseComparableMessageId(messageId: string): bigint | null {
  if (!/^\d+$/.test(messageId)) return null;
  return BigInt(messageId);
}

export function isMessageAtOrAfter(messageId: string | null, targetMessageId: string): boolean {
  if (!messageId) return false;
  const comparableId = parseComparableMessageId(messageId);
  const targetComparableId = parseComparableMessageId(targetMessageId);
  if (comparableId == null || targetComparableId == null) return false;
  return comparableId >= targetComparableId;
}

export function areAttachmentIdsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function areMessageListsEquivalent(left: MessageResponse[], right: MessageResponse[]): boolean {
  return (
    left.length === right.length &&
    left.every((message, index) => {
      const candidate = right[index];
      return candidate != null && message.id === candidate.id;
    })
  );
}

export function isAudioMessage(message: MessageResponse): boolean {
  return message.messageType === 'audio';
}

export function buildOptimisticUploadedAttachments(uploadedAttachments: ComposeUploadedAttachment[]): {
  attachments: Attachment[];
  revoke: () => void;
} {
  const previewUrls: string[] = [];
  const attachments = uploadedAttachments.map((attachment) => {
    const previewUrl = URL.createObjectURL(attachment.file);
    previewUrls.push(previewUrl);

    return {
      id: attachment.attachmentId,
      url: previewUrl,
      kind: attachment.mimeType,
      size: attachment.size,
      fileName: attachment.file.name,
      width: attachment.dimensions?.width ?? null,
      height: attachment.dimensions?.height ?? null,
    };
  });

  return {
    attachments,
    revoke: () => {
      previewUrls.forEach((previewUrl) => URL.revokeObjectURL(previewUrl));
    },
  };
}

export function hasLoadedThreadChatMeta(cachedMeta?: { name?: string | null; myRole?: GroupRole | null }) {
  return cachedMeta?.name != null && cachedMeta.myRole !== undefined;
}
