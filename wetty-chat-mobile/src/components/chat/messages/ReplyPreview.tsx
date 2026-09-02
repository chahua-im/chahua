import { useSelector } from 'react-redux';
import { formatMessagePreview, type PreviewMessage, getNotificationPreviewLabels } from '@/utils/messagePreview';
import { useIsDarkMode } from '@/hooks/platformHooks';
import { selectEffectiveLocale } from '@/store/settingsSlice';
import { colorForUser } from '@/utils/userColor';
import styles from './ChatBubble.module.scss';

export interface ReplyPreviewInfo {
  senderName: string;
  preview: PreviewMessage;
}

interface ReplyPreviewProps {
  replyTo: ReplyPreviewInfo;
  isSent?: boolean;
  interactive?: boolean;
  onReplyTap?: () => void;
}

export function ReplyPreview({ replyTo, isSent, interactive, onReplyTap }: ReplyPreviewProps) {
  const locale = useSelector(selectEffectiveLocale);
  const isDarkMode = useIsDarkMode();
  // When the sender name is withheld (DMs), the preview is a plain uncolored strip.
  const hasName = replyTo.senderName.trim() !== '';
  const color = !hasName || isSent ? undefined : colorForUser(replyTo.senderName, isDarkMode);

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
      {hasName && (
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
