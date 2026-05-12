import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { IonButton, IonIcon } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { addCircleOutline, send } from 'ionicons/icons';
import { AudioRecordButton } from './AudioRecordButton';
import { StickerPicker } from './StickerPicker';
import styles from './MessageComposeBar.module.scss';
import { UploadPreview } from '@/components/chat/compose/UploadPreview';
import { ComposeContextBanner } from './ComposeContextBanner';
import { ComposeInput } from './ComposeInput';
import { VoiceRecorderPanel } from './VoiceRecorderPanel';
import { useComposeAttachments } from './useComposeAttachments';
import { useVoiceRecorder } from './useVoiceRecorder';
import { useMentionAutocomplete } from './useMentionAutocomplete';
import { MentionAutocomplete } from './MentionAutocomplete';
import type { StickerSummary } from '@/api/stickers';
import type { ComposeSendPayload, ComposeUploadInput, ComposeUploadResult, EditingMessage, ReplyTo } from './types';
import { isSupportedMediaFile } from '@/utils/heicMedia';
import { useChatDraft, loadDraft } from '@/hooks/useChatDraft';
export type {
  ComposeSendAudioPayload,
  ComposeSendPayload,
  ComposeSendTextPayload,
  ComposeUploadedAttachment,
  ComposeUploadInput,
  ComposeUploadResult,
  EditingMessage,
  ReplyTo,
} from './types';

interface MessageComposeBarProps {
  chatId?: string | number;
  draftKey?: string;
  onRestoreReply?: (replyToMessageId: string) => void;
  onSend: (payload: ComposeSendPayload) => void;
  uploadAttachment: (input: ComposeUploadInput) => Promise<ComposeUploadResult>;
  replyTo?: ReplyTo;
  onCancelReply?: () => void;
  editing?: EditingMessage;
  onCancelEdit?: () => void;
  onRequestEditLastMessage?: () => boolean;
  onFocusChange?: (focused: boolean) => void;
  onError?: (message: string) => void;
}

export interface MessageComposeBarHandle {
  focusInput: () => void;
  blurInput: () => void;
  isFocused: () => boolean;
}

export const MessageComposeBar = forwardRef<MessageComposeBarHandle, MessageComposeBarProps>(
  function MessageComposeBar(props, ref) {
    const composeKey = props.editing?.messageId ?? '__compose__';

    return <MessageComposeBarInner key={composeKey} {...props} ref={ref} />;
  },
);

const MessageComposeBarInner = forwardRef<MessageComposeBarHandle, MessageComposeBarProps>(
  function MessageComposeBarInner(
    {
      chatId,
      draftKey: draftKeyProp,
      onRestoreReply,
      onSend,
      uploadAttachment,
      replyTo,
      onCancelReply,
      editing,
      onCancelEdit,
      onRequestEditLastMessage,
      onFocusChange,
      onError,
    }: MessageComposeBarProps,
    ref,
  ) {
    const draftKeyValue = draftKeyProp ?? String(chatId ?? '');
    const isEditing = editing != null;
    const { saveDebounced, clear: clearDraft } = useChatDraft(isEditing ? undefined : draftKeyValue);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [text, setText] = useState(() => editing?.text ?? '');
    const [draftLoaded, setDraftLoaded] = useState(false);
    const [stickerPickerOpen, setStickerPickerOpen] = useState(false);
    const stickerOverlayActiveRef = useRef(false);
    const [isDragOver, setIsDragOver] = useState(false);
    const dragCounterRef = useRef(0);

    useEffect(() => {
      if (!draftKeyValue || isEditing) {
        setDraftLoaded(true);
        return;
      }

      let canceled = false;
      void loadDraft(draftKeyValue).then((draft) => {
        if (canceled) return;
        if (draft) {
          setText(draft.text);
          if (draft.replyToMessageId) {
            onRestoreReply?.(draft.replyToMessageId);
          }
        }
        setDraftLoaded(true);
      });

      return () => {
        canceled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draftKeyValue]);

    useEffect(() => {
      if (!draftLoaded || isEditing) return;
      saveDebounced({
        text,
        replyToMessageId: replyTo?.messageId,
      });
    }, [text, replyTo?.messageId, draftLoaded, isEditing, saveDebounced]);

    const {
      mentionState,
      selectMention,
      handleKeyDown: handleMentionKeyDown,
      toWireFormat,
      clearMentions,
      onTextChange: onMentionTextChange,
    } = useMentionAutocomplete(textareaRef, text, chatId);

    useImperativeHandle(
      ref,
      () => ({
        focusInput: () => textareaRef.current?.focus(),
        blurInput: () => textareaRef.current?.blur(),
        isFocused: () => document.activeElement === textareaRef.current,
      }),
      [],
    );

    const resizeTextarea = useCallback(() => {
      const ta = textareaRef.current;
      const container = containerRef.current;
      if (!ta) return;

      if (container) {
        container.style.height = `${container.offsetHeight}px`;
      }

      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight / 3)}px`;

      if (container) {
        container.style.height = '';
      }
    }, []);

    const {
      uploads,
      existingAttachments,
      previewItems,
      hasPending,
      hasFailed,
      queueFiles,
      clearAll,
      removeUpload,
      retryUpload,
      removeExistingAttachment,
    } = useComposeAttachments({
      uploadAttachment,
      initialExistingAttachments: editing?.attachments ?? [],
      containerRef,
      onError,
    });

    useLayoutEffect(() => {
      resizeTextarea();
    }, [resizeTextarea, text]);

    const handleSend = useCallback(() => {
      const trimmed = toWireFormat(text.trim());
      const uploadedRecords = uploads.filter(
        (record) => record.state.status === 'uploaded' && Boolean(record.state.attachmentId),
      );
      const attachmentIds = [
        ...existingAttachments.map((attachment) => attachment.id),
        ...uploadedRecords.map((record) => record.state.attachmentId!),
      ];

      if (!trimmed && attachmentIds.length === 0) return;

      onSend({
        kind: 'text',
        text: trimmed,
        attachmentIds,
        existingAttachments,
        uploadedAttachments: uploadedRecords.map((record) => ({
          attachmentId: record.state.attachmentId!,
          file: record.file,
          mimeType: record.state.mimeType,
          size: record.state.size,
          width: record.state.width,
          height: record.state.height,
        })),
      });
      setText('');
      clearAll();
      clearMentions();
      clearDraft();
      const ta = textareaRef.current;
      if (ta) ta.style.height = 'auto';
    }, [clearAll, clearDraft, clearMentions, uploads, existingAttachments, onSend, text, toWireFormat]);

    const uploadedRecords = uploads.filter((record) => record.state.status === 'uploaded');
    const currentAttachmentIds = [
      ...existingAttachments.map((attachment) => attachment.id),
      ...uploadedRecords
        .map((record) => record.state.attachmentId)
        .filter((attachmentId): attachmentId is string => Boolean(attachmentId)),
    ];
    const hasAttachment = currentAttachmentIds.length > 0;
    const trimmedText = text.trim();
    const originalEditText = editing?.text.trim() ?? '';
    const originalAttachmentIds = editing?.attachments?.map((attachment) => attachment.id) ?? [];
    const isUnchangedEdit =
      editing != null &&
      trimmedText === originalEditText &&
      currentAttachmentIds.length === originalAttachmentIds.length &&
      currentAttachmentIds.every((attachmentId, index) => attachmentId === originalAttachmentIds[index]);
    const canSend = !hasPending && !hasFailed && (trimmedText.length > 0 || hasAttachment) && !isUnchangedEdit;
    const canStartVoiceBase = trimmedText.length === 0 && !hasAttachment && !editing && !hasPending && !hasFailed;
    const canRequestRecentEdit = !editing && !replyTo && text.length === 0 && !hasAttachment && uploads.length === 0;

    const {
      voiceRecorder,
      voiceActive,
      startVoiceRecording,
      completeVoiceRecording,
      cancelVoiceRecording,
      sendVoiceRecording,
    } = useVoiceRecorder({
      uploadAttachment,
      onSend,
      onError,
      canStartVoice: canStartVoiceBase,
      onBeforeStart: () => {
        textareaRef.current?.blur();
      },
    });
    const canStartVoice = canStartVoiceBase && !voiceActive;
    const showAudioRecordButton =
      canStartVoice || voiceRecorder?.phase === 'requesting' || voiceRecorder?.phase === 'recording';
    const showVoiceSendButton = voiceRecorder?.phase === 'recorded' || voiceRecorder?.phase === 'uploading';

    const handleDragEnter = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current += 1;
      if (dragCounterRef.current === 1 && e.dataTransfer.types.includes('Files')) {
        setIsDragOver(true);
      }
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current -= 1;
      if (dragCounterRef.current === 0) {
        setIsDragOver(false);
      }
    }, []);

    const handleDrop = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();
        dragCounterRef.current = 0;
        setIsDragOver(false);

        if (containerRef.current && containerRef.current.offsetParent === null) return;

        const files = Array.from(e.dataTransfer.files).filter(isSupportedMediaFile);
        if (files.length > 0) {
          queueFiles(files);
        }
      },
      [queueFiles],
    );

    useEffect(() => {
      if (!stickerPickerOpen) return;

      const handleClickOutside = (e: MouseEvent | TouchEvent) => {
        const target = e.target as HTMLElement;
        if (target.closest('ion-alert, ion-action-sheet, ion-modal, ion-backdrop, ion-toast')) return;
        if (stickerOverlayActiveRef.current) return;
        if (!target.closest('[data-sticker-picker]') && !target.closest('[data-sticker-btn]')) {
          setStickerPickerOpen(false);
        }
      };

      document.addEventListener('click', handleClickOutside, { capture: true });
      return () => {
        document.removeEventListener('click', handleClickOutside, { capture: true });
      };
    }, [stickerPickerOpen]);

    const handleStickerPress = useCallback(() => {
      setStickerPickerOpen((prev) => {
        if (!prev) textareaRef.current?.blur();
        return !prev;
      });
    }, []);

    const handleStickerSelect = useCallback(
      (sticker: StickerSummary) => {
        onSend({ kind: 'sticker', sticker });
        setStickerPickerOpen(false);
      },
      [onSend],
    );

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      queueFiles(files);
      e.target.value = '';
    };

    return (
      <div
        ref={containerRef}
        style={{ position: 'relative' }}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragOver && (
          <div className={styles.dragOverlay}>
            <span className={styles.dragOverlayLabel}>{t`Drop images or videos`}</span>
          </div>
        )}
        {mentionState.isOpen && (
          <MentionAutocomplete
            results={mentionState.results}
            selectedIndex={mentionState.selectedIndex}
            loading={mentionState.loading}
            query={mentionState.query}
            onSelect={selectMention}
          />
        )}
        <div id="message-compose-bar" className={styles.bar}>
          <input
            type="file"
            accept="image/*,image/heic,image/heif,.heic,.heif,video/*"
            multiple
            style={{ display: 'none' }}
            ref={fileInputRef}
            onChange={handleFileChange}
          />
          <button
            type="button"
            className={styles.attachBtn}
            aria-label={t`Attach image`}
            onClick={() => fileInputRef.current?.click()}
            disabled={voiceActive}
          >
            <IonIcon icon={addCircleOutline} />
          </button>
          <div className={styles.inputWrapper}>
            <ComposeContextBanner
              editing={editing}
              replyTo={replyTo}
              onCancelEdit={onCancelEdit}
              onCancelReply={onCancelReply}
            />

            <UploadPreview
              items={previewItems}
              onRemove={(localId) => {
                if (localId.startsWith('existing-')) {
                  removeExistingAttachment(localId);
                  return;
                }
                removeUpload(localId);
              }}
              onRetry={retryUpload}
            />

            {voiceRecorder ? (
              <VoiceRecorderPanel voiceRecorder={voiceRecorder} onCancel={cancelVoiceRecording} />
            ) : (
              <ComposeInput
                textareaRef={textareaRef}
                text={text}
                onTextChange={(value) => {
                  setText(value);
                  onMentionTextChange(value);
                }}
                onFocusChange={onFocusChange}
                onSubmit={handleSend}
                canRequestRecentEdit={canRequestRecentEdit}
                onRequestEditLastMessage={onRequestEditLastMessage}
                editing={editing}
                isUnchangedEdit={isUnchangedEdit}
                onCancelEdit={onCancelEdit}
                onStickerPress={editing ? undefined : handleStickerPress}
                isStickerActive={!editing && stickerPickerOpen}
                onMentionKeyDown={handleMentionKeyDown}
              />
            )}
          </div>
          <div className={styles.actionSlot}>
            {showAudioRecordButton ? (
              <AudioRecordButton
                className={styles.recordButton}
                onStart={startVoiceRecording}
                onComplete={completeVoiceRecording}
                onCancel={cancelVoiceRecording}
                onSend={sendVoiceRecording}
              />
            ) : showVoiceSendButton ? (
              <IonButton
                fill="solid"
                color="primary"
                className={`${styles.sendBtn}${voiceRecorder?.phase === 'uploading' ? ` ${styles.disabled}` : ''}`}
                onClick={sendVoiceRecording}
                aria-label={t`Send voice message`}
                disabled={voiceRecorder?.phase === 'uploading'}
              >
                <IonIcon slot="icon-only" icon={send} className={styles.moveRight} />
              </IonButton>
            ) : voiceRecorder ? (
              <div className={styles.actionSpacer} aria-hidden="true" />
            ) : (
              <IonButton
                fill="solid"
                color="primary"
                className={`${styles.sendBtn}${!canSend ? ` ${styles.disabled}` : ''}`}
                onClick={handleSend}
                aria-label={t`Send message`}
                disabled={!canSend}
              >
                <IonIcon slot="icon-only" icon={send} className={styles.moveRight} />
              </IonButton>
            )}
          </div>
        </div>
        <StickerPicker
          isOpen={stickerPickerOpen}
          onStickerSelect={handleStickerSelect}
          overlayActiveRef={stickerOverlayActiveRef}
        />
      </div>
    );
  },
);
