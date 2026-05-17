import { useState, type ReactNode } from 'react';
import { IonIcon } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { alertCircleOutline, closeCircle, documentOutline, refreshOutline } from 'ionicons/icons';
import { DisplayableImage } from '@/components/shared/DisplayableImage';
import { isHeicLikeMedia } from '@/utils/heicMedia';
import { ImageViewer, type ImageViewerItem } from '@/components/chat/messages/media/ImageViewer';
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function isVideoMedia(kind: string, mimeType: string): boolean {
  return kind === 'video' || kind.startsWith('video/') || mimeType.startsWith('video/');
}

interface DerivedItem {
  item: UploadPreviewItem;
  mimeType: string;
  isImagePreview: boolean;
  isVideoPreview: boolean;
  isUploaded: boolean;
  canPreview: boolean;
}

function deriveItemFlags(item: UploadPreviewItem): DerivedItem {
  const mimeType = item.itemType === 'pending' ? item.mimeType : item.kind;
  const isImagePreview =
    item.kind === 'image' || item.kind.startsWith('image/') || isHeicLikeMedia({ mimeType, fileName: item.name });
  const isVideoPreview = isVideoMedia(item.kind, mimeType);
  const isUploaded = item.itemType !== 'pending' || item.status === 'uploaded';
  const canPreview = (isImagePreview || isVideoPreview) && !!item.previewUrl && isUploaded;
  return { item, mimeType, isImagePreview, isVideoPreview, isUploaded, canPreview };
}

function renderCardMedia(derived: DerivedItem, onPreview: () => void): ReactNode {
  const { item, mimeType, isImagePreview, canPreview } = derived;

  if (!item.previewUrl) {
    return (
      <div className={styles.fileCard}>
        <IonIcon icon={documentOutline} className={styles.fileCardIcon} />
        <span className={styles.fileCardName}>{item.name}</span>
      </div>
    );
  }

  const thumbnail = isImagePreview ? (
    <DisplayableImage
      src={item.previewUrl}
      mimeType={mimeType}
      fileName={item.name}
      alt={item.name}
      className={styles.previewImage}
    />
  ) : (
    <video src={item.previewUrl} autoPlay loop muted className={styles.previewImage} />
  );

  if (canPreview) {
    return (
      <button
        type="button"
        className={styles.previewImageButton}
        aria-label={t`Preview ${item.name}`}
        onClick={onPreview}
      >
        {thumbnail}
      </button>
    );
  }

  return thumbnail;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function UploadPreview({ items, onRemove, onRetry }: UploadPreviewProps) {
  const [viewingLocalId, setViewingLocalId] = useState<string | null>(null);

  if (items.length === 0) return null;

  const derivedItems = items.map(deriveItemFlags);

  const viewableMedia: (ImageViewerItem & { localId: string })[] = derivedItems.flatMap(
    ({ item, mimeType, canPreview }) => {
      if (!canPreview || !item.previewUrl) return [];
      return [
        {
          localId: item.localId,
          src: item.previewUrl,
          kind: mimeType,
          fileName: item.name,
          width: item.itemType === 'pending' ? item.width : undefined,
          height: item.itemType === 'pending' ? item.height : undefined,
        },
      ];
    },
  );

  const viewingIndex = viewableMedia.findIndex((media) => media.localId === viewingLocalId);

  return (
    <>
      <div className={styles.previewTray} aria-label={t`Attachment preview tray`}>
        {derivedItems.map((derived) => {
          const { item } = derived;
          return (
            <article key={item.localId} className={styles.card}>
              {renderCardMedia(derived, () => setViewingLocalId(item.localId))}
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
                          <path
                            className={styles.progressTrack}
                            d="M18 2.5a15.5 15.5 0 1 1 0 31a15.5 15.5 0 1 1 0-31"
                          />
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
      {viewingIndex >= 0 && (
        <ImageViewer images={viewableMedia} initialIndex={viewingIndex} onClose={() => setViewingLocalId(null)} />
      )}
    </>
  );
}

// TODO: add audio preview support when needed. The tray-level API (items, onRemove, onRetry)
// should remain unchanged; branch on item.kind inside renderCardMedia.
