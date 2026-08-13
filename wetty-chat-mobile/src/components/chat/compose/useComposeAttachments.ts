import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@lingui/core/macro';
import type { Attachment } from '@/api/messages';
import type { ComposeUploadInput, ComposeUploadResult, Dimensions, UploadPreviewItem, UploadRecord } from './types';

import { MAX_ATTACHMENTS_PER_MESSAGE } from '@/constants/media';
import {
  categorizeAttachmentKind,
  detectFileMimeType,
  isImageKind,
  mayBeMediaFile,
  withDetectedMimeType,
} from '@/utils/fileType';
import { createClientGeneratedId } from '@/utils/clientGeneratedId';
import { isFeatureEnabled } from '@/features';
import { compressVideo, compressImage } from '@/utils/compression';

const isAbortError = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

const getNativeImageDimensions = (file: File): Promise<Dimensions | undefined> =>
  new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(undefined);
    };
    img.src = objectUrl;
  });

function getMediaDimensions(file: File, mimeType: string): Promise<Dimensions | undefined> {
  if (categorizeAttachmentKind(mimeType) === 'image') {
    return getNativeImageDimensions(file);
  }

  return new Promise((resolve) => {
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(file);
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({ width: video.videoWidth, height: video.videoHeight });
    };
    video.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(undefined);
    };
    video.preload = 'metadata';
    video.src = objectUrl;
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
  const mediaCompressionEnabled = isFeatureEnabled('mediaCompression');

  const cleanupRecord = useCallback((record: UploadRecord) => {
    record.abortController?.abort();
    URL.revokeObjectURL(record.state.previewUrl);
  }, []);

  const clearUploads = useCallback(() => {
    uploadsRef.current.forEach(cleanupRecord);
    uploadsRef.current = [];
    setUploads([]);
  }, [cleanupRecord]);

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
    async (localId: string, file: File, mimeType: string, shouldProcess = mediaCompressionEnabled) => {
      const abortController = new AbortController();

      const attachController = (record: UploadRecord): UploadRecord =>
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
          : record;
      uploadsRef.current = uploadsRef.current.map(attachController);
      setUploads((prev) => prev.map(attachController));

      const updateProgress = (progress: number) => {
        setUploads((prev) =>
          prev.map((record) =>
            record.state.localId === localId ? { ...record, state: { ...record.state, progress } } : record,
          ),
        );
      };

      try {
        let dimensions = await getMediaDimensions(file, mimeType);
        const queuedRecord = uploadsRef.current.find((record) => record.state.localId === localId);
        if (abortController.signal.aborted || !queuedRecord) return;

        let fileToUpload = file;
        if (shouldProcess) {
          const compress = categorizeAttachmentKind(mimeType) === 'image' ? compressImage : compressVideo;

          setUploads((prev) =>
            prev.map((record) =>
              record.state.localId === localId
                ? { ...record, state: { ...record.state, status: 'compressing' } }
                : record,
            ),
          );

          try {
            const result = await compress(file, dimensions, {
              signal: abortController.signal,
              onProgress: (progress) => updateProgress(Math.round(progress * 50)),
            });
            fileToUpload = result.file;
            dimensions = result.dimensions;
          } catch (error) {
            if (isAbortError(error)) throw error;
            console.warn('[upload:compression] Compression failed, using original file', error);
          }
        }

        let uploadMimeType = mimeType;
        if (fileToUpload !== file) {
          uploadMimeType = await detectFileMimeType(fileToUpload);
        }

        const currentRecord = uploadsRef.current.find((record) => record.state.localId === localId);
        if (abortController.signal.aborted || !currentRecord) return;
        const nextPreviewUrl =
          fileToUpload === file ? currentRecord.state.previewUrl : URL.createObjectURL(fileToUpload);
        const applyProcessedFile = (record: UploadRecord): UploadRecord =>
          record.state.localId === localId
            ? {
                ...record,
                file: fileToUpload,
                state: {
                  ...record.state,
                  name: fileToUpload.name,
                  previewUrl: nextPreviewUrl,
                  mimeType: uploadMimeType,
                  size: fileToUpload.size,
                  dimensions,
                  status: 'uploading',
                },
              }
            : record;
        uploadsRef.current = uploadsRef.current.map(applyProcessedFile);
        setUploads((prev) => prev.map(applyProcessedFile));
        if (nextPreviewUrl !== currentRecord.state.previewUrl) {
          URL.revokeObjectURL(currentRecord.state.previewUrl);
        }

        const result = await uploadAttachment({
          file: fileToUpload,
          dimensions,
          order: queuedRecord.order,
          signal: abortController.signal,
          onProgress: (progress) => {
            updateProgress(shouldProcess ? Math.round(50 + progress * 0.5) : progress);
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
                    errorMessage: t`Upload failed`,
                  },
                }
              : record,
          ),
        );
      }
    },
    [uploadAttachment, mediaCompressionEnabled],
  );

  const queueFiles = useCallback(
    async (files: File[]) => {
      const detectedTypes = await Promise.all(files.map(detectFileMimeType));
      const mediaFiles = files
        .map((file, index) => ({ file, mimeType: detectedTypes[index] }))
        .filter(({ mimeType }) => {
          const kind = categorizeAttachmentKind(mimeType);
          return kind === 'image' || kind === 'video';
        });
      if (mediaFiles.length === 0) return;

      let allowedFiles = mediaFiles;
      const currentCount = existingAttachments.length + uploadsRef.current.length;
      if (currentCount + mediaFiles.length > maxAttachments) {
        const available = Math.max(0, maxAttachments - currentCount);
        onError?.(t`You can only upload up to ${maxAttachments} media files at once.`);
        if (available === 0) return;
        allowedFiles = mediaFiles.slice(0, available);
      }

      const queuedRecords: UploadRecord[] = allowedFiles.map(({ file, mimeType }, index) => {
        const localId = createClientGeneratedId('upload_');
        const fileWithDetectedMimeType = withDetectedMimeType(file, mimeType);

        return {
          file: fileWithDetectedMimeType,
          order: currentCount + index,
          state: {
            localId,
            kind: categorizeAttachmentKind(mimeType) === 'image' ? 'image' : 'video',
            name: fileWithDetectedMimeType.name,
            previewUrl: URL.createObjectURL(fileWithDetectedMimeType),
            mimeType,
            size: fileWithDetectedMimeType.size,
            progress: 0,
            status: 'uploading',
          },
        };
      });

      uploadsRef.current = [...uploadsRef.current, ...queuedRecords];
      setUploads((prev) => [...prev, ...queuedRecords]);
      queuedRecords.forEach(({ state, file }) => {
        void startUpload(state.localId, file, state.mimeType);
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
        if (file && mayBeMediaFile(file)) {
          files.push(file);
        }
      }

      if (files.length > 0) {
        event.preventDefault();
        void queueFiles(files);
      }
    };

    document.addEventListener('paste', handleGlobalPaste);
    return () => document.removeEventListener('paste', handleGlobalPaste);
  }, [containerRef, queueFiles]);

  const removeUpload = useCallback(
    (localId: string) => {
      const toRemove = uploadsRef.current.find((record) => record.state.localId === localId);
      if (toRemove) cleanupRecord(toRemove);
      uploadsRef.current = uploadsRef.current.filter((record) => record.state.localId !== localId);
      setUploads((prev) => prev.filter((record) => record.state.localId !== localId));
    },
    [cleanupRecord],
  );

  const retryUpload = useCallback(
    (localId: string) => {
      const record = uploadsRef.current.find((upload) => upload.state.localId === localId);
      if (!record) return;
      void startUpload(localId, record.file, record.state.mimeType, false);
    },
    [startUpload],
  );

  const removeExistingAttachment = useCallback((localId: string) => {
    const attachmentId = localId.replace(/^existing-/, '');
    setExistingAttachments((prev) => prev.filter((attachment) => attachment.id !== attachmentId));
  }, []);

  const clearAll = useCallback(() => {
    setExistingAttachments([]);
    clearUploads();
  }, [clearUploads]);

  const hasPending = uploads.some(
    (record) => record.state.status === 'compressing' || record.state.status === 'uploading',
  );
  const hasFailed = uploads.some((record) => record.state.status === 'error');

  const previewItems: UploadPreviewItem[] = [
    ...existingAttachments.map((attachment) => ({
      itemType: 'existing' as const,
      localId: `existing-${attachment.id}`,
      kind: attachment.kind,
      name: attachment.fileName,
      previewUrl: isImageKind(attachment.kind, attachment) ? attachment.url : undefined,
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
