import axios, { type AxiosResponse } from 'axios';
import apiClient from './client';

export type AttachmentUploadPurpose = 'media' | 'voice' | 'file';

interface Dimensions {
  width: number;
  height: number;
}

interface UploadUrlRequest {
  filename: string;
  contentType: string;
  size: number;
  purpose: AttachmentUploadPurpose;
  order?: number;
  dimensions?: Dimensions;
}

interface UploadUrlResponse {
  attachmentId: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
}

export interface AttachmentConfigResponse {
  maxFileSizeBytes: number;
}

export class AttachmentTooLargeError extends Error {
  readonly maxFileSizeBytes: number;

  constructor(maxFileSizeBytes: number) {
    super('Attachment exceeds maximum file size');
    this.name = 'AttachmentTooLargeError';
    this.maxFileSizeBytes = maxFileSizeBytes;
  }
}

let attachmentConfigPromise: Promise<AttachmentConfigResponse> | undefined;
let attachmentConfigFetchedAt = 0;

/** A cached limit is revalidated after this window so a raised server cap is picked up without a reload. */
const ATTACHMENT_CONFIG_TTL_MS = 5 * 60 * 1000;

export class AttachmentConfigLoadError extends Error {
  constructor() {
    super('Unable to load attachment settings. Try again.');
    this.name = 'AttachmentConfigLoadError';
  }
}

export function getAttachmentConfig(): Promise<AttachmentConfigResponse> {
  if (attachmentConfigPromise && Date.now() - attachmentConfigFetchedAt > ATTACHMENT_CONFIG_TTL_MS) {
    attachmentConfigPromise = undefined;
  }
  if (!attachmentConfigPromise) {
    attachmentConfigFetchedAt = Date.now();
    attachmentConfigPromise = apiClient
      .get<AttachmentConfigResponse>('/attachments/config')
      .then((response) => response.data)
      .catch(() => {
        attachmentConfigPromise = undefined;
        throw new AttachmentConfigLoadError();
      });
  }
  return attachmentConfigPromise;
}

function clearAttachmentConfig(): void {
  attachmentConfigPromise = undefined;
}

interface UploadFileToS3Options {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

export async function requestUploadUrl(
  body: UploadUrlRequest,
  signal?: AbortSignal,
): Promise<AxiosResponse<UploadUrlResponse>> {
  const config = await getAttachmentConfig();
  if (body.size > config.maxFileSizeBytes) {
    throw new AttachmentTooLargeError(config.maxFileSizeBytes);
  }

  const { dimensions, ...upload } = body;
  try {
    return await apiClient.post('/attachments/upload-url', { ...upload, ...dimensions }, { signal });
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 413) {
      clearAttachmentConfig();
      const refreshedConfig = await getAttachmentConfig();
      throw new AttachmentTooLargeError(refreshedConfig.maxFileSizeBytes);
    }
    throw error;
  }
}

export async function uploadFileToS3(
  url: string,
  file: File,
  headers: Record<string, string>,
  options: UploadFileToS3Options = {},
): Promise<AxiosResponse<void>> {
  try {
    return await axios.put(url, file, {
      headers,
      signal: options.signal,
      onUploadProgress: (event) => {
        if (!options.onProgress || !event.total) return;
        const progress = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
        options.onProgress(progress);
      },
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.debug('[upload:s3] put failed', {
        urlHost: (() => {
          try {
            return new URL(url).host;
          } catch {
            return null;
          }
        })(),
        method: error.config?.method ?? 'put',
        status: error.response?.status ?? null,
        responseHeaders: error.response?.headers ?? null,
        responseData: error.response?.data ?? null,
        requestHeaders: headers,
        fileName: file.name,
        fileType: file.type || 'application/octet-stream',
        fileSize: file.size,
        code: error.code ?? null,
        message: error.message,
      });
    }

    throw error;
  }
}
