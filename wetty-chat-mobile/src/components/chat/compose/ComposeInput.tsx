import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IonIcon } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { happyOutline } from 'ionicons/icons';
import { isFeatureEnabled } from '@/features';
import {
  applyLink,
  shortcutFormatKind,
  wrapBlockFormat,
  wrapInlineFormat,
  type BlockFormatKind,
  type TextFormatKind,
} from '@/utils/textFormat';
import { FormatToolbar, type FormatToolbarAnchor } from './FormatToolbar';
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

/**
 * Commit a new value into a React-controlled <textarea> exactly the way the
 * mention autocomplete inserts text: use the native value setter and then fire
 * an `input` event so React's onChange produces the parent's setState. The
 * collapsed/new selection is restored on a macrotask so it always runs after
 * React has re-rendered the committed value.
 */
function commitControlledValue(textarea: HTMLTextAreaElement, next: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  valueSetter?.call(textarea, next);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
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
  /** Mention autocomplete popup open state — used to hide the format pill. */
  isMentionMenuOpen?: boolean;
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
  isMentionMenuOpen = false,
}: ComposeInputProps) {
  const [focused, setFocusedState] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [isComposing, setComposing] = useState(false);
  const [linkMode, setLinkMode] = useState(false);
  const applyActionRef = useRef<((kind: TextFormatKind, url?: string) => void) | null>(null);

  const measureSelection = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const selected = end > start;
    setHasSelection((prev) => (prev === selected ? prev : selected));
  };

  const applyAction = (kind: TextFormatKind, url?: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const selection = { start: textarea.selectionStart ?? 0, end: textarea.selectionEnd ?? 0 };
    const result =
      kind === 'link'
        ? url
          ? applyLink(text, selection, url)
          : null
        : kind === 'code' || kind === 'quote'
          ? wrapBlockFormat(text, selection, kind as BlockFormatKind)
          : wrapInlineFormat(text, selection, kind);
    if (!result) return;

    if (kind === 'link') {
      setLinkMode(false);
    }
    commitControlledValue(textarea, result.text);
    window.setTimeout(() => {
      textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
      textarea.focus();
      measureSelection();
    }, 0);
  };
  // Keep the latest formatter reachable from the keydown listener so shortcuts
  // never act on a stale closure.
  useEffect(() => {
    applyActionRef.current = applyAction;
  });

  const requestLinkMode = (open: boolean) => {
    setLinkMode(open);
    if (!open) {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.focus();
        measureSelection();
      }
    }
  };

  const formatEnabled = isFeatureEnabled('messageMarkdown');

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

      // Ctrl/Cmd+B / I / D formatting shortcuts (never during IME composition).
      if (formatEnabled && !isImeConfirm && !event.altKey && (event.ctrlKey || event.metaKey)) {
        const kind = shortcutFormatKind(event);
        if (kind) {
          event.preventDefault();
          applyActionRef.current?.(kind);
          return;
        }
      }

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
    formatEnabled,
  ]);

  const toolbarVisible = (() => {
    if (!formatEnabled) return false;
    if (isMentionMenuOpen) return false;
    if (linkMode) return true;
    return focused && hasSelection && !isComposing;
  })();

  const [toolbarAnchor, setToolbarAnchor] = useState<FormatToolbarAnchor | null>(null);
  // Re-measure the anchor after every commit; visibility stays derived from
  // `toolbarVisible` in the render above, so a stale anchor is ignored while hidden.
  useLayoutEffect(() => {
    if (!toolbarVisible) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const rect = textarea.getBoundingClientRect();
    const next = { top: rect.top - 8, left: rect.left + rect.width / 2 };
    setToolbarAnchor((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
  }, [toolbarVisible, text, textareaRef]);

  return (
    <>
      <div className={styles.inputRow}>
        <textarea
          id="messageCompose"
          ref={textareaRef}
          className={styles.textarea}
          placeholder={t`Message`}
          value={text}
          rows={1}
          onChange={(event) => onTextChange(event.target.value)}
          onFocus={() => {
            setFocusedState(true);
            measureSelection();
            onFocusChange?.(true);
          }}
          onBlur={() => {
            setFocusedState(false);
            onFocusChange?.(false);
          }}
          onSelect={measureSelection}
          onMouseUp={measureSelection}
          onKeyUp={measureSelection}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => {
            setComposing(false);
            measureSelection();
          }}
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
      {toolbarVisible && toolbarAnchor && typeof document !== 'undefined'
        ? createPortal(
            <FormatToolbar
              anchor={toolbarAnchor}
              linkMode={linkMode}
              onRequestLinkMode={requestLinkMode}
              onFormat={(kind) => applyActionRef.current?.(kind)}
              onSubmitLink={(url) => applyActionRef.current?.('link', url)}
            />,
            document.body,
          )
        : null}
    </>
  );
}
