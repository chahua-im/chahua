import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IonIcon } from '@ionic/react';
import { t } from '@lingui/core/macro';
import { chevronBack, chevronForward, close, contractOutline, download, expandOutline } from 'ionicons/icons';
import { useIsDesktop } from '@/hooks/platformHooks';
import { appHistory } from '@/utils/navigationHistory';
import { getOverlayPortalTarget } from '@/utils/dom';
import { DisplayableImage } from '@/components/shared/DisplayableImage';
import { isHeicLikeMedia } from '@/utils/heicMedia';
import styles from './ImageViewer.module.scss';

const MAX_SCALE = 5;
const EPSILON = 0.001;
const SWIPE_THRESHOLD = 56;

export interface ImageViewerItem {
  src: string;
  kind: string;
  fileName?: string;
  width?: number | null;
  height?: number | null;
  id?: string;
}

interface ImageViewerProps {
  images: ImageViewerItem[];
  initialIndex?: number;
  onClose: () => void;
}

interface Dimensions {
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

function isImageViewerImage(item: ImageViewerItem | undefined) {
  if (!item) return false;
  return (
    item.kind.startsWith('image/') || isHeicLikeMedia({ mimeType: item.kind, fileName: item.fileName, url: item.src })
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function getTouchPoint(touch: Pick<Touch, 'clientX' | 'clientY'>): Point {
  return { x: touch.clientX, y: touch.clientY };
}

export function ImageViewer({ images, initialIndex = 0, onClose }: ImageViewerProps) {
  const isDesktop = useIsDesktop();
  const safeInitialIndex = clamp(initialIndex, 0, Math.max(images.length - 1, 0));
  const [activeIndex, setActiveIndex] = useState(safeInitialIndex);
  const [imageSizes, setImageSizes] = useState<Record<number, Dimensions>>({});
  const [stageSize, setStageSize] = useState<Dimensions>({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [translate, setTranslate] = useState<Point>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const dragStartRef = useRef<{ point: Point; translate: Point } | null>(null);
  const resetOnNextScaleRef = useRef(true);
  const touchStateRef = useRef<
    | {
        mode: 'swipe' | 'pan';
        startPoint: Point;
        startTranslate: Point;
        deltaX: number;
        deltaY: number;
      }
    | {
        mode: 'pinch';
        startDistance: number;
        startScale: number;
        contentPoint: Point;
      }
    | null
  >(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const historyPushedRef = useRef(false);

  const closeViaHistory = useCallback(() => {
    if (historyPushedRef.current) {
      appHistory.goBack();
    } else {
      onCloseRef.current();
    }
  }, []);

  useEffect(() => {
    const loc = appHistory.location;
    appHistory.push(loc.pathname + loc.search + '#image-viewer');
    historyPushedRef.current = true;

    const unlisten = appHistory.listen((_location, action) => {
      if (action === 'POP' && historyPushedRef.current) {
        historyPushedRef.current = false;
        onCloseRef.current();
      }
    });

    return () => {
      unlisten();
      if (historyPushedRef.current) {
        historyPushedRef.current = false;
        appHistory.goBack();
      }
    };
  }, []);

  const activeImage = images[activeIndex];
  const activeImageSize = useMemo(() => {
    const measured = imageSizes[activeIndex];
    if (measured) {
      return measured;
    }

    if (activeImage?.width && activeImage?.height) {
      return {
        width: activeImage.width,
        height: activeImage.height,
      };
    }

    return null;
  }, [activeImage, activeIndex, imageSizes]);

  const minScale = useMemo(() => {
    if (!activeImageSize || !stageSize.width || !stageSize.height) {
      return 1;
    }

    return Math.min(1, stageSize.width / activeImageSize.width, stageSize.height / activeImageSize.height);
  }, [activeImageSize, stageSize.height, stageSize.width]);

  const canZoomPan = !!activeImageSize && !!stageSize.width && !!stageSize.height;
  const isImageReadyForInitialRender = !!activeImageSize && !!stageSize.width && !!stageSize.height;
  const effectiveScale = minScale * zoom;

  const clampTranslate = useCallback(
    (nextTranslate: Point, nextZoom: number): Point => {
      if (!activeImageSize || !stageSize.width || !stageSize.height) {
        return { x: 0, y: 0 };
      }

      const nextEffectiveScale = minScale * nextZoom;
      const scaledWidth = activeImageSize.width * nextEffectiveScale;
      const scaledHeight = activeImageSize.height * nextEffectiveScale;
      const maxX = Math.max((scaledWidth - stageSize.width) / 2, 0);
      const maxY = Math.max((scaledHeight - stageSize.height) / 2, 0);

      return {
        x: clamp(nextTranslate.x, -maxX, maxX),
        y: clamp(nextTranslate.y, -maxY, maxY),
      };
    },
    [activeImageSize, minScale, stageSize.height, stageSize.width],
  );

  const applyScaleAtPoint = useCallback(
    (nextZoom: number, point: Point) => {
      if (!activeImageSize || !stageSize.width || !stageSize.height || !stageRef.current) {
        return;
      }

      const rect = stageRef.current.getBoundingClientRect();
      const pointInStage = {
        x: point.x - rect.left - stageSize.width / 2,
        y: point.y - rect.top - stageSize.height / 2,
      };
      const contentPoint = {
        x: (pointInStage.x - translate.x) / effectiveScale,
        y: (pointInStage.y - translate.y) / effectiveScale,
      };
      const nextEffectiveScale = minScale * nextZoom;
      const nextTranslate = clampTranslate(
        {
          x: pointInStage.x - contentPoint.x * nextEffectiveScale,
          y: pointInStage.y - contentPoint.y * nextEffectiveScale,
        },
        nextZoom,
      );

      setZoom(nextZoom);
      setTranslate(nextTranslate);
    },
    [
      activeImageSize,
      clampTranslate,
      effectiveScale,
      minScale,
      stageSize.height,
      stageSize.width,
      translate.x,
      translate.y,
    ],
  );

  const navigateTo = useCallback(
    (nextIndex: number) => {
      setActiveIndex(clamp(nextIndex, 0, Math.max(images.length - 1, 0)));
    },
    [images.length],
  );

  const handleDismissClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        closeViaHistory();
      }
    },
    [closeViaHistory],
  );

  useEffect(() => {
    if (!images.length) {
      closeViaHistory();
    }
  }, [images.length, closeViaHistory]);

  useEffect(() => {
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = bodyOverflow;
    };
  }, []);

  useEffect(() => {
    const updateStageSize = () => {
      if (!stageRef.current) {
        return;
      }

      const rect = stageRef.current.getBoundingClientRect();
      setStageSize({ width: rect.width, height: rect.height });
    };

    updateStageSize();

    const observer = new ResizeObserver(updateStageSize);
    if (stageRef.current) {
      observer.observe(stageRef.current);
    }

    window.addEventListener('resize', updateStageSize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateStageSize);
    };
  }, []);

  useEffect(() => {
    resetOnNextScaleRef.current = true;
    setZoom(1);
    setTranslate({ x: 0, y: 0 });
    setIsDragging(false);
    dragStartRef.current = null;
    pointerIdRef.current = null;
    touchStateRef.current = null;
  }, [activeIndex]);

  useEffect(() => {
    if (resetOnNextScaleRef.current) {
      resetOnNextScaleRef.current = false;
      setZoom(1);
      setTranslate({ x: 0, y: 0 });
      return;
    }

    setZoom((prevZoom) => {
      setTranslate((prevTranslate) => clampTranslate(prevTranslate, prevZoom));
      return prevZoom;
    });
  }, [clampTranslate, minScale, stageSize.height, stageSize.width]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === viewerRef.current);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    handleFullscreenChange();

    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeViaHistory();
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        navigateTo(activeIndex - 1);
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        navigateTo(activeIndex + 1);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeIndex, navigateTo, closeViaHistory]);

  const handleDownload = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    if (!activeImage) {
      return;
    }

    try {
      const response = await fetch(activeImage.src);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = blobUrl;
      const downloadName = activeImage.fileName || activeImage.src.split('/').pop()?.split('?')[0] || 'image';
      link.download = downloadName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch (error) {
      console.error('Failed to download image', error);
      window.open(activeImage.src, '_blank', 'noopener,noreferrer');
    }
  };

  const toggleFullscreen = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    try {
      if (document.fullscreenElement === viewerRef.current) {
        await document.exitFullscreen();
        return;
      }

      await viewerRef.current?.requestFullscreen();
    } catch (error) {
      console.warn('Fullscreen request failed', error);
    }
  };

  useEffect(() => {
    const stageElement = stageRef.current;
    if (!stageElement) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      if (!canZoomPan) {
        return;
      }

      event.preventDefault();
      const nextZoom = clamp(zoom * Math.exp(-event.deltaY * 0.002), 1, MAX_SCALE);

      if (Math.abs(nextZoom - zoom) < EPSILON) {
        return;
      }

      applyScaleAtPoint(nextZoom, { x: event.clientX, y: event.clientY });
    };

    stageElement.addEventListener('wheel', handleWheel, { passive: false });
    return () => stageElement.removeEventListener('wheel', handleWheel);
  }, [applyScaleAtPoint, canZoomPan, zoom]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' || zoom <= 1 + EPSILON) {
      return;
    }

    pointerIdRef.current = event.pointerId;
    dragStartRef.current = {
      point: { x: event.clientX, y: event.clientY },
      translate,
    };
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId || !dragStartRef.current) {
      return;
    }

    const dx = event.clientX - dragStartRef.current.point.x;
    const dy = event.clientY - dragStartRef.current.point.y;
    setTranslate(
      clampTranslate(
        {
          x: dragStartRef.current.translate.x + dx,
          y: dragStartRef.current.translate.y + dy,
        },
        zoom,
      ),
    );
  };

  const endPointerDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) {
      return;
    }

    pointerIdRef.current = null;
    dragStartRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (!stageRef.current) {
      return;
    }

    if (event.touches.length === 2 && canZoomPan) {
      const first = getTouchPoint(event.touches[0]);
      const second = getTouchPoint(event.touches[1]);
      const rect = stageRef.current.getBoundingClientRect();
      const center = midpoint(first, second);
      const pointInStage = {
        x: center.x - rect.left - stageSize.width / 2,
        y: center.y - rect.top - stageSize.height / 2,
      };

      touchStateRef.current = {
        mode: 'pinch',
        startDistance: distance(first, second),
        startScale: zoom,
        contentPoint: {
          x: (pointInStage.x - translate.x) / effectiveScale,
          y: (pointInStage.y - translate.y) / effectiveScale,
        },
      };
      return;
    }

    if (event.touches.length !== 1) {
      return;
    }

    const touch = getTouchPoint(event.touches[0]);
    touchStateRef.current = {
      mode: zoom > 1 + EPSILON ? 'pan' : 'swipe',
      startPoint: touch,
      startTranslate: translate,
      deltaX: 0,
      deltaY: 0,
    };
  };

  const handleTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    if (!touchStateRef.current || !stageRef.current) {
      return;
    }

    if (touchStateRef.current.mode === 'pinch' && event.touches.length === 2 && canZoomPan) {
      const first = getTouchPoint(event.touches[0]);
      const second = getTouchPoint(event.touches[1]);
      const center = midpoint(first, second);
      const rect = stageRef.current.getBoundingClientRect();
      const pointInStage = {
        x: center.x - rect.left - stageSize.width / 2,
        y: center.y - rect.top - stageSize.height / 2,
      };
      const nextScale = clamp(
        (touchStateRef.current.startScale * distance(first, second)) / touchStateRef.current.startDistance,
        1,
        MAX_SCALE,
      );
      const nextEffectiveScale = minScale * nextScale;

      const nextTranslate = clampTranslate(
        {
          x: pointInStage.x - touchStateRef.current.contentPoint.x * nextEffectiveScale,
          y: pointInStage.y - touchStateRef.current.contentPoint.y * nextEffectiveScale,
        },
        nextScale,
      );

      setZoom(nextScale);
      setTranslate(nextTranslate);
      return;
    }

    if (touchStateRef.current.mode === 'pan' && event.touches.length === 1) {
      const touch = getTouchPoint(event.touches[0]);
      const dx = touch.x - touchStateRef.current.startPoint.x;
      const dy = touch.y - touchStateRef.current.startPoint.y;

      setTranslate(
        clampTranslate(
          {
            x: touchStateRef.current.startTranslate.x + dx,
            y: touchStateRef.current.startTranslate.y + dy,
          },
          zoom,
        ),
      );
      return;
    }

    if (touchStateRef.current.mode === 'swipe' && event.touches.length === 1) {
      const touch = getTouchPoint(event.touches[0]);
      touchStateRef.current.deltaX = touch.x - touchStateRef.current.startPoint.x;
      touchStateRef.current.deltaY = touch.y - touchStateRef.current.startPoint.y;
    }
  };

  const handleTouchEnd = () => {
    if (!touchStateRef.current) {
      return;
    }

    if (touchStateRef.current.mode === 'swipe') {
      const { deltaX, deltaY } = touchStateRef.current;
      if (Math.abs(deltaX) > SWIPE_THRESHOLD && Math.abs(deltaX) > Math.abs(deltaY)) {
        navigateTo(activeIndex + (deltaX < 0 ? 1 : -1));
      }
    }

    touchStateRef.current = null;
  };

  if (!images.length) {
    return null;
  }

  return createPortal(
    <div
      className={styles.overlay}
      data-image-viewer
      onClick={(e) => {
        e.stopPropagation();
        handleDismissClick(e);
      }}
      onContextMenu={(e) => {
        e.stopPropagation();
      }}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      <div className={styles.viewer} ref={viewerRef}>
        <div className={styles.toolbar}>
          <button
            className={styles.iconButton}
            onClick={handleDownload}
            title={t`Download`}
            aria-label={t`Download image`}
          >
            <IonIcon icon={download} />
          </button>
          {isDesktop && (
            <button
              className={styles.iconButton}
              onClick={toggleFullscreen}
              title={isFullscreen ? t`Exit fullscreen` : t`Enter fullscreen`}
              aria-label={isFullscreen ? t`Exit fullscreen` : t`Enter fullscreen`}
            >
              <IonIcon icon={isFullscreen ? contractOutline : expandOutline} />
            </button>
          )}
          <button className={styles.iconButton} onClick={closeViaHistory} title={t`Close`} aria-label={t`Close viewer`}>
            <IonIcon icon={close} />
          </button>
        </div>

        <div
          ref={stageRef}
          className={`${styles.stage} ${isDragging ? styles.dragging : ''}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endPointerDrag}
          onPointerCancel={endPointerDrag}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
        >
          {images.length > 1 && (
            <>
              <button
                className={`${styles.navButton} ${styles.prevButton}`}
                onClick={() => navigateTo(activeIndex - 1)}
                disabled={activeIndex === 0}
                aria-label={t`Previous image`}
              >
                <IonIcon icon={chevronBack} />
              </button>
              <button
                className={`${styles.navButton} ${styles.nextButton}`}
                onClick={() => navigateTo(activeIndex + 1)}
                disabled={activeIndex === images.length - 1}
                aria-label={t`Next image`}
              >
                <IonIcon icon={chevronForward} />
              </button>
            </>
          )}

          <div className={styles.canvas} onClick={handleDismissClick}>
            {isImageViewerImage(activeImage) ? (
              <DisplayableImage
                key={activeImage.id || activeImage.src}
                src={activeImage.src}
                mimeType={activeImage.kind}
                fileName={activeImage.fileName}
                className={styles.image}
                alt={activeImage.fileName || t`Attachment large view`}
                draggable={false}
                onContextMenu={(e) => {
                  e.stopPropagation();
                }}
                onLoad={(event) => {
                  const nextSize = {
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  };

                  setImageSizes((prev) => {
                    const current = prev[activeIndex];
                    if (current?.width === nextSize.width && current?.height === nextSize.height) {
                      return prev;
                    }

                    return {
                      ...prev,
                      [activeIndex]: nextSize,
                    };
                  });
                }}
                style={{
                  width: activeImageSize?.width,
                  height: activeImageSize?.height,
                  opacity: isImageReadyForInitialRender ? 1 : 0,
                  transform: `translate(${translate.x}px, ${translate.y}px) scale(${effectiveScale})`,
                }}
              />
            ) : (
              <video
                autoPlay
                loop
                controls
                key={activeImage.id || activeImage.src}
                src={activeImage.src}
                className={styles.image}
                draggable={false}
                onContextMenu={(e) => {
                  e.stopPropagation();
                }}
                onLoadedMetadata={(event) => {
                  const nextSize = {
                    width: event.currentTarget.videoWidth,
                    height: event.currentTarget.videoHeight,
                  };

                  setImageSizes((prev) => {
                    const current = prev[activeIndex];
                    if (current?.width === nextSize.width && current?.height === nextSize.height) {
                      return prev;
                    }

                    return {
                      ...prev,
                      [activeIndex]: nextSize,
                    };
                  });
                }}
                style={{
                  width: activeImageSize?.width,
                  height: activeImageSize?.height,
                  opacity: isImageReadyForInitialRender ? 1 : 0,
                  transform: `translate(${translate.x}px, ${translate.y}px) scale(${effectiveScale})`,
                }}
              />
            )}
          </div>
        </div>

        {images.length > 1 && (
          <div className={styles.thumbnailRail}>
            {images.map((image, index) => (
              <button
                key={image.id || image.src}
                className={`${styles.thumbnailButton} ${index === activeIndex ? styles.thumbnailActive : ''}`}
                onClick={() => navigateTo(index)}
                aria-label={t`View image ${index + 1}`}
              >
                {isImageViewerImage(image) ? (
                  <DisplayableImage
                    src={image.src}
                    mimeType={image.kind}
                    fileName={image.fileName}
                    alt={image.fileName || t`Thumbnail ${index + 1}`}
                    className={styles.thumbnail}
                    draggable={false}
                  />
                ) : (
                  <video src={image.src} className={styles.thumbnail} muted playsInline />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    getOverlayPortalTarget(),
  );
}
