import type { Attachment, MentionInfo } from '@/api/messages';
import type { AttachmentUploadPurpose } from '@/api/upload';
import type { StickerSummary } from '@/api/stickers';

export interface Dimensions {
  width: number;
  height: number;
}

type UploadStatus = 'compressing' | 'uploading' | 'uploaded' | 'error';

interface UploadFileState {
  localId: string;
  kind: 'image' | 'video';
  name: string;
  previewUrl?: string;
  mimeType: string;
  size: number;
  dimensions?: Dimensions;
  progress: number;
  status: UploadStatus;
  attachmentId?: string;
  errorMessage?: string;
}

interface ExistingAttachmentPreview {
  localId: string;
  kind: string;
  name: string;
  size: number;
  previewUrl?: string;
}

export type UploadPreviewItem =
  | ({ itemType: 'pending' } & UploadFileState)
  | ({ itemType: 'existing' } & ExistingAttachmentPreview);

export interface ReplyTo {
  messageId: string;
  username: string;
  messageType?: string;
  text?: string | null;
  sticker?: StickerSummary;
  attachments?: Attachment[];
  isDeleted?: boolean;
  mentions?: MentionInfo[];
}

export interface EditingMessage {
  messageId: string;
  text: string;
  attachments?: Attachment[];
}

export interface ComposeUploadInput {
  file: File;
  purpose: AttachmentUploadPurpose;
  signal: AbortSignal;
  order?: number;
  onProgress: (progress: number) => void;
  dimensions?: Dimensions;
}

export interface ComposeUploadResult {
  attachmentId: string;
}

export interface ComposeUploadedAttachment {
  attachmentId: string;
  file: File;
  mimeType: string;
  size: number;
  dimensions?: Dimensions;
}

interface ComposeSendAttachmentPayload {
  text: string;
  attachmentIds: string[];
  existingAttachments: Attachment[];
  uploadedAttachments: ComposeUploadedAttachment[];
}

export interface ComposeSendTextPayload extends ComposeSendAttachmentPayload {
  kind: 'text';
}

export interface ComposeSendFilePayload {
  kind: 'file';
  file: File;
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

export type ComposeSendPayload =
  | ComposeSendTextPayload
  | ComposeSendFilePayload
  | ComposeSendAudioPayload
  | ComposeSendStickerPayload;

export interface UploadRecord {
  state: UploadFileState;
  file: File;
  order: number;
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
