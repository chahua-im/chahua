import type { Ref } from 'react';
import { IonIcon } from '@ionic/react';
import { arrowUndo, chatbubbles } from 'ionicons/icons';
import { t } from '@lingui/core/macro';
import type { User } from '@/api/messages';
import { useMouseDetected } from '@/hooks/platformHooks';
import { InviteMessageCard } from './InviteMessageCard';
import styles from './ChatBubble.module.scss';
import type { BubblePropsOverride } from './ChatBubbleBase';

export interface InviteBubbleProps {
  inviteCode: string;
  senderName: string;
  isSent: boolean;
  avatarUrl?: string;
  showName?: boolean;
  showAvatar?: boolean;
  onOpen?: () => void;
  onReply?: () => void;
  onAvatarClick?: () => void;
  timestamp?: string;
  threadInfo?: { replyCount: number };
  onThreadClick?: () => void;
  layout?: 'thread' | 'bubble-only';
  interactionMode?: 'interactive' | 'read-only';
  bubbleProps?: BubblePropsOverride;
  bubbleRef?: Ref<HTMLDivElement>;
}

export function InviteBubble({
  inviteCode,
  senderName,
  isSent,
  avatarUrl,
  showName = true,
  showAvatar = true,
  onOpen,
  onReply,
  onAvatarClick,
  timestamp,
  threadInfo,
  onThreadClick,
  layout = 'thread',
  interactionMode = 'interactive',
  bubbleProps: bubblePropOverrides,
  bubbleRef,
}: InviteBubbleProps) {
  const mouseDetected = useMouseDetected();
  const interactive = interactionMode === 'interactive';
  const { className: bubbleClassName, style: bubbleStyle, ...bubbleRestProps } = bubblePropOverrides ?? {};

  const sender: User = { uid: 0, name: senderName, avatarUrl, gender: 0 };

  const bubble = (
    <div
      ref={bubbleRef}
      {...bubbleRestProps}
      className={[styles.bubble, styles.inviteBubble, mouseDetected ? styles.mouseSelectable : '', bubbleClassName]
        .filter(Boolean)
        .join(' ')}
      style={bubbleStyle}
    >
      <InviteMessageCard
        inviteCode={inviteCode}
        sender={sender}
        isSent={isSent}
        showName={showName}
        showAvatar={showAvatar}
        timestamp={timestamp ?? ''}
        onAvatarClick={interactive ? onAvatarClick : undefined}
        onOpen={interactive && onOpen ? onOpen : () => {}}
      />
      {threadInfo && (
        <div className={styles.threadIndicator} onClick={interactive ? onThreadClick : undefined}>
          <IonIcon icon={chatbubbles} />
          <span>
            {threadInfo.replyCount} {threadInfo.replyCount === 1 ? t`reply` : t`replies`}
          </span>
        </div>
      )}
    </div>
  );

  if (layout === 'bubble-only') {
    return <div className={`${styles.bubbleOnly} ${isSent ? styles.sent : styles.received}`}>{bubble}</div>;
  }

  return (
    <div className={`${styles.chatRow} ${isSent ? styles.sent : styles.received}`}>
      {bubble}
      {interactive && onReply && (
        <button className={styles.hoverReplyBtn} onClick={onReply} aria-label={t`Reply`}>
          <IonIcon icon={arrowUndo} />
        </button>
      )}
    </div>
  );
}
