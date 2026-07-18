import type { Ref } from 'react';
import { IonIcon } from '@ionic/react';
import { chatbubbles } from 'ionicons/icons';
import { t } from '@lingui/core/macro';
import { useMouseDetected } from '@/hooks/platformHooks';
import { InviteMessageCard } from './InviteMessageCard';
import { UserAvatar } from '@/components/UserAvatar';
import styles from './ChatBubble.module.scss';
import { HoverReplyButton } from './HoverReplyButton';
import { rowClassName } from './messageRowClass';
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
  focused?: boolean;
}

export function InviteBubble({
  inviteCode,
  senderName,
  isSent,
  avatarUrl,
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
  focused,
}: InviteBubbleProps) {
  const mouseDetected = useMouseDetected();
  const interactive = interactionMode === 'interactive';
  const { className: bubbleClassName, style: bubbleStyle, ...bubbleRestProps } = bubblePropOverrides ?? {};

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
        isSent={isSent}
        timestamp={timestamp ?? ''}
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
    return (
      <div className={rowClassName(styles.bubbleOnly, isSent, focused)} data-message-row>
        {bubble}
      </div>
    );
  }

  return (
    <div className={rowClassName(styles.chatRow, isSent, focused)}>
      <div className={styles.messageColumn}>
        <div className={styles.avatarBubbleRow}>
          {showAvatar ? (
            <UserAvatar
              name={senderName}
              avatarUrl={avatarUrl}
              size={36}
              className={styles.avatar}
              onClick={interactive ? onAvatarClick : undefined}
            />
          ) : (
            <div className={styles.avatarSpacer} />
          )}
          {bubble}
          <HoverReplyButton interactive={interactive} onReply={onReply} />
        </div>
      </div>
    </div>
  );
}
