import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { vi } from 'vitest';
import { UploadErrorCode } from '../upload-error';
import { prepareMedia } from './prepare-media';

const media = vi.hoisted(() => ({ init: vi.fn() }));
const heic = vi.hoisted(() => ({ decode: vi.fn() }));
vi.mock('heic-to/csp', () => ({ heicTo: heic.decode }));
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BlobSource: class {},
  BufferTarget: class {
    buffer = new ArrayBuffer(1);
  },
  Conversion: { init: media.init },
  getFirstEncodableVideoCodec: vi.fn().mockResolvedValue('avc'),
  Input: class {},
  Mp4OutputFormat: class {},
  Output: class {},
  Quality: class {},
}));

describe('Media processing deadlines', () => {
  let decode: ReturnType<typeof vi.fn>;
  let bitmap: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('File', NodeFile);
    vi.stubGlobal('Blob', NodeBlob);
    decode = vi.fn().mockResolvedValue(undefined);
    bitmap = vi.fn().mockRejectedValue(new Error('Unsupported codec'));
    vi.stubGlobal('createImageBitmap', bitmap);
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        naturalWidth = 800;
        naturalHeight = 600;
        removeAttribute = vi.fn();
        decode = decode;
      },
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:metadata');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    media.init.mockReset();
    heic.decode.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function videoElement() {
    const video = document.createElement('video');
    vi.spyOn(video, 'load').mockImplementation(() => {});
    vi.spyOn(video, 'videoWidth', 'get').mockReturnValue(800);
    vi.spyOn(video, 'videoHeight', 'get').mockReturnValue(600);
    vi.spyOn(document, 'createElement').mockReturnValue(video);
    return video;
  }

  function heicFiles() {
    decode.mockRejectedValue(new Error('HEIC needs the fallback decoder'));
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return {
            drawImage: vi.fn(),
            getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
          };
        }
        convertToBlob = async () => new Blob(['small'], { type: 'image/webp' });
      },
    );
    heic.decode.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ width: 800, height: 600, close: vi.fn() }), 20_000);
        }),
    );
    return new File(['heic'], 'photo.heic', { type: 'image/heic' });
  }

  it('excludes HEIC queue waiting from each file processing deadline', async () => {
    const file = heicFiles();
    const pending = Promise.allSettled(
      Array.from({ length: 3 }, () => prepareMedia(file, new AbortController().signal)),
    );
    await vi.waitFor(() => expect(heic.decode).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000);
    const results = await pending;
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(heic.decode).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a queued HEIC without starting its decoder or blocking later files', async () => {
    const file = heicFiles();
    const controller = new AbortController();
    const pending = Promise.allSettled([
      prepareMedia(file, new AbortController().signal),
      prepareMedia(file, controller.signal),
      prepareMedia(file, new AbortController().signal),
    ]);
    await vi.waitFor(() => expect(heic.decode).toHaveBeenCalledTimes(1));
    controller.abort();
    await vi.advanceTimersByTimeAsync(40_000);
    const results = await pending;
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(results[1]).toMatchObject({ reason: { name: 'AbortError' } });
    expect(heic.decode).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still times out a stalled HEIC after it leaves the queue and discards its late bitmap', async () => {
    const file = heicFiles();
    const delayedBitmap = { width: 800, height: 600, close: vi.fn() };
    let finish!: (value: typeof delayedBitmap) => void;
    heic.decode
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ ...delayedBitmap, close: vi.fn() }), 20_000);
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const pending = Promise.allSettled([
      prepareMedia(file, new AbortController().signal),
      prepareMedia(file, new AbortController().signal),
    ]);
    await vi.waitFor(() => expect(heic.decode).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(heic.decode).toHaveBeenCalledTimes(2);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject([
      { status: 'fulfilled' },
      { status: 'rejected', reason: { code: UploadErrorCode.ProcessingTimeout } },
    ]);
    finish(delayedBitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(delayedBitmap.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out stalled decoding, releases its URL and never starts compression after a late decode', async () => {
    let resolve!: () => void;
    decode.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    const pending = prepareMedia(
      new File(['image'], 'photo.jpg', { type: 'image/jpeg' }),
      new AbortController().signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({ code: UploadErrorCode.ProcessingTimeout });
    await vi.waitFor(() => expect(decode).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:metadata');
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(bitmap).not.toHaveBeenCalled();
  });

  it('allows long processing while progress increases, but repeated progress does not extend the deadline', async () => {
    const video = videoElement();
    let complete!: () => void;
    const conversion = {
      discardedTracks: [],
      onProgress: undefined as ((value: number) => void) | undefined,
      execute: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      ),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    media.init.mockResolvedValue(conversion);
    const file = new File(['video'], 'movie.mp4', { type: 'video/mp4' });
    const progress = vi.fn();
    const pending = prepareMedia(file, new AbortController().signal, progress);
    const rejected = expect(pending).rejects.toMatchObject({ code: UploadErrorCode.ProcessingTimeout });
    await vi.waitFor(() => expect(video.getAttribute('src')).toBe('blob:metadata'));
    video.dispatchEvent(new Event('loadedmetadata'));
    await vi.waitFor(() => expect(conversion.execute).toHaveBeenCalled());
    for (const value of [0.1, 0.2, 0.3]) {
      await vi.advanceTimersByTimeAsync(25_000);
      expect(conversion.cancel).not.toHaveBeenCalled();
      conversion.onProgress!(value);
    }
    await vi.advanceTimersByTimeAsync(20_000);
    conversion.onProgress!(0.3);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(conversion.cancel).toHaveBeenCalledOnce();
    progress.mockClear();
    conversion.onProgress!(1);
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).not.toHaveBeenCalled();
  });

  it('cancels stalled video metadata and removes event handlers and the source', async () => {
    const video = videoElement();
    const controller = new AbortController();
    const pending = prepareMedia(new File(['video'], 'movie.mp4', { type: 'video/mp4' }), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(video.getAttribute('src')).toBe('blob:metadata'));
    controller.abort();
    await rejected;
    expect(video.onloadedmetadata).toBeNull();
    expect(video.onerror).toBeNull();
    expect(video.hasAttribute('src')).toBe(false);
    expect(video.load).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:metadata');
    expect(media.init).not.toHaveBeenCalled();
  });

  it('still falls back to the original file when compression fails promptly', async () => {
    const file = new File(['image'], 'photo.jpg', { type: 'image/jpeg' });
    await expect(prepareMedia(file, new AbortController().signal)).resolves.toMatchObject({ file });
    expect(bitmap).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
