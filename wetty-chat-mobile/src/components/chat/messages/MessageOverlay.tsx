import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { IonIcon, useIonToast } from '@ionic/react';
import { addOutline } from 'ionicons/icons';
import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from 'emoji-picker-react';
import type { Attachment } from '@/api/messages';
import type { PreviewMessage } from '@/utils/messagePreview';
import { ChatBubbleBase } from './ChatBubbleBase';
import { StickerBubble } from './StickerBubble';
import styles from './MessageOverlay.module.scss';
import { MAX_DISTINCT_REACTIONS_PER_MESSAGE } from '@/constants/emojiAndStickers';
import { getOverlayPortalTarget } from '@/utils/dom';
import { t } from '@lingui/core/macro';

export interface MessageOverlayAction {
  key: string;
  label: string;
  icon?: string;
  role?: 'destructive';
  disabled?: boolean;
  handler: () => void;
}

interface MessageOverlayBaseProps {
  senderName: string;
  isSent: boolean;
  showName?: boolean;
  replyTo?: {
    senderName: string;
    preview: PreviewMessage;
  };
  timestamp?: string;
  edited?: boolean;
  isConfirmed?: boolean;
  sourceRect: DOMRect;
  interactionPos?: { x: number; y: number };
  messageId?: string;
  actions: MessageOverlayAction[];
  reactions?: {
    emojis: string[];
    onReact: (emoji: string) => void;
    currentMessageReactions?: string[];
  };
  onClose: () => void;
}

interface StickerOverlayProps extends MessageOverlayBaseProps {
  messageType: 'sticker';
  stickerUrl: string;
  message?: never;
  attachments?: never;
}

interface RegularOverlayProps extends MessageOverlayBaseProps {
  messageType?: 'text' | 'audio';
  message: string;
  attachments?: Attachment[];
  stickerUrl?: never;
}

export type MessageOverlayProps = StickerOverlayProps | RegularOverlayProps;

export function MessageOverlay(props: MessageOverlayProps) {
  const {
    senderName,
    isSent,
    showName = true,
    replyTo,
    timestamp,
    edited,
    isConfirmed,
    sourceRect,
    interactionPos,
    messageId,
    actions,
    reactions,
    onClose,
  } = props;
  const isSticker = props.messageType === 'sticker';
  const contentRef = useRef<HTMLDivElement>(null);
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
  const [presentToast] = useIonToast();

  const handleEmojiClick = useCallback(
    (emojiData: EmojiClickData) => {
      if (reactions) {
        reactions.onReact(emojiData.emoji);
      }
      setIsEmojiPickerOpen(false);
      onClose();
    },
    [reactions, onClose],
  );
  // Compute position after first render so we know the full content dimensions
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    // Resolve the current bubble position from the live DOM (it may have moved
    // since the long-press event, e.g. after the on-screen keyboard closed).
    let currentSourceRect = sourceRect;
    if (messageId) {
      const el = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
      if (el) {
        currentSourceRect = el.getBoundingClientRect();
      }
    }

    const visualViewport = window.visualViewport;
    const vh = visualViewport?.height ?? window.innerHeight;
    const vw = visualViewport?.width ?? window.innerWidth;
    const offsetTop = visualViewport?.offsetTop ?? 0;
    const offsetLeft = visualViewport?.offsetLeft ?? 0;

    const bubbleEl = content.querySelector('[data-bubble-clone]') as HTMLElement | null;
    const bubbleOffsetTop = bubbleEl ? bubbleEl.offsetTop : 0;

    let top = currentSourceRect.top - bubbleOffsetTop;

    // Check if there's enough space below for the actions
    const actionListEl = content.querySelector('[data-action-list]') as HTMLElement | null;
    const reactionBarEl = content.querySelector('[data-reaction-bar]') as HTMLElement | null;
    if (actionListEl) {
      const spaceBelow = offsetTop + vh - currentSourceRect.bottom;
      // Required space: action list height + flex gap (8px) + minimum bottom padding
      const requiredSpace = actionListEl.offsetHeight + 8 + 40;

      // If space below is less than the required space, swap the layout
      if (spaceBelow < requiredSpace) {
        // We move the action list to the top and reaction bar to the bottom
        actionListEl.style.order = '-1';
        if (reactionBarEl) {
          reactionBarEl.style.order = '1';
        }
        // Re-read bubbleOffsetTop since the layout just changed!
        const newBubbleOffsetTop = bubbleEl ? bubbleEl.offsetTop : 0;
        top = currentSourceRect.top - newBubbleOffsetTop;
      }
    }

    const currentContentHeight = content.offsetHeight;
    const currentContentWidth = content.offsetWidth;

    // For sent messages, align right edge to source right edge
    let left = isSent ? currentSourceRect.right - currentContentWidth : currentSourceRect.left;

    const computedStyle = getComputedStyle(document.documentElement);
    const safeBottomStr = computedStyle.getPropertyValue('--ion-safe-area-bottom');
    const safeBottom = safeBottomStr ? parseFloat(safeBottomStr) : 0;

    const safeTopStr = computedStyle.getPropertyValue('--ion-safe-area-top');
    const safeTop = safeTopStr ? parseFloat(safeTopStr) : 0;

    const bottomPad = 40 + safeBottom;
    const topPad = Math.max(40, 12 + safeTop);
    const sidePad = 12;

    // Clamp horizontally for main content
    if (left + currentContentWidth > offsetLeft + vw - sidePad) {
      left = offsetLeft + vw - sidePad - currentContentWidth;
    }
    if (left < offsetLeft + sidePad) {
      left = offsetLeft + sidePad;
    }

    const actionHeight = actionListEl ? actionListEl.offsetHeight : 0;
    const reactionHeight = reactionBarEl ? reactionBarEl.offsetHeight : 0;
    const maxMenuWidth = Math.max(
      actionListEl ? actionListEl.offsetWidth : 0,
      reactionBarEl ? reactionBarEl.offsetWidth : 0,
    );

    // Reset any opaque-menu overrides from a previous layout pass.
    const resetMenuStyles = (el: HTMLElement) => {
      el.style.position = '';
      el.style.top = '';
      el.style.left = '';
      el.style.right = '';
      el.style.zIndex = '';
      el.classList.remove(styles.opaqueMenu);
    };
    if (actionListEl) resetMenuStyles(actionListEl);
    if (reactionBarEl) resetMenuStyles(reactionBarEl);

    // Check if the current content height exceeds available vertical space
    // and we have an interaction position so we can overlay the menus on the bubble.
    if (interactionPos && currentContentHeight > offsetTop + vh - bottomPad - topPad) {
      top = currentSourceRect.top;

      const localViewportTop = offsetTop + topPad - top;
      const localViewportBottom = offsetTop + vh - bottomPad - top;

      let menuGlobalLeft = interactionPos.x;
      if (menuGlobalLeft + maxMenuWidth > offsetLeft + vw - sidePad) {
        menuGlobalLeft = offsetLeft + vw - sidePad - maxMenuWidth;
      }
      if (menuGlobalLeft < offsetLeft + sidePad) {
        menuGlobalLeft = offsetLeft + sidePad;
      }
      const menuLocalLeft = menuGlobalLeft - left;

      const applyPos = (el: HTMLElement, topY: number, leftX: number, elHeight: number) => {
        el.style.position = 'absolute';
        let desiredTop = topY;
        if (desiredTop < localViewportTop) desiredTop = localViewportTop;
        if (desiredTop + elHeight > localViewportBottom) desiredTop = localViewportBottom - elHeight;
        el.style.top = `${desiredTop}px`;
        el.style.left = `${leftX}px`;
        el.style.right = 'auto';
        el.style.zIndex = '1000';
        el.classList.add(styles.opaqueMenu);
      };

      const REACTION_BAR_OFFSET = 2;
      const ACTION_LIST_OFFSET = 4;

      // Shift interactionPos by the same amount the bubble moved since the
      // long-press event so the menus track the visual touch point.
      const interactionOffsetY = interactionPos.y - sourceRect.top;
      const currentInteractionY = currentSourceRect.top + interactionOffsetY;

      if (reactionBarEl && actionListEl) {
        let rTop = currentInteractionY - top - reactionHeight - REACTION_BAR_OFFSET;
        let aTop = currentInteractionY - top + ACTION_LIST_OFFSET;

        // Push down if reaction bar hits top
        if (rTop < localViewportTop) {
          const shift = localViewportTop - rTop;
          rTop += shift;
          if (aTop < rTop + reactionHeight + REACTION_BAR_OFFSET) {
            aTop = rTop + reactionHeight + REACTION_BAR_OFFSET;
          }
        }

        // Push up if action list hits bottom
        if (aTop + actionHeight > localViewportBottom) {
          const shift = aTop + actionHeight - localViewportBottom;
          aTop -= shift;
          if (rTop > aTop - reactionHeight - REACTION_BAR_OFFSET) {
            rTop = aTop - reactionHeight - REACTION_BAR_OFFSET;
          }
        }

        applyPos(reactionBarEl, rTop, menuLocalLeft, reactionHeight);
        applyPos(actionListEl, aTop, menuLocalLeft, actionHeight);
      } else if (reactionBarEl) {
        applyPos(
          reactionBarEl,
          currentInteractionY - top - reactionHeight - REACTION_BAR_OFFSET,
          menuLocalLeft,
          reactionHeight,
        );
      } else if (actionListEl) {
        applyPos(actionListEl, currentInteractionY - top + ACTION_LIST_OFFSET, menuLocalLeft, actionHeight);
      }
    } else {
      // Clamp vertically: prioritize bottom clamp over top clamp so interactive elements stay reachable
      if (top < offsetTop + topPad) {
        top = offsetTop + topPad;
      }
      if (top + currentContentHeight > offsetTop + vh - bottomPad) {
        top = offsetTop + vh - bottomPad - currentContentHeight;
      }
    }

    content.style.top = `${top}px`;
    content.style.left = `${left}px`;
    content.style.visibility = 'visible';
  }, [isSent, sourceRect, interactionPos, messageId]);

  // Body scroll lock
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Escape key dismissal
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function handleOverlayClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('[data-action-list]') || target.closest('[data-reaction-bar]')) {
      return;
    }
    onClose();
  }

  const bubbleCloneProps = {
    'data-bubble-clone': 'true' as const,
    className: isSticker ? undefined : styles.bubbleClone,
    style: { width: sourceRect.width },
  };

  let bubbleClone;
  if (props.messageType === 'sticker') {
    bubbleClone = (
      <StickerBubble
        stickerUrl={props.stickerUrl}
        senderName={senderName}
        isSent={isSent}
        showAvatar={false}
        replyTo={replyTo}
        timestamp={timestamp}
        edited={edited}
        isConfirmed={isConfirmed}
        layout="bubble-only"
        interactionMode="read-only"
        bubbleProps={bubbleCloneProps}
      />
    );
  } else {
    bubbleClone = (
      <ChatBubbleBase
        messageType={props.messageType}
        senderName={senderName}
        message={props.message}
        isSent={isSent}
        showName={showName}
        showAvatar={false}
        replyTo={replyTo}
        timestamp={timestamp}
        edited={edited}
        isConfirmed={isConfirmed}
        attachments={props.attachments}
        layout="bubble-only"
        interactionMode="read-only"
        bubbleProps={bubbleCloneProps}
      />
    );
  }

  const overlay = (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div
        ref={contentRef}
        className={`${styles.content} ${isSent ? styles.contentSent : ''} ${styles.contentVisible}`}
        style={{ top: sourceRect.top, left: sourceRect.left, visibility: 'hidden' }}
      >
        {/* Reaction bar — hidden for stickers */}
        {!isSticker &&
          reactions &&
          (() => {
            const currentReactionsCount = reactions.currentMessageReactions?.length ?? 0;
            const isLimitReached = currentReactionsCount >= MAX_DISTINCT_REACTIONS_PER_MESSAGE;

            return (
              <div className={styles.reactionBar} data-reaction-bar="true">
                {reactions.emojis.map((emoji) => {
                  const hasThisReaction = reactions.currentMessageReactions?.includes(emoji) ?? false;
                  const disabled = isLimitReached && !hasThisReaction;

                  return (
                    <button
                      key={emoji}
                      type="button"
                      className={styles.reactionBtn}
                      onClick={() => {
                        if (disabled) {
                          presentToast({
                            message: t`Cannot add more than ${MAX_DISTINCT_REACTIONS_PER_MESSAGE} different reactions`,
                            duration: 3000,
                            position: 'bottom',
                            cssClass: 'toast-center',
                          });
                          return;
                        }
                        reactions.onReact(emoji);
                        onClose();
                      }}
                    >
                      {emoji}
                    </button>
                  );
                })}
                {!isLimitReached && (
                  <button
                    type="button"
                    className={styles.reactionBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsEmojiPickerOpen(!isEmojiPickerOpen);
                    }}
                  >
                    <IonIcon icon={addOutline} style={{ color: 'var(--ion-text-color)' }} />
                  </button>
                )}
              </div>
            );
          })()}

        {/* Bubble clone */}
        {bubbleClone}

        {/* Action list */}
        <div className={styles.actionList} data-action-list="true">
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              disabled={action.disabled}
              className={`${styles.actionItem} ${action.role === 'destructive' ? styles.actionDestructive : ''} ${action.disabled ? styles.actionDisabled : ''}`}
              onClick={() => {
                if (action.disabled) return;
                action.handler();
                onClose();
              }}
            >
              {action.icon && <IonIcon icon={action.icon} />}
              {action.label}
            </button>
          ))}
        </div>
      </div>

      {isEmojiPickerOpen && (
        <div
          data-emoji-picker="true"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'var(--ion-background-color, #fff)',
            borderRadius: '12px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.28)',
            zIndex: 100000,
            overflow: 'hidden',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <EmojiPicker
            onEmojiClick={handleEmojiClick}
            theme={Theme.AUTO}
            emojiStyle={EmojiStyle.NATIVE}
            lazyLoadEmojis
            previewConfig={{ showPreview: false }}
            skinTonesDisabled
            width={Math.min(window.innerWidth - 32, 350)}
            height={Math.min(window.innerHeight - 32, 400)}
          />
        </div>
      )}
    </div>
  );

  return createPortal(overlay, getOverlayPortalTarget());
}
