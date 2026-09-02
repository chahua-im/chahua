import { IonIcon } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { closeCircle } from 'ionicons/icons';
import { useSelector } from 'react-redux';
import { selectEffectiveLocale } from '@/store/settingsSlice';
import { useChatContext } from '@/components/chat/messages/ChatContext';
import { formatMessagePreview, getNotificationPreviewLabels } from '@/utils/messagePreview';
import type { EditingMessage, ReplyTo } from './types';
import styles from './MessageComposeBar.module.scss';

interface ComposeContextBannerProps {
  editing?: EditingMessage;
  replyTo?: ReplyTo;
  onCancelEdit?: () => void;
  onCancelReply?: () => void;
}

export function ComposeContextBanner({ editing, replyTo, onCancelEdit, onCancelReply }: ComposeContextBannerProps) {
  const locale = useSelector(selectEffectiveLocale);

  const ctx = useChatContext();

  if (editing) {
    return (
      <div className={styles.replyPreview}>
        <div className={styles.replyText}>
          <span className={styles.replyUsername}>{t`Edit message`}</span>
          <span className={styles.replySnippet}>{editing.text}</span>
        </div>
        <button type="button" className={styles.replyClose} aria-label={t`Cancel edit`} onClick={onCancelEdit}>
          <IonIcon icon={closeCircle} />
        </button>
      </div>
    );
  }

  if (!replyTo) {
    return null;
  }

  const handleJumpToReply = () => {
    ctx?.jumpToMessage(replyTo.messageId);
  };

  return (
    <div className={styles.replyPreview}>
      <div className={`${styles.replyText} ${styles.replyPreviewTappable}`} onClick={handleJumpToReply}>
        <span className={styles.replyUsername}>{t`Replying to ${replyTo.username}`}</span>
        <span className={styles.replySnippet}>
          {formatMessagePreview(replyTo, getNotificationPreviewLabels(locale))}
        </span>
      </div>
      <button type="button" className={styles.replyClose} aria-label={t`Cancel reply`} onClick={onCancelReply}>
        <IonIcon icon={closeCircle} />
      </button>
    </div>
  );
}
