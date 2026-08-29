import React, { useMemo } from 'react';
import type { Attachment } from '@/api/messages';
import { SingleMediaAttachment } from './SingleMediaAttachment';
import {
  getSingleMediaBounds,
  MEDIA_CONSTANTS,
  MAX_ATTACHMENT_PREVIEWS,
  MIN_PREVIEW_AR,
  MAX_PREVIEW_AR,
  FALLBACK_DIMENSION,
} from '@/constants/media';
import { computeMultiImageLayout } from '@/utils/multiImageLayout';
import styles from './JustifiedMediaGallery.module.scss';
import type { ReactNode, CSSProperties } from 'react';

interface JustifiedMediaGalleryProps {
  attachments: Attachment[];
  interactive: boolean;
  onView: (id: string) => void;
  renderElement: (id: string, style?: CSSProperties) => ReactNode;
}

export const JustifiedMediaGallery: React.FC<JustifiedMediaGalleryProps> = ({
  attachments,
  interactive,
  onView,
  renderElement,
}) => {
  const { MAX_WIDTH, MAX_HEIGHT, MIN_WIDTH, MIN_HEIGHT } = useMemo(() => getSingleMediaBounds(), []);

  const { items, layout, layoutHeight, extraCount } = useMemo(() => {
    if (!attachments || attachments.length <= 1) {
      return { items: [], layout: null, layoutHeight: 0, extraCount: 0 };
    }

    const sliced = attachments.slice(0, MAX_ATTACHMENT_PREVIEWS);
    const images = sliced.map((att) => ({
      aspectRatio: Math.max(
        MIN_PREVIEW_AR,
        Math.min(MAX_PREVIEW_AR, (att.width || FALLBACK_DIMENSION) / (att.height || FALLBACK_DIMENSION)),
      ),
    }));

    const { rects: computedLayout, height: computedHeight } = computeMultiImageLayout(images, {
      containerWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT,
      gap: MEDIA_CONSTANTS.GAP,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
    });

    const extra = attachments.length > MAX_ATTACHMENT_PREVIEWS ? attachments.length - MAX_ATTACHMENT_PREVIEWS + 1 : 0;

    return { items: sliced, layout: computedLayout, layoutHeight: computedHeight, extraCount: extra };
  }, [attachments, MAX_WIDTH, MAX_HEIGHT]);

  if (!attachments || attachments.length === 0) return null;

  if (attachments.length === 1) {
    return (
      <SingleMediaAttachment
        attachment={attachments[0]}
        interactive={interactive}
        onView={() => onView(attachments[0].id)}
        renderElement={renderElement.bind(null, attachments[0].id)}
      />
    );
  }

  if (!layout) return null;

  return (
    <div
      className={styles.galleryContainer}
      style={{
        width: `${MAX_WIDTH}px`,
        maxWidth: '100%',
        maxHeight: `${MAX_HEIGHT}px`,
        aspectRatio: `${MAX_WIDTH} / ${layoutHeight}`,
      }}
    >
      {layout.map((rect, i) => {
        const att = items[i];
        if (!att) return null;

        const isLastPreview = i === layout.length - 1;
        const showOverlay = isLastPreview && extraCount > 0;

        const leftPct = (rect.x / MAX_WIDTH) * 100;
        const topPct = (rect.y / layoutHeight) * 100;
        const widthPct = (rect.width / MAX_WIDTH) * 100;
        const heightPct = rect.y + rect.height <= layoutHeight ? (rect.height / layoutHeight) * 100 : 100 - topPct;

        return (
          <div
            key={att.id || i}
            style={{
              position: 'absolute',
              left: `${leftPct}%`,
              top: `${topPct}%`,
              width: `${widthPct}%`,
              height: `${heightPct}%`,
              overflow: 'hidden',
              cursor: interactive ? 'pointer' : 'default',
              backgroundColor: 'transparent',
            }}
            onClick={(e) => {
              if (!interactive) return;
              e.stopPropagation();
              onView(att.id);
            }}
          >
            {renderElement(att.id, {
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
              position: 'absolute',
              top: 0,
              left: 0,
            })}

            {showOverlay && (
              <div className={styles.moreOverlay} style={{ zIndex: 2 }}>
                +{extraCount}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default JustifiedMediaGallery;
