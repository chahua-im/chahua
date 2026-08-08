import axios, { type AxiosResponse } from 'axios';
import apiClient from './client';

interface Dimensions {
  width: number;
  height: number;
}

interface UploadUrlRequest {
  filename: string;
  contentType: string;
  size: number;
  order?: number;
  dimensions?: Dimensions;
}

interface UploadUrlResponse {
  attachmentId: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
}

interface UploadFileToS3Options {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

export function requestUploadUrl(
  body: UploadUrlRequest,
  signal?: AbortSignal,
): Promise<AxiosResponse<UploadUrlResponse>> {
  const { dimensions, ...upload } = body;
  return apiClient.post('/attachments/upload-url', { ...upload, ...dimensions }, { signal });
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
