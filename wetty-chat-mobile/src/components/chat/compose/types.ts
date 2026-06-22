import type { Attachment, MentionInfo } from '@/api/messages';
import type { StickerSummary } from '@/api/stickers';
import type { UploadFileState } from '@/components/chat/compose/UploadPreview';

export interface ReplyTo {
  messageId: string;
  username: string;
  messageType?: string;
  text?: string | null;
  sticker?: StickerSummary;
  attachments?: Attachment[];
  isDeleted?: boolean;
  mentions?: MentionInfo[];
  forwardedFromName?: string | null;
}

export interface EditingMessage {
  messageId: string;
  text: string;
  attachments?: Attachment[];
}

export interface ComposeUploadInput {
  file: File;
  signal: AbortSignal;
  order?: number;
  onProgress: (progress: number) => void;
  dimensions?: {
    width?: number;
    height?: number;
  };
}

export interface ComposeUploadResult {
  attachmentId: string;
}

export interface ComposeUploadedAttachment {
  attachmentId: string;
  file: File;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
}

export interface ComposeSendTextPayload {
  kind: 'text';
  text: string;
  attachmentIds: string[];
  existingAttachments: Attachment[];
  uploadedAttachments: ComposeUploadedAttachment[];
}

export interface ComposeSendAudioPayload {
  kind: 'audio';
  durationMs: number;
  attachmentId: string;
  uploadedAttachment: ComposeUploadedAttachment;
}

export interface ComposeSendStickerPayload {
  kind: 'sticker';
  sticker: StickerSummary;
}

export type ComposeSendPayload = ComposeSendTextPayload | ComposeSendAudioPayload | ComposeSendStickerPayload;

export interface UploadRecord {
  state: UploadFileState;
  file: File;
  abortController?: AbortController;
}

export interface RecordedVoiceData {
  file: File;
  mimeType: string;
  size: number;
  durationMs: number;
}

export type VoiceRecorderState =
  | {
      phase: 'requesting' | 'recording';
      startedAt: number;
      durationMs: number;
    }
  | ({
      phase: 'recorded' | 'uploading';
      uploadProgress: number;
    } & RecordedVoiceData);
