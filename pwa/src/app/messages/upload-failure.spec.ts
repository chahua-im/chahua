import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AlertController, ToastController, type AlertButton, type AlertOptions } from '@ionic/angular';
import { TranslocoService } from '@jsverse/transloco';
import { vi } from 'vitest';
import { AttachmentUploadPurpose } from '../../generated/models';
import { RpcErrorCode } from '../api/rpc-error';
import { Preferences } from '../settings/preferences';
import { Diagnostics } from '../pwa/diagnostics';
import { UploadStatus, type AttachmentUpload } from './upload';
import { UploadErrorCode, UploadStage } from './upload-error';
import { UploadFailure } from './upload-failure';

interface FakeAlert {
  header?: string;
  subHeader?: string;
  message?: string;
  buttons?: (AlertButton | string)[];
  present: () => Promise<void>;
  dismiss: (data?: unknown, role?: string) => Promise<boolean>;
  remove: () => void;
  onDidDismiss: () => Promise<{ role?: string }>;
}

function fakeAlert(options: AlertOptions): FakeAlert {
  let close!: (detail: { role?: string }) => void;
  const dismissed = new Promise<{ role?: string }>((resolve) => (close = resolve));
  return {
    header: options.header,
    subHeader: options.subHeader,
    message: options.message as string | undefined,
    buttons: options.buttons,
    present: vi.fn(async () => {}),
    dismiss: vi.fn(async (_data?: unknown, role?: string) => {
      close({ role });
      return true;
    }),
    remove: vi.fn(),
    onDidDismiss: () => dismissed,
  };
}

describe('Upload failure dialog', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  function render(canRetry: boolean) {
    const state = signal<ReturnType<AttachmentUpload['state']>>({
      status: UploadStatus.Failed,
      progress: 0,
      error: {
        code: canRetry ? UploadErrorCode.Server : UploadErrorCode.TooLarge,
        stage: UploadStage.Signing,
        canRetry,
        autoRetry: canRetry,
        maxSizeMiB: 50,
      },
    });
    const created: FakeAlert[] = [];
    vi.spyOn(TestBed.inject(AlertController), 'create').mockImplementation(async (options) => {
      const alert = fakeAlert(options!);
      created.push(alert);
      return alert as unknown as HTMLIonAlertElement;
    });
    const fixture = TestBed.createComponent(UploadFailure);
    fixture.componentRef.setInput('upload', {
      file: new File(['file'], 'example.zip'),
      purpose: AttachmentUploadPurpose.file,
      state,
      diagnosticDetails: () => ({
        operation: 'attachment.upload',
        uploadId: 'test-upload',
        purpose: AttachmentUploadPurpose.file,
        attempt: 1,
        fileSizeBytes: 4,
        uploadSizeBytes: 4,
        state: state().error?.stage,
        reason: state().error?.code,
        errorCode: state().error?.rpcCode,
        errorStatus: state().error?.storage?.status,
        storageCode: state().error?.storage?.code,
        requestId: state().error?.storage?.requestId,
      }),
    });
    fixture.detectChanges();
    const retry = vi.fn();
    const remove = vi.fn();
    fixture.componentInstance.retry.subscribe(retry);
    fixture.componentInstance.remove.subscribe(remove);
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const toast = vi.spyOn(TestBed.inject(ToastController), 'create').mockResolvedValue({
      present: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLIonToastElement);
    const open = async () => {
      fixture.nativeElement.querySelector('button').click();
      await vi.waitFor(() => expect(created).toHaveLength(1));
      return created[0];
    };
    const copy = (alert: FakeAlert) => {
      vi.stubGlobal('navigator', { onLine: true, userAgent: 'upload-diagnostics-test', clipboard: { writeText } });
      const button = alert.buttons?.find((item) => typeof item !== 'string' && item.text === '复制错误信息');
      expect(typeof button === 'object' && button.handler?.({})).toBe(false);
    };
    const copiedReport = () => JSON.parse(writeText.mock.lastCall![0]);
    return { fixture, state, retry, remove, created, open, copy, writeText, toast, copiedReport };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('follows the advanced preference before opening and while the dialog is open', async () => {
    const { fixture, state, open } = render(true);
    const copyDiagnostics = vi.spyOn(TestBed.inject(Diagnostics), 'copy');
    state.update((current) => ({ ...current, error: { ...current.error!, rpcCode: RpcErrorCode.Internal } }));
    const preferences = TestBed.inject(Preferences);
    preferences.setShowDiagnosticsOnError(false);
    fixture.detectChanges();
    const alert = await open();
    const copyButton = () =>
      alert.buttons?.find((button) => typeof button !== 'string' && button.cssClass === 'upload-error-copy');
    expect(copyButton()).toBeUndefined();

    preferences.setShowDiagnosticsOnError(true);
    fixture.detectChanges();
    await fixture.whenStable();
    const previousCopy = copyButton();
    expect(previousCopy).toEqual(expect.objectContaining({ text: '复制错误信息' }));

    preferences.setShowDiagnosticsOnError(false);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(copyButton()).toBeUndefined();
    expect(alert.buttons).toHaveLength(2);
    if (typeof previousCopy === 'object') previousCopy.handler?.({});
    expect(copyDiagnostics).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it.each([true, false])('shows the selected filename and the appropriate action (retry=%s)', async (canRetry) => {
    const { fixture, retry, remove, open } = render(canRetry);
    const alert = await open();
    expect(alert.header).toBe('上传失败');
    expect(alert.subHeader).toBe('example.zip');
    expect(alert.message).toContain(canRetry ? '上传服务暂时不可用' : '文件过大');
    expect(alert.buttons).toEqual([
      expect.objectContaining({ text: '取消', role: 'cancel' }),
      expect.objectContaining({ text: canRetry ? '重试' : '删除', role: canRetry ? 'retry' : 'destructive' }),
    ]);
    await alert.dismiss(undefined, canRetry ? 'retry' : 'destructive');
    await vi.waitFor(() => expect(canRetry ? retry : remove).toHaveBeenCalledOnce());
    expect(canRetry ? remove : retry).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('copies the RPC code and current failed step without showing them in the alert', async () => {
    const { fixture, state, open, copy, writeText, toast, copiedReport } = render(true);
    state.update((current) => ({
      ...current,
      error: { ...current.error!, stage: UploadStage.Config, rpcCode: RpcErrorCode.Internal },
    }));
    fixture.detectChanges();
    const alert = await open();
    expect(alert.message).toBe('上传服务暂时不可用。 将自动重试。');
    expect(writeText).not.toHaveBeenCalled();
    copy(alert);
    expect(copiedReport()).toMatchObject({
      appVersion: expect.any(String),
      environment: expect.objectContaining({ userAgent: expect.any(String) }),
      events: expect.arrayContaining([
        expect.objectContaining({
          event: 'upload.report',
          details: expect.objectContaining({ state: UploadStage.Config, errorCode: RpcErrorCode.Internal }),
        }),
      ]),
    });
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: '错误信息已复制' })));
    expect(alert.dismiss).not.toHaveBeenCalled();

    state.update((current) => ({ ...current, error: { ...current.error!, stage: UploadStage.Signing } }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(alert.message).toBe('上传服务暂时不可用。 将自动重试。');
    copy(alert);
    expect(copiedReport().events.at(-1)).toMatchObject({
      event: 'upload.report',
      details: { state: UploadStage.Signing, errorCode: RpcErrorCode.Internal },
    });
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    fixture.destroy();
  });

  it('disables only the copy button and ignores repeat clicks while the clipboard is pending', async () => {
    const { fixture, state, open, copy, writeText, toast } = render(true);
    state.update((current) => ({ ...current, error: { ...current.error!, rpcCode: RpcErrorCode.Internal } }));
    let finish!: () => void;
    writeText.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const alert = await open();
    const button = (text: string) => alert.buttons?.find((item) => typeof item !== 'string' && item.text === text);

    copy(alert);
    copy(alert);
    fixture.detectChanges();
    expect(writeText).toHaveBeenCalledOnce();
    expect(button('复制错误信息')).toMatchObject({ htmlAttributes: { disabled: true } });
    expect(button('重试')).toMatchObject({ htmlAttributes: { disabled: false } });
    expect(button('取消')).not.toHaveProperty('htmlAttributes.disabled', true);
    expect(toast).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledOnce());
    fixture.detectChanges();
    expect(button('复制错误信息')).toMatchObject({ htmlAttributes: { disabled: false } });
    expect(alert.dismiss).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('gives file-specific advice when file type detection times out', async () => {
    const { fixture, state, open } = render(true);
    state.update((current) => ({
      ...current,
      error: {
        code: UploadErrorCode.ProcessingTimeout,
        stage: UploadStage.Processing,
        canRetry: true,
        autoRetry: false,
      },
    }));
    fixture.detectChanges();
    const alert = await open();
    expect(alert.message).toBe('无法识别文件类型。');
    fixture.destroy();
  });

  it('shows the storage size rejection without a chat size limit', async () => {
    const { fixture, state, open } = render(false);
    state.update((current) => ({
      ...current,
      error: { ...current.error!, stage: UploadStage.Storage, storage: { status: 413 } },
    }));
    fixture.detectChanges();
    const alert = await open();
    expect(alert.message).toBe('文件过大。');
    fixture.destroy();
  });

  it('uses the same size and processing reasons across failure sources', async () => {
    const { fixture, state, open } = render(false);
    const alert = await open();
    expect(alert.message).toBe('文件过大。');
    for (const error of [
      { code: UploadErrorCode.TooLarge, stage: UploadStage.Signing },
      { code: UploadErrorCode.TooLarge, stage: UploadStage.Storage, storage: { status: 413 } },
    ]) {
      state.update((current) => ({ ...current, error: { ...error, canRetry: false, autoRetry: false } }));
      fixture.detectChanges();
      await fixture.whenStable();
      expect(alert.message).toBe('文件过大。');
    }
    fixture.componentRef.setInput('upload', {
      ...fixture.componentInstance.upload(),
      file: new File(['image'], 'example.jpg'),
      purpose: AttachmentUploadPurpose.media,
      state,
    });
    for (const code of [UploadErrorCode.ProcessingTimeout, UploadErrorCode.ProcessingFailed]) {
      state.update((current) => ({
        ...current,
        error: { code, stage: UploadStage.Processing, canRetry: true, autoRetry: false },
      }));
      fixture.detectChanges();
      await fixture.whenStable();
      expect(alert.message).toBe('图片或视频处理失败。');
    }
    fixture.destroy();
  });

  it('shows a plain storage reason and copies only the available feedback details', async () => {
    const { fixture, state, open, copy, writeText, toast, copiedReport } = render(true);
    const error = {
      code: UploadErrorCode.StorageRejected,
      stage: UploadStage.Storage,
      canRetry: true,
      autoRetry: false,
    };
    state.update((current) => ({
      ...current,
      error: {
        ...error,
        storage: { status: 403, code: 'SignatureDoesNotMatch', requestId: 'mock-request' },
      },
    }));
    fixture.detectChanges();
    const alert = await open();
    expect(alert.message).toBe('上传验证失败。');
    copy(alert);
    expect(copiedReport().events.at(-1)).toMatchObject({
      event: 'upload.report',
      details: {
        uploadId: 'test-upload',
        fileSizeBytes: 4,
        errorStatus: 403,
        storageCode: 'SignatureDoesNotMatch',
        requestId: 'mock-request',
      },
    });
    expect(writeText.mock.lastCall![0]).not.toContain('example.zip');
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(1));

    state.update((current) => ({
      ...current,
      error: { ...error, storage: { status: 400, code: 'UnknownStorageError' } },
    }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(alert.message).toBe('上传失败。');
    copy(alert);
    expect(copiedReport().events.at(-1)).toMatchObject({
      event: 'upload.report',
      details: { errorStatus: 400, storageCode: 'UnknownStorageError' },
    });
    await vi.waitFor(() => expect(toast).toHaveBeenCalledTimes(2));

    state.update((current) => ({ ...current, error: { ...error, storage: { status: 403 } } }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(alert.message).toBe('上传失败。');
    writeText.mockRejectedValueOnce(new Error('Clipboard denied'));
    copy(alert);
    expect(copiedReport().events.at(-1).details).toMatchObject({ errorStatus: 403 });
    expect(copiedReport().events.at(-1).details).not.toHaveProperty('requestId');
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: '复制失败。' })));
    expect(alert.dismiss).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('retains an open dialog during automatic retry and closes it on success without stale actions', async () => {
    const { fixture, state, retry, remove, created, open } = render(true);
    const alert = await open();
    const error = state().error;
    state.update((current) => ({ ...current, status: UploadStatus.Uploading }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(alert.buttons).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: '正在重试上传…', htmlAttributes: { disabled: true } })]),
    );
    state.set({ status: UploadStatus.Ready, progress: 1 });
    fixture.detectChanges();
    await vi.waitFor(() => expect(alert.dismiss).toHaveBeenCalled());
    await vi.waitFor(() => expect(fixture.nativeElement.querySelector('button')).toBeNull());
    expect(retry).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    state.set({ status: UploadStatus.Failed, progress: 0, error });
    fixture.detectChanges();
    expect(created).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('button')).not.toBeNull();
    fixture.destroy();
  });

  it('updates the open dialog when language changes and does nothing on cancel', async () => {
    const { fixture, retry, remove, open } = render(false);
    const alert = await open();
    TestBed.inject(TranslocoService).setActiveLang('en');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(alert.header).toBe('Upload failed');
    });
    expect(alert.buttons).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Delete' })]));
    await alert.dismiss(undefined, 'cancel');
    await fixture.whenStable();
    expect(retry).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    fixture.destroy();
  });
});
