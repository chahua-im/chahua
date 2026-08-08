import { useMemo, useState } from 'react';
import { IonButton, IonSpinner } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ChatAttachmentListItem } from '@/api/attachments';
import { ImageViewer, type ImageViewerItem } from '@/components/chat/messages/media/ImageViewer';
import { isImageKind } from '@/types/attachmentKind';
import { ChatAttachmentGrid } from './ChatAttachmentGrid';
import { ChatAttachmentTabs, type AttachmentTabFilter } from './ChatAttachmentTabs';
import { useChatAttachments } from './useChatAttachments';
import styles from './ChatAttachmentSection.module.scss';

interface ChatAttachmentSectionProps {
  chatId: string;
}

function isVisualAttachment(attachment: ChatAttachmentListItem) {
  return isImageKind(attachment.kind, attachment) || attachment.kind.startsWith('video/');
}

function toViewerItem(attachment: ChatAttachmentListItem): ImageViewerItem {
  return {
    id: attachment.id,
    kind: attachment.kind,
    src: attachment.url,
    fileName: attachment.fileName,
    width: attachment.width,
    height: attachment.height,
  };
}

function emptyLabel(filter: AttachmentTabFilter) {
  if (filter === 'image') return t`No images yet`;
  return t`No videos yet`;
}

export function ChatAttachmentSection({ chatId }: ChatAttachmentSectionProps) {
  const [filter, setFilter] = useState<AttachmentTabFilter>('image');
  const [viewingAttachmentId, setViewingAttachmentId] = useState<string | null>(null);
  const { attachments, loading, loadingMore, error, hasOlder, loadOlder } = useChatAttachments(chatId, filter);
  const visualAttachments = useMemo(() => attachments.filter(isVisualAttachment), [attachments]);
  const viewerItems = useMemo(() => visualAttachments.map(toViewerItem), [visualAttachments]);
  const viewingIndex = viewingAttachmentId ? viewerItems.findIndex((item) => item.id === viewingAttachmentId) : -1;
  const hasVisibleContent = visualAttachments.length > 0;

  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.title}>
          <Trans>Media & Files</Trans>
        </h2>
      </div>

      <ChatAttachmentTabs value={filter} onChange={setFilter} />

      <div className={styles.content}>
        {loading ? (
          <div className={styles.loadingState}>
            <IonSpinner />
          </div>
        ) : error ? (
          <div className={styles.messageState}>{t`Failed to load attachments`}</div>
        ) : !hasVisibleContent ? (
          <div className={styles.messageState}>{emptyLabel(filter)}</div>
        ) : (
          <ChatAttachmentGrid attachments={visualAttachments} onOpen={setViewingAttachmentId} />
        )}
      </div>

      {!loading && hasOlder && (
        <IonButton expand="block" fill="clear" disabled={loadingMore} onClick={loadOlder} className={styles.loadMore}>
          {loadingMore ? <IonSpinner name="crescent" /> : <Trans>Load More</Trans>}
        </IonButton>
      )}

      {viewingIndex >= 0 && (
        <ImageViewer images={viewerItems} initialIndex={viewingIndex} onClose={() => setViewingAttachmentId(null)} />
      )}
    </section>
  );
}
