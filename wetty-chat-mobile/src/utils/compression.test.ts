import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressImage, compressVideo } from './compression';

const heicMocks = vi.hoisted(() => ({ heicTo: vi.fn() }));
const mediabunnyMocks = vi.hoisted(() => ({ init: vi.fn(), execute: vi.fn() }));

vi.mock('heic-to/csp', () => ({ heicTo: heicMocks.heicTo }));
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BlobSource: class {},
  BufferTarget: class {
    buffer = new ArrayBuffer(8);
  },
  Conversion: { init: mediabunnyMocks.init },
  getFirstEncodableVideoCodec: vi.fn().mockResolvedValue('avc'),
  Input: class {},
  Mp4OutputFormat: class {},
  Output: class {},
  Quality: class {},
}));

function mockCanvas(output: Blob) {
  const context = {
    drawImage: vi.fn(),
    imageSmoothingQuality: 'low',
  };
  const convertToBlob = vi.fn().mockResolvedValue(output);

  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return context;
      }

      convertToBlob = convertToBlob;
    },
  );

  return { context, convertToBlob };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('image compression sources', () => {
  it.each([
    [4032, 3024, 1920, 1440],
    [3024, 4032, 1440, 1920],
    [640, 480, 640, 480],
  ])('resizes %sx%s files to %sx%s while creating the bitmap', async (width, height, targetWidth, targetHeight) => {
    const file = new File([new Uint8Array(100)], 'photo.jpg', { type: 'image/jpeg' });
    const bitmap = { width: targetWidth, height: targetHeight, close: vi.fn() } as unknown as ImageBitmap;
    const createImageBitmapMock = vi.fn().mockResolvedValue(bitmap);
    const { context } = mockCanvas(new Blob(['small'], { type: 'image/avif' }));
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    const result = await compressImage(file, { width, height });

    expect(createImageBitmapMock).toHaveBeenCalledWith(file, {
      imageOrientation: 'from-image',
      resizeWidth: targetWidth,
      resizeHeight: targetHeight,
      resizeQuality: 'high',
    });
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, targetWidth, targetHeight);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(result.dimensions).toEqual({ width: targetWidth, height: targetHeight });
  });

  it('draws HEIC fallback bitmaps at the target size without creating another bitmap', async () => {
    const file = new File(['heic'], 'photo.heic', { type: 'image/heic' });
    const bitmap = { width: 4032, height: 3024, close: vi.fn() } as unknown as ImageBitmap;
    const createImageBitmapMock = vi.fn();
    const { context } = mockCanvas(new Blob(['larger output'], { type: 'image/avif' }));
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);
    heicMocks.heicTo.mockResolvedValue(bitmap);

    const result = await compressImage(file);

    expect(createImageBitmapMock).not.toHaveBeenCalled();
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1920, 1440);
    expect(context.imageSmoothingQuality).toBe('high');
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(result.file.name).toBe('photo.heic.avif');
    expect(result.dimensions).toEqual({ width: 1920, height: 1440 });
  });

  it('preserves animated GIFs without creating a bitmap', async () => {
    const file = new File(['animated GIF'], 'loop.gif', { type: 'image/gif' });
    const createImageBitmapMock = vi.fn();
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    const result = await compressImage(file, { width: 4032, height: 3024 });

    expect(result.file).toBe(file);
    expect(result.dimensions).toEqual({ width: 4032, height: 3024 });
    expect(createImageBitmapMock).not.toHaveBeenCalled();
  });
});

describe('video compression', () => {
  const dimensions = { width: 1920, height: 1080 };

  it('preserves the original when conversion would discard a video track', async () => {
    const file = new File([new Uint8Array(1024 * 1024)], 'video.mp4', { type: 'video/mp4' });
    mediabunnyMocks.init.mockResolvedValue({
      discardedTracks: [{ track: { type: 'video' }, reason: 'undecodable_source_codec' }],
      utilizedTracks: [],
      execute: mediabunnyMocks.execute,
      cancel: vi.fn(),
    });

    const result = await compressVideo(file, dimensions);

    expect(result.file).toBe(file);
    expect(result.dimensions).toEqual(dimensions);
    expect(mediabunnyMocks.execute).not.toHaveBeenCalled();
  });

  it('uses a healthy conversion result', async () => {
    const file = new File([new Uint8Array(1024 * 1024)], 'video.mp4', { type: 'video/mp4' });
    mediabunnyMocks.init.mockResolvedValue({
      discardedTracks: [],
      utilizedTracks: [{ type: 'video' }],
      execute: mediabunnyMocks.execute,
      cancel: vi.fn(),
    });

    const result = await compressVideo(file, dimensions);

    expect(mediabunnyMocks.init).toHaveBeenCalledWith(
      expect.objectContaining({ showWarnings: false, tracks: 'primary' }),
    );
    expect(mediabunnyMocks.execute).toHaveBeenCalledOnce();
    expect(result.file).not.toBe(file);
    expect(result.file).toMatchObject({ name: 'video.mp4.mp4', type: 'video/mp4' });
    expect(result.dimensions).toEqual({ width: 1920, height: 1080 });
  });
});
