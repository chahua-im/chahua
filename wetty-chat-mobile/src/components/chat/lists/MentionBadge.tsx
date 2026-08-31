import { IonBadge, IonIcon } from '@ionic/react';
import { at } from 'ionicons/icons';
import { t } from '@lingui/core/macro';

import styles from './MentionBadge.module.scss';

interface MentionBadgeProps {
  /** Muted chats render the badge in a neutral color, mirroring the unread badge. */
  muted?: boolean;
}

export function MentionBadge({ muted = false }: MentionBadgeProps) {
  return (
    <IonBadge
      mode="ios"
      color={muted ? 'medium' : 'primary'}
      className={styles.mentionBadge}
      aria-label={t`Unread mentions`}
    >
      <IonIcon icon={at} />
    </IonBadge>
  );
}
