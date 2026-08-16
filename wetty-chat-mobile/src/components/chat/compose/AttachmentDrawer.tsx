import { IonIcon } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { documentOutline, imageOutline } from 'ionicons/icons';
import { isFeatureEnabled } from '@/features';
import styles from './AttachmentDrawer.module.scss';

interface AttachmentDrawerProps {
  isOpen: boolean;
  onPickImage: () => void;
  onPickFile: () => void;
}

export function AttachmentDrawer({ isOpen, onPickImage, onPickFile }: AttachmentDrawerProps) {
  if (!isOpen) return null;

  return (
    <div className={styles.container} data-attachment-drawer>
      <div className={styles.grid}>
        <button type="button" className={styles.tile} onClick={onPickImage}>
          <span className={styles.iconArea}>
            <IonIcon icon={imageOutline} className={styles.tileIcon} aria-hidden="true" />
          </span>
          <span className={styles.tileLabel}>{t`Image`}</span>
        </button>
        {isFeatureEnabled('fileAttachments') && (
          <button type="button" className={styles.tile} onClick={onPickFile}>
            <span className={styles.iconArea}>
              <IonIcon icon={documentOutline} className={styles.tileIcon} aria-hidden="true" />
            </span>
            <span className={styles.tileLabel}>{t`File`}</span>
          </button>
        )}
      </div>
    </div>
  );
}
