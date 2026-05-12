import { IonIcon } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { alertCircleOutline, closeCircle, documentOutline, refreshOutline } from 'ionicons/icons';
import { DisplayableImage } from '@/components/shared/DisplayableImage';
import { isHeicLikeMedia } from '@/utils/heicMedia';
import styles from './UploadPreview.module.scss';

export type UploadStatus = 'uploading' | 'uploaded' | 'error';

export interface UploadFileState {
  localId: string;
  kind: 'image' | 'video';
  name: string;
  previewUrl: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  order?: number;
  progress: number;
  status: UploadStatus;
  attachmentId?: string;
  errorMessage?: string;
}

export interface ExistingAttachmentPreview {
  localId: string;
  attachmentId: string;
  kind: string;
  name: string;
  previewUrl?: string;
}

export type UploadPreviewItem =
  | ({ itemType: 'pending' } & UploadFileState)
  | ({ itemType: 'existing' } & ExistingAttachmentPreview);

interface UploadPreviewProps {
  items: UploadPreviewItem[];
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}

export function UploadPreview({ items, onRemove, onRetry }: UploadPreviewProps) {
  if (items.length === 0) return null;

  return (
    <div className={styles.previewTray} aria-label={t`Attachment preview tray`}>
      {items.map((item) => {
        const mimeType = item.itemType === 'pending' ? item.mimeType : item.kind;
        const isImagePreview =
          item.kind === 'image' || item.kind.startsWith('image/') || isHeicLikeMedia({ mimeType, fileName: item.name });

        return (
          <article key={item.localId} className={styles.card}>
            {item.previewUrl ? (
              isImagePreview ? (
                <DisplayableImage
                  src={item.previewUrl}
                  mimeType={mimeType}
                  fileName={item.name}
                  alt={item.name}
                  className={styles.previewImage}
                />
              ) : (
                <video src={item.previewUrl} autoPlay loop muted className={styles.previewImage} />
              )
            ) : (
              <div className={styles.fileCard}>
                <IonIcon icon={documentOutline} className={styles.fileCardIcon} />
                <span className={styles.fileCardName}>{item.name}</span>
              </div>
            )}
            <button
              type="button"
              className={styles.removeButton}
              aria-label={t`Remove ${item.name}`}
              onClick={() => onRemove(item.localId)}
            >
              <IonIcon icon={closeCircle} />
            </button>

            {item.itemType === 'pending' && item.status !== 'uploaded' && (
              <div className={`${styles.overlay} ${item.status === 'error' ? styles.overlayError : ''}`}>
                {item.status === 'uploading' ? (
                  <>
                    <div className={styles.progressRing} aria-hidden="true">
                      <svg viewBox="0 0 36 36">
                        <path className={styles.progressTrack} d="M18 2.5a15.5 15.5 0 1 1 0 31a15.5 15.5 0 1 1 0-31" />
                        <path
                          className={styles.progressValue}
                          d="M18 2.5a15.5 15.5 0 1 1 0 31a15.5 15.5 0 1 1 0-31"
                          style={{ strokeDasharray: `${item.progress}, 100` }}
                        />
                      </svg>
                      <span className={styles.progressLabel}>{item.progress}%</span>
                    </div>
                    <span className={styles.statusText}>{t`Uploading`}</span>
                  </>
                ) : (
                  <>
                    <IonIcon icon={alertCircleOutline} className={styles.errorIcon} />
                    <span className={styles.statusText}>{item.errorMessage ?? t`Upload failed`}</span>
                    <button type="button" className={styles.retryButton} onClick={() => onRetry(item.localId)}>
                      <IonIcon icon={refreshOutline} />
                      {t`Retry`}
                    </button>
                  </>
                )}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

// When file/video/audio previews are added, keep this tray-level API unchanged and
// branch on file.kind into dedicated card renderers. The compose bar should continue
// to own upload lifecycle, while this component stays focused on presentation/actions.
