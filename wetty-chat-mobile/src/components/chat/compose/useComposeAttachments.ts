import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '@lingui/core/macro';
import type { Attachment } from '@/api/messages';
import type { AttachmentMimeCategory } from '@/utils/fileType';
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
import { AttachmentConfigLoadError, AttachmentTooLargeError } from '@/api/upload';
import { formatFileSize } from '@/utils/formatFileSize';

const isAbortError = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

function isMediaCategory(category: AttachmentMimeCategory): category is 'image' | 'video' {
  return category === 'image' || category === 'video';
}

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
    if (record.state.previewUrl) URL.revokeObjectURL(record.state.previewUrl);
  }, []);
  const clearUploads = useCallback(() => {
    uploadsRef.current.forEach(cleanupRecord);
    uploadsRef.current = [];
    setUploads([]);
  }, [cleanupRecord]);
  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);
  useEffect(() => () => uploadsRef.current.forEach(cleanupRecord), [cleanupRecord]);

  const startUpload = useCallback(
    async (localId: string, file: File, mimeType: string, shouldProcess = mediaCompressionEnabled) => {
      const abortController = new AbortController();
      const setRecord = (transform: (record: UploadRecord) => UploadRecord) => {
        uploadsRef.current = uploadsRef.current.map(transform);
        setUploads((previous) => previous.map(transform));
      };
      setRecord((record) =>
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
      );
      const updateProgress = (progress: number) =>
        setUploads((previous) =>
          previous.map((record) =>
            record.state.localId === localId ? { ...record, state: { ...record.state, progress } } : record,
          ),
        );
      try {
        let dimensions = await getMediaDimensions(file, mimeType);
        const queuedRecord = uploadsRef.current.find((record) => record.state.localId === localId);
        if (abortController.signal.aborted || !queuedRecord) return;
        let fileToUpload = file;
        if (shouldProcess) {
          const compress = categorizeAttachmentKind(mimeType) === 'image' ? compressImage : compressVideo;
          setUploads((previous) =>
            previous.map((record) =>
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
        const uploadMimeType = fileToUpload === file ? mimeType : await detectFileMimeType(fileToUpload);
        const currentRecord = uploadsRef.current.find((record) => record.state.localId === localId);
        if (abortController.signal.aborted || !currentRecord) return;
        const nextPreviewUrl =
          fileToUpload === file ? currentRecord.state.previewUrl : URL.createObjectURL(fileToUpload);
        setRecord((record) =>
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
            : record,
        );
        if (nextPreviewUrl !== currentRecord.state.previewUrl && currentRecord.state.previewUrl)
          URL.revokeObjectURL(currentRecord.state.previewUrl);
        const result = await uploadAttachment({
          file: fileToUpload,
          purpose: 'media',
          dimensions,
          order: queuedRecord.order,
          signal: abortController.signal,
          onProgress: (progress) => updateProgress(shouldProcess ? Math.round(50 + progress * 0.5) : progress),
        });
        setUploads((previous) =>
          previous.map((record) =>
            record.state.localId === localId
              ? {
                  ...record,
                  abortController: undefined,
                  state: { ...record.state, status: 'uploaded', progress: 100, attachmentId: result.attachmentId },
                }
              : record,
          ),
        );
      } catch (error) {
        if (isAbortError(error) || abortController.signal.aborted) return;
        const errorMessage =
          error instanceof AttachmentTooLargeError
            ? t`File is too large. Maximum size is ${formatFileSize(error.maxFileSizeBytes)}.`
            : error instanceof AttachmentConfigLoadError
              ? t`Unable to load attachment settings. Try again.`
              : t`Upload failed`;
        setUploads((previous) =>
          previous.map((record) =>
            record.state.localId === localId
              ? {
                  ...record,
                  abortController: undefined,
                  state: { ...record.state, status: 'error', progress: 0, errorMessage },
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
      const selectableFiles = files.flatMap((file, index) => {
        const mimeType = detectedTypes[index];
        const kind = categorizeAttachmentKind(mimeType);
        return isMediaCategory(kind) ? [{ file, mimeType, kind }] : [];
      });
      if (selectableFiles.length === 0) return;
      const currentCount = existingAttachments.length + uploadsRef.current.length;
      const allowedFiles = selectableFiles.slice(0, Math.max(0, maxAttachments - currentCount));
      if (allowedFiles.length < selectableFiles.length)
        onError?.(t`You can only upload up to ${maxAttachments} media files at once.`);
      const queuedRecords: UploadRecord[] = allowedFiles.map(({ file, mimeType, kind }, index) => {
        const fileWithDetectedMimeType = withDetectedMimeType(file, mimeType);
        return {
          file: fileWithDetectedMimeType,
          order: currentCount + index,
          state: {
            localId: createClientGeneratedId('upload_'),
            kind,
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
      setUploads((previous) => [...previous, ...queuedRecords]);
      queuedRecords.forEach(
        ({ state, file: queuedFile }) => void startUpload(state.localId, queuedFile, state.mimeType),
      );
    },
    [existingAttachments.length, maxAttachments, onError, startUpload],
  );

  useEffect(() => {
    const handleGlobalPaste = (event: ClipboardEvent) => {
      if (containerRef?.current && containerRef.current.offsetParent === null) return;
      const files = Array.from(event.clipboardData?.items ?? [])
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null && mayBeMediaFile(file));
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
      size: attachment.size,
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
