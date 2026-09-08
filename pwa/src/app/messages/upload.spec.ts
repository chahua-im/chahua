import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { vi } from 'vitest';
import { AttachmentsService } from '../../generated/endpoints/attachments/attachments.service';
import { provideChahuaBaseUrl } from '../../generated/endpoints/chahua.base-url';
import { AttachmentUploadPurpose, type SnowflakeID } from '../../generated/models';
import { encodeId } from '../api/snowflake-id';
import { AttachmentUpload, UploadStatus, uploadBlob } from './upload';

class FakeUpload {
  static requests: FakeUpload[] = [];
  status = 200;
  upload = {
    onprogress: undefined as
      ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | undefined,
  };
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  onloadend?: () => void;
  open = vi.fn();
  send = vi.fn();
  setRequestHeader = vi.fn();
  abort = vi.fn(() => {
    this.onabort?.();
    this.onloadend?.();
  });
  constructor() {
    FakeUpload.requests.push(this);
  }
  finish(status = 200) {
    this.status = status;
    this.onload?.();
    this.onloadend?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
}

beforeEach(() => {
  FakeUpload.requests = [];
  vi.stubGlobal('XMLHttpRequest', FakeUpload);
  vi.stubGlobal('File', NodeFile);
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Signed upload', () => {
  it('sends only the storage signature headers and reports upload progress', async () => {
    const progress = vi.fn();
    const pending = uploadBlob(
      'https://storage.invalid/signed',
      new Blob(['test']),
      { 'Content-Type': 'text/plain' },
      undefined,
      progress,
    );
    const xhr = FakeUpload.requests[0];
    expect(xhr.setRequestHeader.mock.calls).toEqual([['Content-Type', 'text/plain']]);
    xhr.progress(2, 4);
    expect(progress).toHaveBeenCalledWith(0.5);
    xhr.finish();
    await pending;
  });
  it('rejects HTTP errors and aborts removed uploads', async () => {
    let pending = uploadBlob('https://storage.invalid/signed', new Blob(), {});
    FakeUpload.requests[0].finish(403);
    await expect(pending).rejects.toThrow('上传失败');
    const controller = new AbortController();
    pending = uploadBlob('https://storage.invalid/signed', new Blob(), {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('does not send an already aborted upload', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(uploadBlob('https://storage.invalid/signed', new Blob(), {}, controller.signal)).rejects.toMatchObject(
      {
        name: 'AbortError',
      },
    );
    expect(FakeUpload.requests[0].send).not.toHaveBeenCalled();
  });
});

describe('Upload activity deadlines', () => {
  it('allows a large transfer to exceed the timeout while bytes keep progressing', async () => {
    vi.useFakeTimers();
    const pending = uploadBlob('https://storage.invalid/large', new Blob(['large']), {});
    const xhr = FakeUpload.requests[0];
    for (let bytes = 1; bytes <= 5; bytes++) {
      await vi.advanceTimersByTimeAsync(25_000);
      xhr.progress(bytes, 6);
    }
    expect(xhr.abort).not.toHaveBeenCalled();
    xhr.finish();
    await pending;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(xhr.abort).not.toHaveBeenCalled();
  });

  it('aborts when progress stalls, including repeated events with the same byte count', async () => {
    vi.useFakeTimers();
    const pending = uploadBlob('https://storage.invalid/stalled', new Blob(['file']), {});
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    const xhr = FakeUpload.requests[0];
    xhr.progress(1, 4);
    await vi.advanceTimersByTimeAsync(20_000);
    xhr.progress(1, 4);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(xhr.abort).toHaveBeenCalledOnce();
  });

  it('terminates a standalone transfer on offline and ignores callbacks after abort', async () => {
    const progress = vi.fn();
    const pending = uploadBlob('https://storage.invalid/offline', new Blob(), {}, undefined, progress);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const xhr = FakeUpload.requests[0];
    window.dispatchEvent(new Event('offline'));
    await rejected;
    xhr.progress(1, 1);
    xhr.finish();
    expect(progress).not.toHaveBeenCalled();
    expect(xhr.abort).toHaveBeenCalledOnce();
  });
});

describe('Attachment upload tasks', () => {
  let http: HttpTestingController;
  let tasks: AttachmentUpload[];
  let convertToBlob: ReturnType<typeof vi.fn<() => Promise<Blob>>>;
  let createBitmap: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideChahuaBaseUrl('/_api')] });
    http = TestBed.inject(HttpTestingController);
    tasks = [];
    let nextUrl = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:mock-${++nextUrl}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        naturalWidth = 4000;
        naturalHeight = 3000;
        decode = vi.fn().mockResolvedValue(undefined);
      },
    );
    createBitmap = vi.fn().mockResolvedValue({ width: 1920, height: 1440, close: vi.fn() });
    vi.stubGlobal('createImageBitmap', createBitmap);
    convertToBlob = vi.fn().mockImplementation(() => Promise.resolve(new Blob(['small'], { type: 'image/avif' })));
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { drawImage: vi.fn(), imageSmoothingQuality: 'low' };
        }
        convertToBlob = convertToBlob;
      },
    );
  });
  afterEach(() => {
    for (const task of tasks) task.dispose();
    http.verify({ ignoreCancelled: true });
  });

  function create(purpose = AttachmentUploadPurpose.file, file = new File(['hello'], 'note.txt')) {
    const task = new AttachmentUpload(TestBed.inject(AttachmentsService), file, purpose);
    tasks.push(task);
    return task;
  }
  function photo() {
    return new File([new Uint8Array(100)], 'photo.jpg', { type: 'image/jpeg' });
  }
  async function sign(id: SnowflakeID = encodeId('100')) {
    await vi.waitFor(() => {
      http.expectOne('/_api/attachments/upload-url').flush({
        attachmentId: id,
        uploadHeaders: { 'Content-Type': 'application/octet-stream' },
        uploadUrl: 'https://storage.invalid/upload',
      });
    });
    await vi.waitFor(() => expect(FakeUpload.requests.at(-1)).toBeDefined());
    return FakeUpload.requests.at(-1)!;
  }

  it.each([AttachmentUploadPurpose.file, AttachmentUploadPurpose.voice])(
    'starts %s immediately, shares the pending promise and reuses a successful ID',
    async (purpose) => {
      const file = new File(['original bytes'], 'source.jpg', { type: 'image/jpeg' });
      const task = create(purpose, file);
      const pending = task.retry();
      expect(task.retry()).toBe(pending);
      expect(task.state()).toEqual({ status: UploadStatus.Uploading, progress: 0 });
      http.expectOne('/_api/attachments/config').flush({ maxFileSizeBytes: 1024 });
      await vi.waitFor(() => {
        const request = http.expectOne('/_api/attachments/upload-url');
        expect(request.request.body).toEqual({
          filename: file.name,
          contentType: file.type,
          size: file.size,
          purpose,
        });
        request.flush({
          attachmentId: encodeId('100'),
          uploadHeaders: {},
          uploadUrl: 'https://storage.invalid/upload',
        });
      });
      await vi.waitFor(() => expect(FakeUpload.requests).toHaveLength(1));
      const xhr = FakeUpload.requests[0];
      expect(xhr.send).toHaveBeenCalledWith(file);
      expect(createBitmap).not.toHaveBeenCalled();
      xhr.progress(3, 4);
      expect(task.state().progress).toBe(0.75);
      xhr.finish();
      await expect(pending).resolves.toBe(encodeId('100'));
      expect(task.state()).toEqual({ status: UploadStatus.Ready, progress: 1, id: encodeId('100') });
      await expect(task.retry()).resolves.toBe(encodeId('100'));
      http.expectNone('/_api/attachments/config');
      expect(FakeUpload.requests).toHaveLength(1);
      expect(task.file).toBe(file);
      expect(task.url).toBe('blob:mock-1');
      expect(URL.createObjectURL).toHaveBeenCalledOnce();
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    },
  );

  it('compresses media before checking size and exposes dimensions and both progress phases', async () => {
    let compressed!: (blob: Blob) => void;
    convertToBlob.mockReturnValue(new Promise<Blob>((resolve) => (compressed = resolve)));
    const task = create(AttachmentUploadPurpose.media, photo());
    const pending = task.retry();
    http.expectOne('/_api/attachments/config').flush({ maxFileSizeBytes: 10 });
    await vi.waitFor(() => expect(convertToBlob).toHaveBeenCalledOnce());
    expect(task.state()).toEqual({ status: UploadStatus.Processing, progress: 0.5 });
    expect(task.retry()).toBe(pending);
    http.expectNone('/_api/attachments/upload-url');
    compressed(new Blob(['small'], { type: 'image/avif' }));
    await vi.waitFor(() => {
      const request = http.expectOne('/_api/attachments/upload-url');
      expect(request.request.body).toEqual({
        filename: 'photo.jpg.avif',
        contentType: 'image/avif',
        size: 5,
        purpose: AttachmentUploadPurpose.media,
        width: 1920,
        height: 1440,
      });
      request.flush({ attachmentId: encodeId('100'), uploadHeaders: {}, uploadUrl: 'https://storage.invalid/upload' });
    });
    await vi.waitFor(() => expect(FakeUpload.requests).toHaveLength(1));
    expect(task.state()).toEqual({ status: UploadStatus.Uploading, progress: 0, width: 1920, height: 1440 });
    FakeUpload.requests[0].progress(1, 2);
    expect(task.state().progress).toBe(0.5);
    FakeUpload.requests[0].finish();
    await expect(pending).resolves.toBe(encodeId('100'));
    expect(task.state()).toMatchObject({ status: UploadStatus.Ready, width: 1920, height: 1440 });
    expect(task.url).toBe('blob:mock-1');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(task.url);
  });

  it('contains failures and reuses prepared media and the preview URL on retry', async () => {
    const task = create(AttachmentUploadPurpose.media, photo());
    const pending = task.retry();
    http.expectOne('/_api/attachments/config').flush({ maxFileSizeBytes: 1024 });
    (await sign()).finish(403);
    await expect(pending).resolves.toBeUndefined();
    expect(task.state()).toMatchObject({ status: UploadStatus.Failed, width: 1920, height: 1440 });
    expect(task.state().id).toBeUndefined();
    const retry = task.retry();
    expect(task.retry()).toBe(retry);
    http.expectOne('/_api/attachments/config').flush({ maxFileSizeBytes: 1024 });
    await sign(encodeId('101'));
    await vi.waitFor(() => expect(FakeUpload.requests).toHaveLength(2));
    expect(FakeUpload.requests[1].send.mock.calls[0][0]).toBe(FakeUpload.requests[0].send.mock.calls[0][0]);
    FakeUpload.requests[1].finish();
    await expect(retry).resolves.toBe(encodeId('101'));
    expect(createBitmap).toHaveBeenCalledOnce();
    expect(task.url).toBe('blob:mock-1');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(task.url);
  });

  it.each([AttachmentUploadPurpose.file, AttachmentUploadPurpose.media])(
    'fails invalid %s input without requesting a storage URL',
    async (purpose) => {
      const task = create(purpose, new File(['oversized'], 'note.txt', { type: 'text/plain' }));
      const pending = task.retry();
      http.expectOne('/_api/attachments/config').flush({ maxFileSizeBytes: 1 });
      await expect(pending).resolves.toBeUndefined();
      expect(task.state().status).toBe(UploadStatus.Failed);
      http.expectNone('/_api/attachments/upload-url');
      expect(FakeUpload.requests).toHaveLength(0);
    },
  );

  it.each(['config', 'upload-url'])('contains an API failure at %s', async (stage) => {
    const task = create();
    const pending = task.retry();
    if (stage === 'upload-url') http.expectOne('/_api/attachments/config').flush({ maxFileSizeBytes: 1024 });
    await vi.waitFor(() =>
      http.expectOne('/_api/attachments/' + stage).flush({}, { status: 500, statusText: 'Failed' }),
    );
    await expect(pending).resolves.toBeUndefined();
    expect(task.state().status).toBe(UploadStatus.Failed);
    expect(FakeUpload.requests).toHaveLength(0);
  });

  it.each(['config', 'upload-url'])('cancels a pending %s request when disposed', async (stage) => {
    const task = create();
    const pending = task.retry();
    if (stage === 'upload-url') http.expectOne('/_api/attachments/config').flush({ maxFileSizeBytes: 1024 });
    await vi.waitFor(() => {
      const request = http.expectOne('/_api/attachments/' + stage);
      task.dispose();
      expect(request.cancelled).toBe(true);
    });
    await expect(pending).resolves.toBeUndefined();
    await expect(task.retry()).resolves.toBeUndefined();
    expect(FakeUpload.requests).toHaveLength(0);
    task.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(task.url);
  });

  it('does not continue after a compression result arrives following disposal', async () => {
    let compressed!: (blob: Blob) => void;
    convertToBlob.mockReturnValue(new Promise<Blob>((resolve) => (compressed = resolve)));
    const task = create(AttachmentUploadPurpose.media, photo());
    const pending = task.retry();
    http.expectOne('/_api/attachments/config').flush({ maxFileSizeBytes: 1024 });
    await vi.waitFor(() => expect(convertToBlob).toHaveBeenCalledOnce());
    task.dispose();
    await expect(pending).resolves.toBeUndefined();
    const state = task.state();
    compressed(new Blob(['small'], { type: 'image/avif' }));
    // Drain the compression continuation, which cannot start a signing request after disposal.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(task.state()).toBe(state);
    http.expectNone('/_api/attachments/upload-url');
    expect(FakeUpload.requests).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(task.url);
  });

  it('does not start storage upload if disposed immediately after receiving a signed URL', async () => {
    const task = create();
    const pending = task.retry();
    http.expectOne('/_api/attachments/config').flush({ maxFileSizeBytes: 1024 });
    await vi.waitFor(() => {
      http.expectOne('/_api/attachments/upload-url').flush({
        attachmentId: encodeId('100'),
        uploadHeaders: {},
        uploadUrl: 'https://storage.invalid/upload',
      });
      task.dispose();
    });
    await expect(pending).resolves.toBeUndefined();
    expect(FakeUpload.requests).toHaveLength(0);
  });

  it('aborts storage upload, releases the preview once and ignores late callbacks', async () => {
    const task = create();
    const pending = task.retry();
    http.expectOne('/_api/attachments/config').flush({ maxFileSizeBytes: 1024 });
    const xhr = await sign();
    task.dispose();
    await expect(pending).resolves.toBeUndefined();
    const state = task.state();
    xhr.progress(4, 4);
    xhr.finish();
    task.dispose();
    await expect(task.retry()).resolves.toBeUndefined();
    expect(task.state()).toBe(state);
    expect(xhr.abort).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(task.url);
    http.expectNone('/_api/attachments/config');
  });

  it('aborts only the offline attempt and reuses the preview when online retries', async () => {
    const task = create();
    const pending = task.retry();
    http.expectOne('/_api/attachments/config').flush({ maxFileSizeBytes: 1024 });
    const xhr = await sign();
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    await pending;
    expect(xhr.abort).toHaveBeenCalledOnce();
    expect(task.state().status).toBe(UploadStatus.Failed);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(task.url);
    online.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    const retry = task.retry();
    http.expectOne('/_api/attachments/config').flush({ maxFileSizeBytes: 1024 });
    (await sign(encodeId('101'))).finish();
    await expect(retry).resolves.toBe(encodeId('101'));
    expect(task.url).toBe('blob:mock-1');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(task.url);
  });

  it('times out a pending API round and automatically retries transient failure', async () => {
    vi.useFakeTimers();
    const task = create();
    const pending = task.retry();
    const config = http.expectOne('/_api/attachments/config');
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(config.cancelled).toBe(true);
    expect(task.state().status).toBe(UploadStatus.Failed);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(task.url);
    await vi.advanceTimersByTimeAsync(1_000);
    const retried = http.expectOne('/_api/attachments/config');
    expect(task.state().status).toBe(UploadStatus.Uploading);
    task.dispose();
    expect(retried.cancelled).toBe(true);
    await task.retry();
  });

  it('does not automatically retry permanent API errors on timers or online', async () => {
    vi.useFakeTimers();
    const task = create();
    const pending = task.retry();
    http.expectOne('/_api/attachments/config').flush({}, { status: 403, statusText: 'Forbidden' });
    await pending;
    expect(task.retryable).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    window.dispatchEvent(new Event('online'));
    http.expectNone('/_api/attachments/config');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(task.url);
  });
});
