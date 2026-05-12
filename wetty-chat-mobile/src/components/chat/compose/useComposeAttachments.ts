import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@lingui/core/macro';
import type { Attachment } from '@/api/messages';
import type { UploadPreviewItem } from '@/components/chat/compose/UploadPreview';
import type { ComposeUploadInput, ComposeUploadResult, UploadRecord } from './types';

import { MAX_ATTACHMENTS_PER_MESSAGE } from '@/constants/media';
import {
  convertHeicBlobToJpegBlob,
  getImageDimensionsFromBlob,
  getUploadMimeType,
  isHeicLikeMedia,
  isImageFile,
  isSupportedMediaFile,
  isVideoFile,
} from '@/utils/heicMedia';

const isAbortError = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

const createUploadId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `upload_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

const getNativeImageDimensions = (file: File): Promise<{ width?: number; height?: number }> =>
  new Promise((resolve) => {
    if (!isImageFile(file)) {
      resolve({});
      return;
    }

    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({ width: img.width, height: img.height });
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({});
    };
    img.src = objectUrl;
  });

async function getMediaDimensions(file: File): Promise<{ width?: number; height?: number }> {
  const mimeType = getUploadMimeType(file);

  if (isImageFile(file)) {
    const nativeDimensions = await getNativeImageDimensions(file);
    if (nativeDimensions.width && nativeDimensions.height) {
      return nativeDimensions;
    }

    if (isHeicLikeMedia({ mimeType, fileName: file.name })) {
      try {
        const jpegBlob = await convertHeicBlobToJpegBlob(file);
        return getImageDimensionsFromBlob(jpegBlob);
      } catch (error) {
        console.warn('[media:heic] Failed to read HEIC dimensions', {
          fileName: file.name,
          mimeType,
          error,
        });
        return {};
      }
    }

    return {};
  }

  return new Promise((resolve) => {
    if (isVideoFile(file)) {
      const video = document.createElement('video');
      const objectUrl = URL.createObjectURL(file);
      video.onloadedmetadata = () => {
        URL.revokeObjectURL(objectUrl);
        resolve({ width: video.videoWidth, height: video.videoHeight });
      };
      video.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        resolve({});
      };
      video.src = objectUrl;
      return;
    }

    resolve({});
  });
}

interface UseComposeAttachmentsArgs {
  uploadAttachment: (input: ComposeUploadInput) => Promise<ComposeUploadResult>;
  initialExistingAttachments?: Attachment[];
  containerRef?: React.RefObject<HTMLElement | null>;
  onError?: (message: string) => void;
  maxAttachments?: number;
}

export function useComposeAttachments({
  uploadAttachment,
  initialExistingAttachments = [],
  containerRef,
  onError,
  maxAttachments = MAX_ATTACHMENTS_PER_MESSAGE,
}: UseComposeAttachmentsArgs) {
  const [uploads, setUploads] = useState<UploadRecord[]>([]);
  const [existingAttachments, setExistingAttachments] = useState<Attachment[]>(initialExistingAttachments);
  const uploadsRef = useRef<UploadRecord[]>([]);

  const cleanupRecord = useCallback((record: UploadRecord) => {
    record.abortController?.abort();
    URL.revokeObjectURL(record.state.previewUrl);
  }, []);

  const clearUploads = useCallback(
    (currentUploads: UploadRecord[]) => {
      currentUploads.forEach(cleanupRecord);
      setUploads([]);
    },
    [cleanupRecord],
  );

  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  useEffect(
    () => () => {
      uploadsRef.current.forEach(cleanupRecord);
    },
    [cleanupRecord],
  );

  const startUpload = useCallback(
    async (localId: string, file: File) => {
      const abortController = new AbortController();

      setUploads((prev) =>
        prev.map((record) =>
          record.state.localId === localId
            ? {
                ...record,
                abortController,
                state: {
                  ...record.state,
                  status: 'uploading',
                  progress: 0,
                  errorMessage: undefined,
                  attachmentId: undefined,
                },
              }
            : record,
        ),
      );

      try {
        const dimensions = await getMediaDimensions(file);
        const currentState = uploadsRef.current.find((r) => r.state.localId === localId)?.state;

        setUploads((prev) =>
          prev.map((record) =>
            record.state.localId === localId
              ? {
                  ...record,
                  state: {
                    ...record.state,
                    width: dimensions.width,
                    height: dimensions.height,
                  },
                }
              : record,
          ),
        );

        const result = await uploadAttachment({
          file,
          dimensions,
          order: currentState?.order,
          signal: abortController.signal,
          onProgress: (progress) => {
            setUploads((prev) =>
              prev.map((record) =>
                record.state.localId === localId
                  ? {
                      ...record,
                      state: {
                        ...record.state,
                        progress,
                      },
                    }
                  : record,
              ),
            );
          },
        });

        setUploads((prev) =>
          prev.map((record) =>
            record.state.localId === localId
              ? {
                  ...record,
                  abortController: undefined,
                  state: {
                    ...record.state,
                    status: 'uploaded',
                    progress: 100,
                    attachmentId: result.attachmentId,
                    errorMessage: undefined,
                  },
                }
              : record,
          ),
        );
      } catch (error) {
        if (isAbortError(error) || abortController.signal.aborted) {
          return;
        }

        console.error('Failed to upload attachment:', error);
        setUploads((prev) =>
          prev.map((record) =>
            record.state.localId === localId
              ? {
                  ...record,
                  abortController: undefined,
                  state: {
                    ...record.state,
                    status: 'error',
                    progress: 0,
                    attachmentId: undefined,
                    errorMessage: t`Upload failed`,
                  },
                }
              : record,
          ),
        );
      }
    },
    [uploadAttachment],
  );

  const queueFiles = useCallback(
    (files: File[]) => {
      const mediaFiles = files.filter(isSupportedMediaFile);
      if (mediaFiles.length === 0) return;

      let allowedFiles = mediaFiles;
      const currentCount = existingAttachments.length + uploadsRef.current.length;
      if (currentCount + mediaFiles.length > maxAttachments) {
        const available = Math.max(0, maxAttachments - currentCount);
        if (onError) {
          onError(t`You can only upload up to ${maxAttachments} media files at once.`);
        }
        if (available === 0) return;
        allowedFiles = mediaFiles.slice(0, available);
      }

      const queuedRecords: UploadRecord[] = allowedFiles.map((file, index) => ({
        file,
        state: {
          localId: createUploadId(),
          kind: isImageFile(file) ? 'image' : 'video',
          name: file.name,
          previewUrl: URL.createObjectURL(file),
          mimeType: getUploadMimeType(file),
          size: file.size,
          order: index,
          progress: 0,
          status: 'uploading' as const,
        },
      }));

      setUploads((prev) => [...prev, ...queuedRecords]);
      queuedRecords.forEach(({ state, file }) => {
        void startUpload(state.localId, file);
      });
    },
    [startUpload, existingAttachments, maxAttachments, onError],
  );

  useEffect(() => {
    const handleGlobalPaste = (event: ClipboardEvent) => {
      if (containerRef?.current && containerRef.current.offsetParent === null) return;

      const items = event.clipboardData?.items;
      if (!items) return;

      const files: File[] = [];
      for (let index = 0; index < items.length; index += 1) {
        const file = items[index].getAsFile();
        if (file && isSupportedMediaFile(file)) {
          files.push(file);
        }
      }

      if (files.length > 0) {
        event.preventDefault();
        queueFiles(files);
      }
    };

    document.addEventListener('paste', handleGlobalPaste);
    return () => document.removeEventListener('paste', handleGlobalPaste);
  }, [containerRef, queueFiles]);

  const removeUpload = useCallback(
    (localId: string) => {
      setUploads((prev) => {
        const toRemove = prev.find((record) => record.state.localId === localId);
        if (toRemove) {
          cleanupRecord(toRemove);
        }

        return prev.filter((record) => record.state.localId !== localId);
      });
    },
    [cleanupRecord],
  );

  const retryUpload = useCallback(
    (localId: string) => {
      const file = uploadsRef.current.find((record) => record.state.localId === localId)?.file;
      if (!file) return;
      void startUpload(localId, file);
    },
    [startUpload],
  );

  const removeExistingAttachment = useCallback((localId: string) => {
    const attachmentId = localId.replace(/^existing-/, '');
    setExistingAttachments((prev) => prev.filter((attachment) => attachment.id !== attachmentId));
  }, []);

  const clearAll = useCallback(() => {
    setExistingAttachments([]);
    clearUploads(uploadsRef.current);
  }, [clearUploads]);

  const hasPending = uploads.some((record) => record.state.status === 'uploading');
  const hasFailed = uploads.some((record) => record.state.status === 'error');

  const previewItems: UploadPreviewItem[] = [
    ...existingAttachments.map((attachment) => ({
      itemType: 'existing' as const,
      localId: `existing-${attachment.id}`,
      attachmentId: attachment.id,
      kind: attachment.kind,
      name: attachment.fileName,
      previewUrl:
        attachment.kind.startsWith('image/') ||
        isHeicLikeMedia({
          mimeType: attachment.kind,
          fileName: attachment.fileName,
          url: attachment.url,
        })
          ? attachment.url
          : undefined,
    })),
    ...uploads.map((record) => ({
      itemType: 'pending' as const,
      ...record.state,
    })),
  ];

  return {
    uploads,
    existingAttachments,
    previewItems,
    hasPending,
    hasFailed,
    queueFiles,
    clearAll,
    removeUpload,
    retryUpload,
    removeExistingAttachment,
  };
}
