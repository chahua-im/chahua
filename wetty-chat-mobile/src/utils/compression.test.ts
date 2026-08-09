import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressImage } from './compression';

const heicMocks = vi.hoisted(() => ({ heicTo: vi.fn() }));

vi.mock('heic-to/csp', () => ({ heicTo: heicMocks.heicTo }));

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
    [4032, 3024, 1280, 960],
    [3024, 4032, 960, 1280],
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
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1280, 960);
    expect(context.imageSmoothingQuality).toBe('high');
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(result.file.name).toBe('photo.heic.avif');
    expect(result.dimensions).toEqual({ width: 1280, height: 960 });
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
