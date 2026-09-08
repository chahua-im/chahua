import { vi } from 'vitest';
import { uploadBlob } from './upload';
describe('Signed upload', () => {
  const headers: Record<string, string> = {};
  let xhr: FakeUpload;
  class FakeUpload {
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
    constructor() {
      xhr = this;
    }
    setRequestHeader(key: string, value: string) {
      headers[key] = value;
    }
    abort() {
      this.onabort?.();
      this.onloadend?.();
    }
  }
  beforeEach(() => {
    for (const key of Object.keys(headers)) delete headers[key];
    vi.stubGlobal('XMLHttpRequest', FakeUpload);
  });
  afterEach(() => vi.unstubAllGlobals());
  it('sends only the storage signature headers and reports upload progress', async () => {
    const progress = vi.fn();
    const pending = uploadBlob(
      'https://storage.invalid/signed',
      new Blob(['test']),
      { 'Content-Type': 'text/plain' },
      undefined,
      progress,
    );
    expect(headers).toEqual({ 'Content-Type': 'text/plain' });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 4 });
    expect(progress).toHaveBeenCalledWith(0.5);
    xhr.onload?.();
    xhr.onloadend?.();
    await pending;
  });
  it('rejects HTTP errors and aborts removed uploads', async () => {
    let pending = uploadBlob('https://storage.invalid/signed', new Blob(), {});
    xhr.status = 403;
    xhr.onload?.();
    await expect(pending).rejects.toThrow('上传失败');
    const controller = new AbortController();
    pending = uploadBlob('https://storage.invalid/signed', new Blob(), {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
