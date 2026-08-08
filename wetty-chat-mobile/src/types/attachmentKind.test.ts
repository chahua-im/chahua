import { describe, expect, it } from 'vitest';
import { getUploadMimeType, isHeicLikeMedia, isImageFile, isImageKind, isSupportedMediaFile } from './attachmentKind';

describe('attachment kind helpers', () => {
  it('recognizes HEIC MIME types and extensions', () => {
    expect(isHeicLikeMedia({ mimeType: ' IMAGE/HEIF; charset=binary ' })).toBe(true);
    expect(isHeicLikeMedia({ fileName: 'PHOTO.HEIC?version=1' })).toBe(true);
    expect(isHeicLikeMedia({ fileName: 'photo.heif#preview' })).toBe(true);
    expect(isHeicLikeMedia({ fileName: 'photo.jpg' })).toBe(false);
  });

  it('recognizes HEIC from attachment metadata', () => {
    expect(isHeicLikeMedia({ mimeType: 'image/heic' })).toBe(true);
    expect(isHeicLikeMedia({ fileName: 'photo.heif' })).toBe(true);
    expect(isHeicLikeMedia({ url: 'https://cdn.test/photo.heic?token=1' })).toBe(true);
  });

  it('classifies image attachments once from all available metadata', () => {
    expect(isImageKind('image/jpeg')).toBe(true);
    expect(isImageKind('application/octet-stream', { fileName: 'photo.heic' })).toBe(true);
    expect(isImageKind('video/mp4')).toBe(false);
  });

  it('treats a HEIC file without a MIME type as a supported image', () => {
    const file = new File(['heic'], 'photo.HEIC');

    expect(isImageFile(file)).toBe(true);
    expect(isSupportedMediaFile(file)).toBe(true);
    expect(getUploadMimeType(file)).toBe('image/heic');
  });
});
