import { useRef, useState } from 'react';
import { IonIcon } from '@ionic/react';
import { arrowUndo } from 'ionicons/icons';
import styles from './ChatBubble.module.scss';
import { ChatBubbleBase, type ChatBubbleBaseProps } from './ChatBubbleBase';
import { StickerBubble, type StickerBubbleProps } from './StickerBubble';
import { InviteBubble, type InviteBubbleProps } from './InviteBubble';

const SWIPE_THRESHOLD = 60;
const SWIPE_MAX = 80;
const LONG_PRESS_DELAY_MS = 350;

type ChatBubbleInteractionProps = {
  swipeDirection?: 'left' | 'right';
  onLongPress?: (rect: DOMRect, interactionPos?: { x: number; y: number }) => void;
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
  const { swipeDirection = 'left', onLongPress, onReply } = props;
  const swipeSign = swipeDirection === 'left' ? -1 : 1;
  const [offset, setOffset] = useState(0);
  const [animating, setAnimating] = useState(false);
  const startX = useRef(0);
  const startY = useRef(0);
  const swiping = useRef(false);
  const directionLocked = useRef<'horizontal' | 'vertical' | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className={styles.swipeContainer}>
      <div
        className={styles.replyIcon}
        style={{
          opacity: progress,
          transform: `scale(${0.5 + progress * 0.5})`,
          [swipeDirection === 'left' ? 'right' : 'left']: 16,
        }}
      >
        <IonIcon icon={arrowUndo} />
      </div>
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
  );
}
