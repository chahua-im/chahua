import { categorizeAttachmentKind, type AttachmentMimeCategory } from '@/utils/fileType';
export const MESSAGE_PREVIEW_MAX = 100;

export interface PreviewAttachmentLike {
  kind: string;
}

export interface PreviewStickerLike {
  emoji?: string | null;
}

export interface PreviewMentionLike {
  uid: number;
  username: string | null;
}

export interface PreviewMessage {
  message?: string | null;
  text?: string | null;
  messageType?: string | null;
  sticker?: PreviewStickerLike | null;
  attachments?: PreviewAttachmentLike[];
  isDeleted?: boolean;
  mentions?: PreviewMentionLike[] | null;
}

export interface PreviewLabels {
  attachment: string;
  deleted: string;
  image: string;
  invite: string;
  sticker: string;
  video: string;
  voiceMessage: string;
}

export interface NotificationPreviewLabels extends PreviewLabels {
  sentMessage: string;
  mentionedYou: string;
  repliedToYou: string;
}

/** Which directed-notification copy a notification body should use. */
export type NotificationKind = 'mention' | 'reply' | 'message';

const PREVIEW_LABELS_BY_LOCALE: Record<string, NotificationPreviewLabels> = {
  en: {
    attachment: '[Attachment]',
    deleted: '[Deleted]',
    image: '[Image]',
    invite: '[Invite]',
    sticker: '[Sticker]',
    video: '[Video]',
    voiceMessage: '[Voice message]',
    sentMessage: 'sent a message',
    mentionedYou: 'mentioned you',
    repliedToYou: 'replied to you',
  },
  'zh-CN': {
    attachment: '[附件]',
    deleted: '[已删除]',
    image: '[图片]',
    invite: '[邀请]',
    sticker: '[表情]',
    video: '[视频]',
    voiceMessage: '[语音消息]',
    sentMessage: '发送了一条消息',
    mentionedYou: '提到了你',
    repliedToYou: '回复了你',
  },
  'zh-TW': {
    attachment: '[附件]',
    deleted: '[已刪除]',
    image: '[圖片]',
    invite: '[邀請]',
    sticker: '[表情]',
    video: '[影片]',
    voiceMessage: '[語音訊息]',
    sentMessage: '傳送了一則訊息',
    mentionedYou: '提到了你',
    repliedToYou: '回覆了你',
  },
};

/** Replace `@[uid:N]` tokens with `@username` for display. */
function renderMentionsAsText(text: string, mentions?: PreviewMentionLike[] | null): string {
  const mentionMap = new Map<number, string>();
  if (mentions) {
    for (const m of mentions) {
      if (m.username) mentionMap.set(m.uid, m.username);
    }
  }
  return text.replace(/@\[uid:(\d+)\]/g, (_, idStr) => {
    const uid = parseInt(idStr, 10);
    return `@${mentionMap.get(uid) ?? `User ${uid}`}`;
  });
}

function normalizePreviewMessage({
  message,
  text,
  messageType,
  sticker,
  attachments,
  isDeleted,
  mentions,
}: PreviewMessage) {
  return {
    message: message ?? text,
    messageType,
    sticker,
    attachments,
    isDeleted,
    mentions,
  };
}

export function truncatePreview(preview: string, maxLength = MESSAGE_PREVIEW_MAX): string {
  const truncated = preview.slice(0, maxLength);
  return preview.length > maxLength ? `${truncated}...`.slice(0, maxLength) + '…' : truncated;
}

export function resolvePreviewLocale(locale?: string | null): keyof typeof PREVIEW_LABELS_BY_LOCALE {
  if (!locale) return 'en';

  const normalized = locale.toLowerCase();
  if (normalized === 'zh-tw' || normalized.startsWith('zh-hant') || normalized.startsWith('zh-hk')) {
    return 'zh-TW';
  }
  if (normalized === 'zh-cn' || normalized.startsWith('zh-hans') || normalized.startsWith('zh')) {
    return 'zh-CN';
  }
  return 'en';
}

export function getNotificationPreviewLabels(locale?: string | null): NotificationPreviewLabels {
  return PREVIEW_LABELS_BY_LOCALE[resolvePreviewLocale(locale)];
}

function attachmentKindToLabel(kind: AttachmentMimeCategory, labels: PreviewLabels): string {
  switch (kind) {
    case 'image':
      return labels.image;
    case 'video':
      return labels.video;
    case 'audio':
      return labels.voiceMessage;
    case 'other':
      return labels.attachment;
  }
}
export function formatMessagePreview(preview: PreviewMessage, labels: PreviewLabels): string {
  const { message, messageType, sticker, attachments, isDeleted, mentions } = normalizePreviewMessage(preview);

  if (isDeleted) {
    return labels.deleted;
  }

  if (messageType === 'invite') {
    return labels.invite;
  }

  if (messageType === 'sticker') {
    return sticker?.emoji ? `${labels.sticker} ${sticker.emoji}` : labels.sticker;
  }

  if (messageType === 'audio') {
    return labels.voiceMessage;
  }

  if (messageType === 'file') {
    return labels.attachment;
  }

  // Build one label per attachment
  const attachmentLabels: string[] =
    attachments?.map((a) => attachmentKindToLabel(categorizeAttachmentKind(a.kind), labels)) ?? [];

  const prefix = attachmentLabels.join('');
  const text = message?.trim() ? renderMentionsAsText(message, mentions) : '';

  if (prefix && text) return `${prefix} ${text}`;
  if (prefix) return prefix;
  if (text) return text;

  return '';
}

export function formatNotificationBody(
  senderName: string,
  preview: PreviewMessage | null | undefined,
  labels: NotificationPreviewLabels,
  kind: NotificationKind = 'message',
): string {
  const previewText = preview ? formatMessagePreview(preview, labels) : '';
  if (kind === 'mention') {
    return previewText
      ? `${senderName} ${labels.mentionedYou}: ${truncatePreview(previewText)}`
      : `${senderName} ${labels.mentionedYou}`;
  }
  if (kind === 'reply') {
    return previewText
      ? `${senderName} ${labels.repliedToYou}: ${truncatePreview(previewText)}`
      : `${senderName} ${labels.repliedToYou}`;
  }
  if (previewText) {
    return `${senderName}: ${truncatePreview(previewText)}`;
  }
  return `${senderName} ${labels.sentMessage}`;
}
