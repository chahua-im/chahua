import { type ReactNode, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { IonBadge, IonIcon, IonItem, IonItemOption, IonItemOptions, IonItemSliding, IonLabel } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { toMessagePreview, type MessagePreview } from '@/api/messages';
import type { StoredThreadListItem } from '@/api/threads';
import { OverlayAvatar } from '@/components/OverlayAvatar';
import type { RootState } from '@/store/index';
import { selectLatestThreadReplyMessage } from '@/store/messagesSlice';
import { formatMessagePreview, getNotificationPreviewLabels, truncatePreview } from '@/utils/messagePreview';
import styles from './ThreadListRow.module.scss';

function formatRelativeTime(isoString: string, locale: string): string {
  const date = new Date(isoString);
  const now = new Date();

  const isSameDay =
    date.getDate() === now.getDate() && date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();

  if (isSameDay) {
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });

    if (diffMins < 60) {
      return rtf.format(-Math.max(1, diffMins), 'minute');
    }
    return rtf.format(-Math.floor(diffMins / 60), 'hour');
  }

  const isSameYear = date.getFullYear() === now.getFullYear();
  if (isSameYear) {
    return Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
  }
  return Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}
function formatReplyPreview(reply: MessagePreview, locale: string): string {
  return formatMessagePreview(reply, getNotificationPreviewLabels(locale));
}

interface ThreadListRowProps {
  thread: StoredThreadListItem;
  locale: string;
  isActive?: boolean;
  draftText?: string;
  onSelect: (chatId: string, threadRootId: string) => void;
  endAction?: {
    color: string;
    icon: string;
    label: ReactNode;
    onAction: () => void;
  };
}

export function ThreadListRow({ thread, locale, isActive, draftText, onSelect, endAction }: ThreadListRowProps) {
  const rootMsg = thread.threadRootMessage;
  const rootPreview = formatMessagePreview(rootMsg, getNotificationPreviewLabels(locale));

  const liveMessage = useSelector((state: RootState) =>
    selectLatestThreadReplyMessage(state, thread.chatId, rootMsg.id),
  );

  const lastReply = useMemo(() => {
    if (liveMessage) {
      return toMessagePreview(liveMessage);
    }
    return thread.cachedLastReply;
  }, [liveMessage, thread.cachedLastReply]);

  const lastReplyPreview = lastReply ? formatReplyPreview(lastReply, locale) : null;

  const content = (
    <IonItem
      button
      detail={false}
      className={`${styles.threadRow} ${thread.unreadCount > 0 ? styles.unread : ''} ${isActive ? styles.active : ''}`}
      onClick={() => onSelect(thread.chatId, rootMsg.id)}
    >
      {/* Rows 2-4: avatar + content */}
      <span slot="start">
        <OverlayAvatar
          primaryName={thread.chatName}
          primaryAvatarUrl={thread.chatAvatar}
          secondaryName={rootMsg.sender.name ?? null}
          secondaryAvatarUrl={rootMsg.sender.avatarUrl ?? null}
          size={48}
        />
      </span>
      <IonLabel className={styles.bodyContent}>
        {/* Row 2: replied to */}
        <div className={styles.repliedTo}>{rootPreview || rootMsg.sender.name}</div>
        {/* Row 3: latest reply or draft */}
        {draftText !== undefined ? (
          <p className={styles.latestReply}>
            <span className={styles.draftLabel}>{t`Draft: `}</span>
            {truncatePreview(draftText)}
          </p>
        ) : (
          lastReply &&
          lastReplyPreview && (
            <p className={styles.latestReply}>
              <span className={styles.latestReplySender}>{lastReply.sender.name ?? 'User'}:</span> {lastReplyPreview}
            </p>
          )
        )}
      </IonLabel>
      <div slot="end" className={styles.chatsListEndSlot}>
        <div className={styles.chatsListTime}>{formatRelativeTime(thread.lastReplyAt, locale)}</div>
        <div className={styles.chatsListBadge}>
          {thread.unreadCount > 0 && (
            <IonBadge color="primary" className={styles.unreadBadge}>
              {thread.unreadCount}
            </IonBadge>
          )}
        </div>
      </div>
    </IonItem>
  );

  if (!endAction) {
    return content;
  }

  return (
    <IonItemSliding>
      <IonItemOptions side="end">
        <IonItemOption color={endAction.color} expandable onClick={endAction.onAction}>
          <IonIcon slot="top" icon={endAction.icon} />
          {endAction.label}
        </IonItemOption>
      </IonItemOptions>
      {content}
    </IonItemSliding>
  );
}
