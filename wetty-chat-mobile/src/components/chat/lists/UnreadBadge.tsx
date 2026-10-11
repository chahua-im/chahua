import { IonBadge, IonIcon } from '@ionic/react';
import { at, heartOutline } from 'ionicons/icons';
import { t } from '@lingui/core/macro';

import styles from './UnreadBadge.module.scss';

interface UnreadBadgeProps {
  icon: string;
  ariaLabel: string;
  /** Muted chats render the badge in a neutral color, mirroring the unread badge. */
  muted?: boolean;
}

/** Shared round icon badge for unread-mention and unread-reaction list rows. */
export function UnreadBadge({ icon, ariaLabel, muted = false }: UnreadBadgeProps) {
  return (
    <IonBadge mode="ios" color={muted ? 'medium' : 'primary'} className={styles.unreadBadge} aria-label={ariaLabel}>
      <IonIcon icon={icon} />
    </IonBadge>
  );
}

export function MentionBadge({ muted = false }: { muted?: boolean }) {
  return <UnreadBadge icon={at} ariaLabel={t`Unread mentions and replies`} muted={muted} />;
}

export function ReactionBadge({ muted = false }: { muted?: boolean }) {
  return <UnreadBadge icon={heartOutline} ariaLabel={t`Unread reactions`} muted={muted} />;
}
