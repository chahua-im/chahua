import { useContext, useEffect, useRef, useState } from 'react';
import styles from './ChatBubble.module.scss';
import { SenderSwipeContext } from './SenderSwipeContext';
import { ChatBubbleBase, type ChatBubbleBaseProps } from './ChatBubbleBase';
import { StickerBubble, type StickerBubbleProps } from './StickerBubble';
import { InviteBubble, type InviteBubbleProps } from './InviteBubble';

const SWIPE_THRESHOLD = 60;
const SWIPE_MAX = 80;
const LONG_PRESS_DELAY_MS = 350;

// Progress ring geometry: circle r=13 within a 36x36 viewBox.
// const REPLY_RING_CIRCUMFERENCE = 2 * Math.PI * 13; // disabled: progress ring hidden

type ChatBubbleInteractionProps = {
  swipeDirection?: 'left' | 'right';
  onLongPress?: (rect: DOMRect, interactionPos?: { x: number; y: number }) => void;
  /** True for the last message in a SenderGroup — only it reports its swipe to the
   *  group so the floating avatar can follow. Non-last messages never move the
   *  shared avatar. */
  isLastInGroup?: boolean;
};

type StickerChatBubbleProps = StickerBubbleProps &
  ChatBubbleInteractionProps & {
    messageType: 'sticker';
  };

type RegularChatBubbleProps = ChatBubbleBaseProps & ChatBubbleInteractionProps;

type InviteChatBubbleProps = InviteBubbleProps &
  ChatBubbleInteractionProps & {
    messageType: 'invite';
  };

export type ChatBubbleProps = StickerChatBubbleProps | RegularChatBubbleProps | InviteChatBubbleProps;

function renderInnerBubble(props: ChatBubbleProps, bubbleRef: React.RefObject<HTMLDivElement | null>): React.ReactNode {
  if (props.messageType === 'sticker') {
    return (
      <StickerBubble
        stickerUrl={props.stickerUrl}
        senderName={props.senderName}
        isSent={props.isSent}
        avatarUrl={props.avatarUrl}
        showAvatar={props.showAvatar}
        onStickerTap={props.onStickerTap}
        onReply={props.onReply}
        onReplyTap={props.onReplyTap}
        onAvatarClick={props.onAvatarClick}
        replyTo={props.replyTo}
        timestamp={props.timestamp}
        edited={props.edited}
        isConfirmed={props.isConfirmed}
        threadInfo={props.threadInfo}
        onThreadClick={props.onThreadClick}
        layout={props.layout}
        interactionMode={props.interactionMode}
        bubbleProps={props.bubbleProps}
        bubbleRef={bubbleRef}
      />
    );
  }
  if (props.messageType === 'invite') {
    return (
      <InviteBubble
        inviteCode={props.inviteCode}
        senderName={props.senderName}
        isSent={props.isSent}
        avatarUrl={props.avatarUrl}
        showAvatar={props.showAvatar}
        showName={props.showName}
        onOpen={props.onOpen}
        onReply={props.onReply}
        onAvatarClick={props.onAvatarClick}
        timestamp={props.timestamp}
        threadInfo={props.threadInfo}
        onThreadClick={props.onThreadClick}
        layout={props.layout}
        interactionMode={props.interactionMode}
        bubbleProps={props.bubbleProps}
        bubbleRef={bubbleRef}
      />
    );
  }
  // RegularChatBubbleProps includes swipeDirection/onLongPress that ChatBubbleBase doesn't accept
  const baseProps: ChatBubbleBaseProps = props;
  return <ChatBubbleBase {...baseProps} bubbleRef={bubbleRef} />;
}

export function ChatBubble(props: ChatBubbleProps) {
  const { swipeDirection = 'left', onLongPress, onReply, isLastInGroup } = props;
  const swipeSign = swipeDirection === 'left' ? -1 : 1;
  const swipeCtx = useContext(SenderSwipeContext);

  const [offset, setOffset] = useState(0);
  const [animating, setAnimating] = useState(false);

  // Report this bubble's live swipe offset to the SenderGroup. Every bubble
  // reports so the group can raise its message column z-index while swiping
  // (bubble paints OVER the avatar); the last message additionally drives the
  // floating avatar's horizontal transform (isLastInGroup gate lives inside
  // SenderGroup.reportSwipe). Mutates the DOM directly (no state) so swiping
  // stays 60fps. When the context is null (search / read-only / showAllAvatars
  // inline mode) this is a no-op.
  useEffect(() => {
    if (!swipeCtx) return;
    swipeCtx.reportSwipe(offset * swipeSign, animating, !!isLastInGroup);
  }, [offset, animating, isLastInGroup, swipeCtx, swipeSign]);

  // On unmount, release the avatar so it doesn't keep a stale transform. Only
  // the last message owns the avatar transform, so only it needs this cleanup;
  // non-last bubbles reset the column z-index via the offset effect above when
  // their swipe ends (offset → 0).
  useEffect(() => {
    return () => {
      if (isLastInGroup && swipeCtx) swipeCtx.reportSwipe(0, false, isLastInGroup);
    };
  }, [isLastInGroup, swipeCtx]);
  const startX = useRef(0);
  const startY = useRef(0);
  const swiping = useRef(false);
  const directionLocked = useRef<'horizontal' | 'vertical' | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  // Ripple feedback: replays an expanding pulse each time the swipe first
  // crosses the release threshold. rippleKey forces the element to remount so
  // the CSS animation restarts on every crossing.
  // const [rippleKey, setRippleKey] = useState(0); // disabled: ripple pulse hidden
  const reachedThreshold = useRef(false);
  // Burst feedback: the reply icon briefly expands then snaps back when the
  // progress ring fills, as if it launched the ripple outward.
  const [bursting, setBursting] = useState(false);

  function clearLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  function onTouchStart(e: React.TouchEvent) {
    const touch = e.touches[0];
    startX.current = touch.clientX;
    startY.current = touch.clientY;
    swiping.current = false;
    directionLocked.current = null;
    setAnimating(false);

    if (onLongPress) {
      longPressTimer.current = setTimeout(() => {
        if (bubbleRef.current) {
          onLongPress(bubbleRef.current.getBoundingClientRect(), {
            x: startX.current,
            y: startY.current,
          });
        }
      }, LONG_PRESS_DELAY_MS);
    }
  }

  function onTouchMove(e: React.TouchEvent) {
    const touch = e.touches[0];
    const dx = touch.clientX - startX.current;
    const dy = touch.clientY - startY.current;

    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
      clearLongPress();
    }

    if (!onReply) return;

    if (!directionLocked.current) {
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        directionLocked.current = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
      }
    }

    if (directionLocked.current !== 'horizontal') return;

    const clamped = Math.min(Math.max(dx * swipeSign, 0), SWIPE_MAX);
    if (clamped > 0) {
      swiping.current = true;
      setOffset(clamped);
    }

    // Fire the ripple once, on the rising edge of crossing the threshold.
    if (clamped >= SWIPE_THRESHOLD) {
      if (!reachedThreshold.current) {
        reachedThreshold.current = true;
        // setRippleKey((k) => k + 1); // disabled: ripple pulse hidden
        setBursting(true);
      }
    } else {
      reachedThreshold.current = false;
    }
  }

  function onTouchEnd() {
    clearLongPress();
    if (!onReply || !swiping.current) return;
    if (offset >= SWIPE_THRESHOLD) {
      onReply();
    }
    setAnimating(true);
    setOffset(0);
  }

  function handleContextMenu(e: React.MouseEvent) {
    if (onLongPress && bubbleRef.current) {
      e.preventDefault();
      onLongPress(bubbleRef.current.getBoundingClientRect(), {
        x: e.clientX,
        y: e.clientY,
      });
    }
  }

  const progress = Math.min(offset / SWIPE_THRESHOLD, 1);
  // Fill only starts after 50% of the threshold — maps progress [0.5,1] → [0,1]
  const fillProgress = Math.max(0, progress * 2 - 1);

  return (
    <div className={styles.swipeRoot}>
      <div
        className={`${styles.replyIcon}${bursting ? ` ${styles.replyIconBurst}` : ''}`}
        style={{
          opacity: progress,
          transform: `scale(${0.5 + progress * 0.5})`,
          [swipeDirection === 'left' ? 'right' : 'left']: 16,
        }}
        onAnimationEnd={() => setBursting(false)}
      >
        <svg className={styles.replyProgressRing} viewBox="0 0 36 36" aria-hidden="true">
          {/* Progress ring (backdrop / track / fill) — disabled, keep code for re-enabling
          {progress < 1 && (
            <>
              <circle className={styles.replyProgressBackdrop} cx="18" cy="18" r="13" />
              <circle className={styles.replyProgressTrack} cx="18" cy="18" r="13" />
              <circle
                className={styles.replyProgressFill}
                cx="18"
                cy="18"
                r="13"
                style={{
                  strokeDasharray: REPLY_RING_CIRCUMFERENCE,
                  strokeDashoffset: REPLY_RING_CIRCUMFERENCE * (1 - progress),
                }}
              />
            </>
          )}
          */}
          {/* Ripple pulse — disabled, keep code for re-enabling
          {rippleKey > 0 && <circle key={rippleKey} className={styles.replyProgressRipple} cx="18" cy="18" r="13" />}
          */}
          {/* Reply arrow icon — exact arrowUndoOutline path, scaled to 36×36 viewBox */}
          <g transform="translate(7, 7) scale(0.044) rotate(90, 256, 256)">
            {/* Outline layer — always visible */}
            <path
              d="M240 424v-96c116.4 0 159.39 33.76 208 96 0-119.23-39.57-240-208-240V88L64 256Z"
              stroke="currentColor"
              fill="none"
              strokeWidth="35"
              strokeLinejoin="round"
            />
            {/* Filled layer — clipped by progress */}
            <g
              style={{
                clipPath:
                  swipeDirection === 'left'
                    ? `inset(0 0 0 ${(1 - fillProgress) * 100}%)`
                    : `inset(0 ${(1 - fillProgress) * 100}% 0 0)`,
              }}
            >
              <path
                d="M240 424v-96c116.4 0 159.39 33.76 208 96 0-119.23-39.57-240-208-240V88L64 256Z"
                fill="currentColor"
                stroke="none"
              />
            </g>
          </g>
        </svg>
      </div>
      <div className={styles.swipeContainer}>
        <div
          className={`${styles.swipeContent} ${animating ? styles.snapBack : ''}`}
          style={{ transform: `translateX(${offset * swipeSign}px)` }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onContextMenu={handleContextMenu}
          onTransitionEnd={() => setAnimating(false)}
        >
          {renderInnerBubble(props, bubbleRef)}
        </div>
      </div>
    </div>
  );
}
