import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compressImage, compressVideo } from './compression';
beforeEach(() => {
  vi.stubGlobal('File', NodeFile);
  vi.stubGlobal('Blob', NodeBlob);
  heicMocks.heicTo.mockReset();
  mediabunnyMocks.init.mockReset();
  mediabunnyMocks.execute.mockReset();
});

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

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
  vi.restoreAllMocks();
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

  it('closes a HEIC bitmap returned after cancellation without starting canvas encoding', async () => {
    const file = new File(['heic'], 'photo.heic', { type: 'image/heic' });
    const bitmap = { width: 4032, height: 3024, close: vi.fn() } as unknown as ImageBitmap;
    const started = deferred<void>();
    const decoding = deferred<ImageBitmap>();
    heicMocks.heicTo.mockImplementationOnce(() => {
      started.resolve();
      return decoding.promise;
    });
    const createImageBitmapMock = vi.fn();
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);
    const { context, convertToBlob } = mockCanvas(new Blob(['small'], { type: 'image/avif' }));
    const controller = new AbortController();
    const onProgress = vi.fn();
    const result = compressImage(file, undefined, { signal: controller.signal, onProgress });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    controller.abort();
    decoding.resolve(bitmap);
    await rejected;
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(createImageBitmapMock).not.toHaveBeenCalled();
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(convertToBlob).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('closes a browser-decoded bitmap when cancelled while decoding', async () => {
    const file = new File([new Uint8Array(100)], 'photo.jpg', { type: 'image/jpeg' });
    const bitmap = { width: 640, height: 480, close: vi.fn() } as unknown as ImageBitmap;
    const started = deferred<void>();
    const decoding = deferred<ImageBitmap>();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => {
        started.resolve();
        return decoding.promise;
      }),
    );
    const { context, convertToBlob } = mockCanvas(new Blob(['small'], { type: 'image/avif' }));
    const controller = new AbortController();
    const result = compressImage(file, { width: 640, height: 480 }, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    controller.abort();
    decoding.resolve(bitmap);
    await rejected;
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(convertToBlob).not.toHaveBeenCalled();
  });

  it('stops after an in-flight browser encode completes instead of trying another format', async () => {
    const file = new File([new Uint8Array(100)], 'photo.jpg', { type: 'image/jpeg' });
    const bitmap = { width: 640, height: 480, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    const { convertToBlob } = mockCanvas(new Blob(['small'], { type: 'image/webp' }));
    const started = deferred<void>();
    const encoding = deferred<Blob>();
    convertToBlob.mockImplementationOnce(() => {
      started.resolve();
      return encoding.promise;
    });
    const controller = new AbortController();
    const onProgress = vi.fn();
    const result = compressImage(file, { width: 640, height: 480 }, { signal: controller.signal, onProgress });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    controller.abort();
    encoding.resolve(new Blob(['unsupported format fallback'], { type: 'image/png' }));
    await rejected;
    expect(convertToBlob).toHaveBeenCalledExactlyOnceWith({ type: 'image/avif', quality: 0.6 });
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledExactlyOnceWith(0.5);
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

  it('cancels an executing conversion and rejects with AbortError instead of returning the original', async () => {
    const file = new File([new Uint8Array(1024)], 'video.mp4', { type: 'video/mp4' });
    const started = deferred<void>();
    const execution = deferred<void>();
    mediabunnyMocks.execute.mockImplementationOnce(() => {
      started.resolve();
      return execution.promise;
    });
    const cancel = vi.fn(async () => {
      execution.reject(new Error('ConversionCanceledError'));
    });
    mediabunnyMocks.init.mockResolvedValueOnce({ discardedTracks: [], execute: mediabunnyMocks.execute, cancel });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();
    const result = compressVideo(file, dimensions, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    expect(cancel).not.toHaveBeenCalled();
    controller.abort();
    expect(cancel).toHaveBeenCalledOnce();
    await rejected;
    expect(mediabunnyMocks.execute).toHaveBeenCalledOnce();
    expect(warning).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'cancels a conversion that finishes initialization after abort, discarded tracks: %s',
    async (discarded) => {
      const file = new File([new Uint8Array(1024)], 'video.mp4', { type: 'video/mp4' });
      const conversion = {
        discardedTracks: discarded ? [{ track: { type: 'video' }, reason: 'undecodable_source_codec' }] : [],
        execute: mediabunnyMocks.execute,
        cancel: vi.fn().mockResolvedValue(undefined),
      };
      const started = deferred<void>();
      const initializing = deferred<typeof conversion>();
      mediabunnyMocks.init.mockImplementationOnce(() => {
        started.resolve();
        return initializing.promise;
      });
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const controller = new AbortController();
      const result = compressVideo(file, dimensions, { signal: controller.signal });
      const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
      await started.promise;
      controller.abort();
      initializing.resolve(conversion);
      await rejected;
      expect(conversion.cancel).toHaveBeenCalledOnce();
      expect(mediabunnyMocks.execute).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
    },
  );

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
