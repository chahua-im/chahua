import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { type Mock, vi } from 'vitest';
import { AttachmentUploadPurpose, type SnowflakeID } from '../../generated/models';
import { RpcErrorCode } from '../api/rpc-error';
import { provideRpcTesting, RpcTestPeer } from '../api/rpc-testing';
import { decodeId, encodeId } from '../api/snowflake-id';
import { SessionStore } from '../session/session-store';
import { AttachmentUploads, AttachmentUpload, UploadStatus, uploadBlob } from './upload';
import { UploadErrorCode, UploadStage } from './upload-error';
import { Diagnostics } from '../pwa/diagnostics';

class FakeUpload {
  static requests: FakeUpload[] = [];
  status = 200;
  responseText = '';
  upload = {
    onload: undefined as (() => void) | undefined,
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

  finish(status = 200, responseText = '') {
    this.status = status;
    this.responseText = responseText;
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
    FakeUpload.requests[0].finish(403, '<html><Code>AccessDenied</Code></html>');
    await expect(pending).rejects.toThrow('上传失败');
    await expect(pending).rejects.toHaveProperty('storage', { status: 403 });
    const controller = new AbortController();
    pending = uploadBlob('https://storage.invalid/signed', new Blob(), {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('detects expired links from an S3 error and keeps only safe diagnostics', async () => {
    const pending = uploadBlob('https://storage.invalid/signed', new Blob(), {});
    FakeUpload.requests[0].finish(
      403,
      '<Error><Code>AccessDenied</Code><Message>Request has expired</Message>' +
        '<RequestId>mock-request</RequestId><CanonicalRequest>private details</CanonicalRequest></Error>',
    );
    await expect(pending).rejects.toHaveProperty('storage', {
      status: 403,
      code: 'AccessDenied',
      requestId: 'mock-request',
      expired: true,
    });
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
    const rejected = expect(pending).rejects.toMatchObject({ code: UploadErrorCode.TransferStalled });
    const xhr = FakeUpload.requests[0];
    xhr.progress(1, 4);
    await vi.advanceTimersByTimeAsync(20_000);
    xhr.progress(1, 4);
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(xhr.abort).toHaveBeenCalledOnce();
  });

  it('reports a confirmation timeout after XHR finishes sending the file', async () => {
    vi.useFakeTimers();
    const pending = uploadBlob('https://storage.invalid/stalled', new Blob(['file']), {});
    const rejected = expect(pending).rejects.toMatchObject({ code: UploadErrorCode.StorageResponseTimeout });
    const xhr = FakeUpload.requests[0];
    xhr.progress(4, 4);
    xhr.upload.onload?.();
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(xhr.abort).toHaveBeenCalledOnce();
  });

  it('allows a standalone transfer despite an offline hint or event', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const progress = vi.fn();
    const pending = uploadBlob('https://storage.invalid/offline', new Blob(), {}, undefined, progress);
    const xhr = FakeUpload.requests[0];
    expect(xhr.send).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('offline'));
    xhr.progress(1, 1);
    xhr.finish();
    await pending;
    expect(progress).toHaveBeenCalledWith(1);
    expect(xhr.abort).not.toHaveBeenCalled();
  });
});

describe('Attachment upload tasks', () => {
  let peer: RpcTestPeer;
  let tasks: AttachmentUpload[];
  const user = signal({ uid: 1 });
  let convertToBlob: Mock<() => Promise<Blob>>;
  let createBitmap: Mock;

  beforeEach(() => {
    sessionStorage.removeItem('chahua.diagnostics');
    user.set({ uid: 1 });
    TestBed.configureTestingModule({ providers: [provideRpcTesting(), { provide: SessionStore, useValue: { user } }] });
    peer = TestBed.inject(RpcTestPeer);
    peer.authenticate();
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
        removeAttribute = vi.fn();
        decode = vi.fn().mockResolvedValue(undefined);
      },
    );
    createBitmap = vi.fn().mockResolvedValue({ width: 1866, height: 1400, close: vi.fn() });
    vi.stubGlobal('createImageBitmap', createBitmap);
    convertToBlob = vi.fn().mockImplementation(() => Promise.resolve(new Blob(['small'], { type: 'image/webp' })));
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return {
            drawImage: vi.fn(),
            getImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
            imageSmoothingQuality: 'low',
          };
        }
        convertToBlob = convertToBlob;
      },
    );
  });

  afterEach(() => {
    try {
      for (const task of tasks) task.dispose();
      peer.verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  function create(purpose = AttachmentUploadPurpose.file, file = new File(['hello'], 'note.txt')) {
    const task = TestBed.inject(AttachmentUploads).create(file, purpose);
    tasks.push(task);
    return task;
  }

  it('shares pending and successful configuration while signing each file separately', async () => {
    const first = create();
    const second = create();
    config();
    const signed = [await peer.expectAsync('attachments.createUploadUrl')];
    const third = create();
    peer.expectNone('attachments.getConfig');
    signed.push(
      await peer.expectAsync('attachments.createUploadUrl'),
      await peer.expectAsync('attachments.createUploadUrl'),
    );
    for (const task of [first, second, third]) task.dispose();
    for (const request of signed) request.error(RpcErrorCode.Unavailable);
    await Promise.all([first, second, third].map((task) => task.retry()));
    expect(FakeUpload.requests).toHaveLength(0);
  });

  it('reads the upload limit again after switching accounts', async () => {
    const first = create();
    config(1);
    await first.retry();
    user.set({ uid: 2 });
    const second = create();
    config(2);
    await second.retry();
    expect(second.state().error?.code).toBe(UploadErrorCode.TooLarge);
  });

  function photo() {
    return new File([new Uint8Array(100)], 'photo.jpg', { type: 'image/jpeg' });
  }

  function config(maxFileSizeBytes = 1024) {
    peer.expect('attachments.getConfig').flush({ maxFileSizeBytes });
  }

  async function sign(id: SnowflakeID = encodeId('100')) {
    (
      await peer.expectAsync(
        'attachments.createUploadUrl',
        (params) =>
          typeof params['filename'] === 'string' &&
          typeof params['contentType'] === 'string' &&
          typeof params['size'] === 'number' &&
          typeof params['purpose'] === 'string',
      )
    ).flush({
      attachmentId: decodeId(id),
      uploadHeaders: { 'Content-Type': 'application/octet-stream' },
      uploadUrl: 'https://storage.invalid/upload',
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
      expect(task.state()).toEqual({ status: UploadStatus.Uploading, progress: undefined });
      config();
      const request = await peer.expectAsync('attachments.createUploadUrl');
      expect(request.params).toEqual({
        filename: file.name,
        contentType: file.type,
        size: file.size,
        purpose,
      });
      request.flush({ attachmentId: '100', uploadHeaders: {}, uploadUrl: 'https://storage.invalid/upload' });
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
      peer.expectNone('attachments.getConfig');
      expect(FakeUpload.requests).toHaveLength(1);
      expect(task.file).toBe(file);
      expect(task.url).toBe('blob:mock-1');
      expect(URL.createObjectURL).toHaveBeenCalledOnce();
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['', 'image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])],
    ['application/octet-stream', 'video/mp4', new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109])],
  ])('detects media in %s file uploads without changing their bytes', async (type, detected, bytes) => {
    const file = new File([bytes], 'original.bin', { type });
    const task = create(AttachmentUploadPurpose.file, file);
    const pending = task.retry();
    config();
    const request = await peer.expectAsync('attachments.createUploadUrl');
    expect(request.params).toEqual({
      filename: file.name,
      contentType: detected,
      size: file.size,
      purpose: AttachmentUploadPurpose.file,
    });
    expect(task.state().contentType).toBe(detected);
    request.flush({ attachmentId: '100', uploadHeaders: {}, uploadUrl: 'https://storage.invalid/upload' });
    await vi.waitFor(() => expect(FakeUpload.requests).toHaveLength(1));
    const xhr = FakeUpload.requests[0];
    const uploaded = xhr.send.mock.calls[0][0] as File;
    expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(bytes);
    expect(uploaded.name).toBe(file.name);
    expect(createBitmap).not.toHaveBeenCalled();
    expect(convertToBlob).not.toHaveBeenCalled();
    xhr.finish();
    await expect(pending).resolves.toBe(encodeId('100'));
  });

  it('keeps image processing indeterminate and reports upload bytes until storage confirms success', async () => {
    let compressed!: (blob: Blob) => void;
    convertToBlob.mockReturnValue(new Promise<Blob>((resolve) => (compressed = resolve)));
    const task = create(AttachmentUploadPurpose.media, photo());
    const pending = task.retry();
    config(10);
    await vi.waitFor(() => expect(convertToBlob).toHaveBeenCalledOnce());
    expect(task.state()).toEqual({ status: UploadStatus.Processing, progress: undefined });
    expect(task.retry()).toBe(pending);
    peer.expectNone('attachments.createUploadUrl');
    compressed(new Blob(['small'], { type: 'image/webp' }));
    const request = await peer.expectAsync('attachments.createUploadUrl');
    expect(request.params).toEqual({
      filename: 'photo.jpg.webp',
      contentType: 'image/webp',
      size: 5,
      purpose: AttachmentUploadPurpose.media,
      width: 1866,
      height: 1400,
    });
    expect(task.state()).toMatchObject({ status: UploadStatus.Uploading, progress: undefined });
    request.flush({ attachmentId: '100', uploadHeaders: {}, uploadUrl: 'https://storage.invalid/upload' });
    await vi.waitFor(() => expect(FakeUpload.requests).toHaveLength(1));
    expect(task.state()).toEqual({ status: UploadStatus.Uploading, progress: 0, width: 1866, height: 1400 });
    FakeUpload.requests[0].progress(1, 2);
    expect(task.state().progress).toBe(0.5);
    FakeUpload.requests[0].progress(2, 2);
    expect(task.state()).toMatchObject({ status: UploadStatus.Uploading, progress: 1 });
    expect(task.state().id).toBeUndefined();
    FakeUpload.requests[0].finish();
    await expect(pending).resolves.toBe(encodeId('100'));
    expect(task.state()).toMatchObject({ status: UploadStatus.Ready, width: 1866, height: 1400 });
    expect(task.url).toBe('blob:mock-1');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(task.url);
  });

  it('contains failures and reuses prepared media and the preview URL on retry', async () => {
    const task = create(AttachmentUploadPurpose.media, photo());
    const pending = task.retry();
    config();
    (await sign()).finish(403);
    await expect(pending).resolves.toBeUndefined();
    expect(task.state()).toMatchObject({ status: UploadStatus.Failed, width: 1866, height: 1400 });
    expect(task.state().id).toBeUndefined();
    const retry = task.retry();
    expect(task.state().progress).toBeUndefined();
    expect(task.retry()).toBe(retry);
    peer.expectNone('attachments.getConfig');
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
      config(1);
      await expect(pending).resolves.toBeUndefined();
      expect(task.state().status).toBe(UploadStatus.Failed);
      peer.expectNone('attachments.createUploadUrl');
      expect(FakeUpload.requests).toHaveLength(0);
    },
  );

  it.each(['config', 'upload-url'])('contains an API failure at %s', async (stage) => {
    const task = create();
    const pending = task.retry();
    if (stage === 'upload-url') config();
    (await peer.expectAsync(stage === 'config' ? 'attachments.getConfig' : 'attachments.createUploadUrl')).error(
      RpcErrorCode.Internal,
    );
    await expect(pending).resolves.toBeUndefined();
    expect(task.state().status).toBe(UploadStatus.Failed);
    expect(FakeUpload.requests).toHaveLength(0);
  });

  it('reports the size limit and never retries an oversized file unchanged', async () => {
    vi.useFakeTimers();
    const task = create();
    const pending = task.retry();
    config(4);
    await pending;
    expect(task.state().error).toMatchObject({
      code: UploadErrorCode.TooLarge,
      maxSizeMiB: 4 / 1024 / 1024,
      canRetry: false,
    });
    await task.retry();
    await vi.advanceTimersByTimeAsync(120_000);
    window.dispatchEvent(new Event('online'));
    peer.expectNone('attachments.getConfig');
    peer.expectNone('attachments.createUploadUrl');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(task.url);
  });

  it('stops automatic retries for non-media selected through the media picker', async () => {
    vi.useFakeTimers();
    const task = create(AttachmentUploadPurpose.media, new File(['text'], 'note.txt', { type: 'text/plain' }));
    const pending = task.retry();
    config();
    await pending;
    expect(task.state().error).toMatchObject({
      code: UploadErrorCode.UnsupportedMedia,
      stage: UploadStage.Processing,
      autoRetry: false,
      canRetry: false,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    window.dispatchEvent(new Event('online'));
    peer.expectNone('attachments.getConfig');
    expect(FakeUpload.requests).toHaveLength(0);
  });

  it('exposes a processing timeout without signing or uploading a late result', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const decode = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
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
    const task = create(AttachmentUploadPurpose.media, photo());
    const pending = task.retry();
    config();
    await vi.waitFor(() => expect(decode).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(task.state().error).toMatchObject({
      code: UploadErrorCode.ProcessingTimeout,
      stage: UploadStage.Processing,
      autoRetry: false,
      canRetry: true,
    });
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    peer.expectNone('attachments.createUploadUrl');
    peer.expectNone('attachments.getConfig');
    expect(FakeUpload.requests).toHaveLength(0);
    expect(task.state().status).toBe(UploadStatus.Failed);
  });

  it.each([
    ['', 'empty.txt', UploadErrorCode.Empty],
    ['text', '  ', UploadErrorCode.FilenameMissing],
    ['text', 'x'.repeat(256), UploadErrorCode.FilenameTooLong],
  ])('validates %s / %s before requesting config', async (contents, name, code) => {
    const task = create(AttachmentUploadPurpose.file, new File([contents], name));
    await task.retry();
    expect(task.state().error).toMatchObject({ code, canRetry: false, autoRetry: false });
    peer.expectNone('attachments.getConfig');
  });

  it.each([
    [RpcErrorCode.BadRequest, 'Attachment content type is invalid', UploadErrorCode.InvalidType, false],
    [RpcErrorCode.InvalidParams, 'Invalid params', UploadErrorCode.Protocol, false],
    [RpcErrorCode.Unauthorized, 'Expired token', UploadErrorCode.Authentication, false],
    [RpcErrorCode.Forbidden, 'Forbidden', UploadErrorCode.Forbidden, false],
    [RpcErrorCode.Overloaded, 'Too many requests', UploadErrorCode.RateLimited, true],
    [RpcErrorCode.Unavailable, 'Unavailable', UploadErrorCode.Server, true],
    [RpcErrorCode.DispatcherInternal, 'Internal error', UploadErrorCode.Server, true],
  ])('preserves the API error for RPC code %s despite an offline hint', async (rpcCode, detail, code, autoRetry) => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const task = create();
    const pending = task.retry();
    peer.expect('attachments.getConfig').error(rpcCode, detail);
    await pending;
    expect(task.state().error).toMatchObject({ code, stage: UploadStage.Config, autoRetry, rpcCode });
    expect(task.retryable).toBe(autoRetry);
    const report = JSON.parse(await TestBed.inject(Diagnostics).export());
    const failure = report.events.find((entry: { event: string }) => entry.event === 'upload.failed');
    expect(failure.details).toMatchObject({
      method: 'attachments.getConfig',
      requestId: expect.any(String),
      errorCode: rpcCode,
    });
  });

  it('reports a file type detection deadline as a processing timeout', async () => {
    vi.useFakeTimers();
    const file = new File(['data'], 'example.bin');
    const header = file.slice();
    vi.spyOn(file, 'slice').mockReturnValue(header);
    const readHeader = vi.spyOn(header, 'arrayBuffer').mockImplementation(() => new Promise(() => {}));
    const task = create(AttachmentUploadPurpose.file, file);
    const pending = task.retry();
    config();
    await vi.waitFor(() => expect(readHeader).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(task.state().error).toMatchObject({
      code: UploadErrorCode.ProcessingTimeout,
      stage: UploadStage.Processing,
      autoRetry: false,
      canRetry: true,
    });
    peer.expectNone('attachments.createUploadUrl');
  });

  it.each([
    [413, ''],
    [400, 'EntityTooLarge'],
  ])('does not report the chat size limit when storage rejects the size with HTTP %s', async (status, storageCode) => {
    const task = create();
    const pending = task.retry();
    config();
    (await sign()).finish(status, storageCode ? `<Error><Code>${storageCode}</Code></Error>` : '');
    await pending;
    expect(task.state().error).toMatchObject({
      code: UploadErrorCode.TooLarge,
      stage: UploadStage.Storage,
      autoRetry: false,
      canRetry: false,
      storage: { status, ...(storageCode ? { code: storageCode } : {}) },
    });
    expect(task.state().error).not.toHaveProperty('maxSizeMiB');
  });

  it('keeps a storage rejection distinct from account permission and renews the URL on retry', async () => {
    const task = create();
    const pending = task.retry();
    config();
    (await sign()).finish(403, '<Error><Code>SignatureDoesNotMatch</Code><RequestId>mock-request</RequestId></Error>');
    await pending;
    expect(task.state().error).toMatchObject({
      code: UploadErrorCode.StorageRejected,
      stage: UploadStage.Storage,
      autoRetry: false,
      canRetry: true,
      storage: { status: 403, code: 'SignatureDoesNotMatch', requestId: 'mock-request' },
    });
    const failedAttempt = task.diagnosticDetails();
    expect(failedAttempt).toMatchObject({ attempt: 1, errorStatus: 403, requestId: 'mock-request' });
    const retry = task.retry();
    expect(task.diagnosticDetails()).toEqual(failedAttempt);
    expect(task.state().error?.code).toBe(UploadErrorCode.StorageRejected);
    peer.expectNone('attachments.getConfig');
    (await sign(encodeId('101'))).finish();
    await retry;
    expect(task.state().error).toBeUndefined();
    const report = JSON.parse(await TestBed.inject(Diagnostics).export());
    const events = report.events.filter((entry: { event: string }) => entry.event.startsWith('upload.'));
    const failure = events.find((entry: { event: string }) => entry.event === 'upload.failed');
    expect(failure.details).toMatchObject({
      uploadId: expect.any(String),
      attempt: 1,
      state: UploadStage.Storage,
      fileSizeBytes: 5,
      errorStatus: 403,
      storageCode: 'SignatureDoesNotMatch',
      requestId: 'mock-request',
      durationMs: expect.any(Number),
    });
    expect(events.at(-1)).toMatchObject({
      event: 'upload.ready',
      details: { uploadId: failure.details.uploadId, attempt: 2 },
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'upload.stage',
          details: expect.objectContaining({ state: UploadStage.Config }),
        }),
        expect.objectContaining({
          event: 'upload.stage',
          details: expect.objectContaining({ state: UploadStage.Signing }),
        }),
        expect.objectContaining({
          event: 'upload.stage',
          details: expect.objectContaining({ state: UploadStage.Storage }),
        }),
      ]),
    );
    const nextStages = events.filter(
      (e: { event: string; details: { attempt: number } }) => e.event === 'upload.stage' && e.details.attempt === 2,
    );
    expect(nextStages.length).toBeGreaterThan(0);
    for (const { details } of nextStages) {
      for (const key of ['reason', 'storageCode', 'errorStatus', 'requestId']) expect(details).not.toHaveProperty(key);
    }
    expect(JSON.stringify(events)).not.toMatch(/note\.txt|storage\.invalid|uploadUrl/);
  });

  it.each(['config', 'upload-url'])('disposes a pending %s RPC request and ignores its late reply', async (stage) => {
    const task = create();
    const pending = task.retry();
    if (stage === 'upload-url') config();
    const request = await peer.expectAsync(
      stage === 'config' ? 'attachments.getConfig' : 'attachments.createUploadUrl',
    );
    task.dispose();
    request.flush(
      stage === 'config'
        ? { maxFileSizeBytes: 1024 }
        : { attachmentId: '100', uploadHeaders: {}, uploadUrl: 'https://storage.invalid/upload' },
    );
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
    config();
    await vi.waitFor(() => expect(convertToBlob).toHaveBeenCalledOnce());
    task.dispose();
    await expect(pending).resolves.toBeUndefined();
    const state = task.state();
    compressed(new Blob(['small'], { type: 'image/webp' }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(task.state()).toBe(state);
    peer.expectNone('attachments.createUploadUrl');
    expect(FakeUpload.requests).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(task.url);
  });

  it('does not start storage upload if disposed immediately after receiving a signed URL', async () => {
    const task = create();
    const pending = task.retry();
    config();
    const request = await peer.expectAsync('attachments.createUploadUrl');
    request.flush({ attachmentId: '100', uploadHeaders: {}, uploadUrl: 'https://storage.invalid/upload' });
    task.dispose();
    await expect(pending).resolves.toBeUndefined();
    expect(FakeUpload.requests).toHaveLength(0);
  });

  it('aborts storage upload, releases the preview once and ignores late callbacks', async () => {
    const task = create();
    const pending = task.retry();
    config();
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
    peer.expectNone('attachments.getConfig');
  });

  it('uploads through config, signing and storage despite an offline hint or event', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const task = create();
    const pending = task.retry();
    config();
    const xhr = await sign();
    window.dispatchEvent(new Event('offline'));
    xhr.finish();
    await expect(pending).resolves.toBe(encodeId('100'));
    expect(task.state().status).toBe(UploadStatus.Ready);
    expect(xhr.abort).not.toHaveBeenCalled();
  });

  it('automatically retries dispatcher errors despite an offline hint', async () => {
    vi.useFakeTimers();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const task = create();
    const pending = task.retry();
    peer.expect('attachments.getConfig').error(RpcErrorCode.DispatcherInternal);
    await pending;
    expect(task.state().error).toMatchObject({ code: UploadErrorCode.Server, autoRetry: true });
    await vi.advanceTimersByTimeAsync(1_000);
    const retry = task.retry();
    config();
    (await sign()).finish();
    await expect(retry).resolves.toBe(encodeId('100'));
  });

  it('retries a network failure on an online event and reuses the preview', async () => {
    const task = create();
    const pending = task.retry();
    config();
    const xhr = await sign();
    xhr.onerror?.();
    await pending;
    expect(task.state().error).toMatchObject({ code: UploadErrorCode.Network, autoRetry: true });
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(task.url);
    window.dispatchEvent(new Event('online'));
    const retry = task.retry();
    peer.expectNone('attachments.getConfig');
    (await sign(encodeId('101'))).finish();
    await expect(retry).resolves.toBe(encodeId('101'));
    expect(task.url).toBe('blob:mock-1');
  });

  it('times out a pending RPC round, ignores its late reply and automatically retries transient failure', async () => {
    vi.useFakeTimers();
    const task = create();
    const pending = task.retry();
    const request = peer.expect('attachments.getConfig');
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    request.flush({ maxFileSizeBytes: 1024 });
    expect(task.state().status).toBe(UploadStatus.Failed);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(task.url);
    await vi.advanceTimersByTimeAsync(1_000);
    const retried = peer.expect('attachments.getConfig');
    expect(task.state().status).toBe(UploadStatus.Uploading);
    task.dispose();
    retried.flush({ maxFileSizeBytes: 1024 });
    await task.retry();
  });

  it('does not automatically retry permanent RPC errors on timers or online', async () => {
    vi.useFakeTimers();
    const task = create();
    const pending = task.retry();
    peer.expect('attachments.getConfig').error(RpcErrorCode.Forbidden);
    await pending;
    expect(task.retryable).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    window.dispatchEvent(new Event('online'));
    peer.expectNone('attachments.getConfig');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(task.url);
  });
});
