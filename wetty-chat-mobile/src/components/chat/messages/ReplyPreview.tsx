import { useSelector } from 'react-redux';
import { IonIcon } from '@ionic/react';
import { arrowRedoOutline } from 'ionicons/icons';
import { t } from '@lingui/core/macro';
import { formatMessagePreview, type PreviewMessage, getNotificationPreviewLabels } from '@/utils/messagePreview';
import { selectEffectiveLocale } from '@/store/settingsSlice';
import { colorForUser } from '@/utils/userColor';
import styles from './ChatBubble.module.scss';

export interface ReplyPreviewInfo {
  senderName: string;
  preview: PreviewMessage;
  forwardedFromName?: string | null;
}

interface ReplyPreviewProps {
  replyTo: ReplyPreviewInfo;
  isSent?: boolean;
  interactive?: boolean;
  onReplyTap?: () => void;
}

export function ReplyPreview({ replyTo, isSent, interactive, onReplyTap }: ReplyPreviewProps) {
  const locale = useSelector(selectEffectiveLocale);
  const color = isSent ? undefined : colorForUser(replyTo.senderName);

  return (
    <div
      className={`${styles.replyPreview} ${interactive && onReplyTap ? styles.replyPreviewTappable : ''}`}
      onClick={interactive ? onReplyTap : undefined}
      style={
        color
          ? {
              borderLeftColor: color,
              backgroundColor: `${color}1a`,
            }
          : undefined
      }
    >
      {replyTo.forwardedFromName ? (
        <div className={styles.forwardedLabel}>
          <IonIcon icon={arrowRedoOutline} className={styles.forwardedIcon} />
          {t`Forwarded from ${replyTo.forwardedFromName}`}
        </div>
      ) : (
        <div className={styles.replyPreviewName} style={color ? { color } : undefined}>
          {replyTo.senderName}
        </div>
      )}
      <div className={styles.replyPreviewText}>
        {formatMessagePreview(replyTo.preview, getNotificationPreviewLabels(locale))}
      </div>
    </div>
  );
}
