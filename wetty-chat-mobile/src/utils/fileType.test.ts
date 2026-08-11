import { describe, expect, it } from 'vitest';
import {
  categorizeAttachmentKind,
  detectFileMimeType,
  isHeicLikeMedia,
  isImageKind,
  mayBeMediaFile,
  withDetectedMimeType,
} from './fileType';

const ascii = (value: string) => Array.from(value, (character) => character.charCodeAt(0));

function createFile(bytes: number[], name: string, type = ''): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function isobmffHeader(brand: string): number[] {
  return [0, 0, 0, 0x20, ...ascii('ftyp'), ...ascii(brand), 0, 0, 0, 0, ...ascii(brand), ...Array(12).fill(0)];
}

function oggOpusHeader(): number[] {
  return [...ascii('OggS'), ...Array(24).fill(0), ...ascii('OpusHead'), ...Array(28).fill(0)];
}

describe('file type helpers', () => {
  it('recognizes HEIC MIME types and extensions', () => {
    expect(isHeicLikeMedia({ mimeType: ' IMAGE/HEIF; charset=binary ' })).toBe(true);
    expect(isHeicLikeMedia({ fileName: 'PHOTO.HEIC?version=1' })).toBe(true);
    expect(isHeicLikeMedia({ fileName: 'photo.heif#preview' })).toBe(true);
    expect(isHeicLikeMedia({ fileName: 'photo.jpg' })).toBe(false);
  });

  it('classifies image attachments from normalized MIME and metadata', () => {
    expect(categorizeAttachmentKind('Image/JPEG; charset=binary')).toBe('image');
    expect(isImageKind('image/jpeg')).toBe(true);
    expect(isImageKind('application/octet-stream', { fileName: 'photo.heic' })).toBe(true);
    expect(isImageKind('video/mp4')).toBe(false);
  });

  it('uses byte detection when a renamed image disagrees with its declared type', async () => {
    const pngHeader = [
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0,
      0,
      0,
      13,
      ...ascii('IHDR'),
      ...Array(17).fill(0),
      0,
      0,
      0,
      0,
      ...ascii('IDAT'),
      ...Array(4).fill(0),
    ];

    await expect(detectFileMimeType(createFile(pngHeader, 'photo.jpg', 'image/jpeg'))).resolves.toBe('image/png');
  });

  it('detects HEIC bytes without a declared type', async () => {
    await expect(detectFileMimeType(createFile(isobmffHeader('heic'), 'IMG_1.HEIC'))).resolves.toBe('image/heic');
  });

  it('preserves declared audio MIME parameters for ISO-BMFF and Ogg containers', async () => {
    await expect(
      detectFileMimeType(createFile(isobmffHeader('isom'), 'recording.mp4', 'audio/mp4;codecs=mp4a.40.2')),
    ).resolves.toBe('audio/mp4;codecs=mp4a.40.2');
    await expect(
      detectFileMimeType(createFile(oggOpusHeader(), 'recording.ogg', 'audio/ogg;codecs=opus')),
    ).resolves.toBe('audio/ogg;codecs=opus');
  });

  it('falls back to the declared type, HEIC filename, then binary', async () => {
    await expect(detectFileMimeType(createFile(Array(64).fill(0), 'photo.jpg', 'image/jpeg'))).resolves.toBe(
      'image/jpeg',
    );
    await expect(detectFileMimeType(createFile(Array(64).fill(0), 'photo.heic'))).resolves.toBe('image/heic');
    await expect(detectFileMimeType(createFile(Array(64).fill(0), 'notes.bin'))).resolves.toBe(
      'application/octet-stream',
    );
  });

  it('only uses declared metadata as a synchronous admission hint', () => {
    expect(mayBeMediaFile(createFile([], 'photo.heic'))).toBe(true);
    expect(mayBeMediaFile(createFile([], 'notes.bin'))).toBe(false);
  });

  it('retypes mismatched files so blob previews expose the detected MIME', async () => {
    const original = new File([new Uint8Array([1, 2, 3])], 'photo.jpeg', {
      type: 'image/jpeg',
      lastModified: 42,
    });
    const retyped = withDetectedMimeType(original, 'image/png');

    expect(retyped).not.toBe(original);
    expect(retyped.type).toBe('image/png');
    expect(retyped.name).toBe('photo.jpeg');
    expect(retyped.lastModified).toBe(42);
    expect(new Uint8Array(await retyped.arrayBuffer())).toEqual(new Uint8Array(await original.arrayBuffer()));
    expect(withDetectedMimeType(original, 'image/jpeg')).toBe(original);
  });
});
