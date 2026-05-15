import type { Ref } from 'react';
import { IonIcon } from '@ionic/react';
import { arrowUndo, chatbubbles, checkmarkCircle, checkmarkCircleOutline } from 'ionicons/icons';
import { t } from '@lingui/core/macro';
import { StickerImage } from '@/components/shared/StickerImage';
import { useSelector } from 'react-redux';
import styles from './ChatBubble.module.scss';
import { formatMessagePreview, type PreviewMessage, getNotificationPreviewLabels } from '@/utils/messagePreview';
import { selectEffectiveLocale } from '@/store/settingsSlice';
import { UserAvatar } from '@/components/UserAvatar';
import { useMouseDetected } from '@/hooks/platformHooks';
import type { BubblePropsOverride } from './ChatBubbleBase';

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export interface StickerBubbleProps {
  messageType?: 'sticker';
  stickerUrl: string;
  senderName: string;
  isSent: boolean;
  avatarUrl?: string;
  showAvatar?: boolean;
  onReply?: () => void;
  onReplyTap?: () => void;
  onStickerTap?: () => void;
  onAvatarClick?: () => void;
  replyTo?: {
    senderName: string;
    preview: PreviewMessage;
  };
  timestamp?: string;
  edited?: boolean;
  isConfirmed?: boolean;
  threadInfo?: { replyCount: number };
  onThreadClick?: () => void;
  layout?: 'thread' | 'bubble-only';
  interactionMode?: 'interactive' | 'read-only';
  bubbleProps?: BubblePropsOverride;
  bubbleRef?: Ref<HTMLDivElement>;
}

export function StickerBubble({
  stickerUrl,
  senderName,
  isSent,
  avatarUrl,
  showAvatar = true,
  onStickerTap,
  onReply,
  onReplyTap,
  onAvatarClick,
  replyTo,
  timestamp,
  edited,
  isConfirmed,
  threadInfo,
  onThreadClick,
  layout = 'thread',
  interactionMode = 'interactive',
  bubbleProps: bubblePropOverrides,
  bubbleRef,
}: StickerBubbleProps) {
  const mouseDetected = useMouseDetected();
  const locale = useSelector(selectEffectiveLocale);
  const interactive = interactionMode === 'interactive';
  const { className: bubbleClassName, style: bubbleStyle, ...bubbleRestProps } = bubblePropOverrides ?? {};

  const bubble = (
    <div
      ref={bubbleRef}
      {...bubbleRestProps}
      className={[styles.bubble, styles.stickerBubble, mouseDetected ? styles.mouseSelectable : '', bubbleClassName]
        .filter(Boolean)
        .join(' ')}
      style={bubbleStyle}
    >
      {replyTo && (
        <div
          className={`${styles.replyPreview} ${interactive && onReplyTap ? styles.replyPreviewTappable : ''}`}
          onClick={interactive ? onReplyTap : undefined}
        >
          <div className={styles.replyPreviewName}>{replyTo.senderName}</div>
          <div className={styles.replyPreviewText}>
            {formatMessagePreview(replyTo.preview, getNotificationPreviewLabels(locale))}
          </div>
        </div>
      )}
      <div className={styles.stickerContainer}>
        <StickerImage
          src={stickerUrl}
          alt={t`Sticker`}
          className={styles.stickerImage}
          onClick={interactive && onStickerTap ? onStickerTap : undefined}
          style={interactive && onStickerTap ? { cursor: 'pointer' } : undefined}
        />
        {timestamp && (
          <span className={styles.stickerTimestamp}>
            {formatTime(timestamp)}
            {edited && ` (${t`Edited`})`}
            {isSent && (
              <IonIcon icon={isConfirmed ? checkmarkCircle : checkmarkCircleOutline} className={styles.statusIcon} />
            )}
          </span>
        )}
      </div>
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
      {interactive && onReply && (
        <button className={styles.hoverReplyBtn} onClick={onReply} aria-label={t`Reply`}>
          <IonIcon icon={arrowUndo} />
        </button>
      )}
    </div>
  );
}
