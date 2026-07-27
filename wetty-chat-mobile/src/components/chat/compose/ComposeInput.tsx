import { useEffect } from 'react';
import { IonIcon } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { happyOutline } from 'ionicons/icons';
import type { EditingMessage, ReplyTo } from './types';
import styles from './MessageComposeBar.module.scss';

const SIMULATED_MOUSE_DELAY_MS = 500;
let lastInteractionType: 'touch' | 'mouse' = 'mouse';
let lastTouchTime = 0;
if (typeof window !== 'undefined') {
  window.addEventListener(
    'touchstart',
    () => {
      lastInteractionType = 'touch';
      lastTouchTime = Date.now();
    },
    { capture: true, passive: true },
  );

  window.addEventListener(
    'mousedown',
    () => {
      // 忽略移动端由于触摸产生的模拟 mousedown 事件（通常在 touchstart 后几十毫秒内触发）
      if (Date.now() - lastTouchTime > SIMULATED_MOUSE_DELAY_MS) {
        lastInteractionType = 'mouse';
      }
    },
    { capture: true, passive: true },
  );
}

function checkIsVirtualKeyboard(): boolean {
  if (typeof window !== 'undefined' && 'ontouchstart' in window) {
    return lastInteractionType === 'touch';
  }
  return false;
}

interface ComposeInputProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  onTextChange: (value: string) => void;
  onFocusChange?: (focused: boolean) => void;
  onSubmit: () => void;
  canRequestRecentEdit: boolean;
  onRequestEditLastMessage?: () => boolean;
  editing?: EditingMessage;
  isUnchangedEdit: boolean;
  onCancelEdit?: () => void;
  replyTo?: ReplyTo;
  onCancelReply?: () => void;
  onStickerPress?: () => void;
  isStickerActive?: boolean;
  onMentionKeyDown?: (event: KeyboardEvent) => boolean;
}

export function ComposeInput({
  textareaRef,
  text,
  onTextChange,
  onFocusChange,
  onSubmit,
  canRequestRecentEdit,
  onRequestEditLastMessage,
  editing,
  isUnchangedEdit,
  onCancelEdit,
  replyTo,
  onCancelReply,
  onStickerPress,
  isStickerActive,
  onMentionKeyDown,
}: ComposeInputProps) {
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.setAttribute('enterkeyhint', 'enter');
    const onKeyDown = (event: KeyboardEvent) => {
      // Let mention autocomplete consume the event first
      const consumedByMention = onMentionKeyDown?.(event);
      if (consumedByMention) {
        return;
      }

      const isImeConfirm = event.isComposing || event.keyCode === 229 || event.which === 229;
      const isVirtualKbd = checkIsVirtualKeyboard();
      if (event.key === 'Enter' && !event.shiftKey && !isImeConfirm && !isVirtualKbd) {
        event.preventDefault();
        onSubmit();
        return;
      }

      if (event.key === 'ArrowUp' && canRequestRecentEdit) {
        const didStartEdit = onRequestEditLastMessage?.() ?? false;
        if (didStartEdit) {
          event.preventDefault();
        }
        return;
      }

      if (event.key === 'Escape') {
        // Never interfere with IME composition (e.g. CJK candidate cancel).
        if (event.isComposing) {
          return;
        }

        // 1. Cancel an unchanged edit session (existing behaviour).
        if (editing && isUnchangedEdit) {
          event.preventDefault();
          event.stopPropagation();
          onCancelEdit?.();
          return;
        }

        // 2. Cancel reply state: clear the reply target/preview but keep focus,
        //    text, attachments and drafts. Do NOT blur or navigate.
        if (replyTo) {
          event.preventDefault();
          event.stopPropagation();
          onCancelReply?.();
          return;
        }

        // 3. Blur the input so the next Esc performs page-level back navigation.
        //    Only applies to normal (non-editing) compose, preserving existing
        //    edit behaviour. stopPropagation prevents this same Esc from also
        //    triggering the global back-navigation handler.
        if (!editing) {
          event.preventDefault();
          event.stopPropagation();
          textareaRef.current?.blur();
        }
        return;
      }
    };

    textarea.addEventListener('keydown', onKeyDown);
    return () => textarea.removeEventListener('keydown', onKeyDown);
  }, [
    canRequestRecentEdit,
    editing,
    isUnchangedEdit,
    onCancelEdit,
    replyTo,
    onCancelReply,
    onMentionKeyDown,
    onRequestEditLastMessage,
    onSubmit,
    textareaRef,
  ]);

  return (
    <div className={styles.inputRow}>
      <textarea
        id="messageCompose"
        ref={textareaRef}
        className={styles.textarea}
        placeholder={t`Message`}
        value={text}
        rows={1}
        onChange={(event) => onTextChange(event.target.value)}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        enterKeyHint="enter"
      />
      <button
        type="button"
        className={`${styles.stickerBtn}${isStickerActive ? ` ${styles.stickerBtnActive}` : ''}`}
        aria-label={t`Sticker`}
        aria-pressed={isStickerActive}
        onClick={onStickerPress}
        data-sticker-btn
      >
        <IonIcon icon={happyOutline} />
      </button>
    </div>
  );
}
