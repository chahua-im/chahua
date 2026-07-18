import { t } from '@lingui/core/macro';
import styles from './UnreadMessagesDivider.module.scss';

/**
 * Inline divider marking the read/unread boundary inside a chat timeline.
 * Renders a thin horizontal line on either side of a centered
 * "Unread messages" label. Positioned before the first unread message's
 * bubble (tagged on the containing group row via `unreadDividerBeforeMessageId`).
 *
 * Mirrors telegram-tt's `.unread-divider` (rendered inline before the first
 * unread message, memoized once per chat session so it keeps its position as
 * the user reads past it).
 */
export function UnreadMessagesDivider() {
  return (
    <div className={styles.divider} role="separator" aria-label={t`Unread messages`}>
      <span className={styles.line} aria-hidden />
      <span className={styles.label}>{t`Unread messages`}</span>
      <span className={styles.line} aria-hidden />
    </div>
  );
}
