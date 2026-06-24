import { IonIcon } from '@ionic/react';
import { arrowRedoOutline } from 'ionicons/icons';
import { t } from '@lingui/core/macro';
import styles from './ForwardedLabel.module.scss';

interface ForwardedLabelProps {
  name: string | null | undefined;
  /** Use inline variant when rendered inside a <span> context (e.g. compose banner). */
  as?: 'div' | 'span';
}

export function ForwardedLabel({ name, as: Tag = 'div' }: ForwardedLabelProps) {
  return (
    <Tag className={styles.forwardedLabel}>
      <IonIcon icon={arrowRedoOutline} className={styles.forwardedIcon} />
      {t`Forwarded from ${name || t`Unknown`}`}
    </Tag>
  );
}
