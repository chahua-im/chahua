import { IonIcon, IonProgressBar } from '@ionic/react';
import { documentOutline } from 'ionicons/icons';
import { t } from '@lingui/core/macro';
import type { Attachment } from '@/api/messages';
import { formatFileSize } from '@/utils/formatFileSize';
import styles from './FileAttachmentCard.module.scss';

interface FileAttachmentCardProps {
  attachment: Attachment;
  interactive: boolean;
  uploadProgress?: number;
}

export function FileAttachmentCard({ attachment, interactive, uploadProgress }: FileAttachmentCardProps) {
  const isUploading = uploadProgress !== undefined && uploadProgress < 100;
  const content = (
    <>
      <IonIcon icon={documentOutline} className={styles.icon} aria-hidden="true" />
      <span className={styles.details}>
        <span className={styles.name}>{attachment.fileName}</span>
        <span className={styles.size}>{formatFileSize(attachment.size)}</span>
        {isUploading && <IonProgressBar value={uploadProgress / 100} className={styles.progress} />}
      </span>
    </>
  );

  if (isUploading || !interactive) return <div className={styles.card}>{content}</div>;

  return (
    <a
      className={styles.card}
      href={attachment.url}
      download={attachment.fileName}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t`Download ${attachment.fileName}`}
    >
      {content}
    </a>
  );
}
