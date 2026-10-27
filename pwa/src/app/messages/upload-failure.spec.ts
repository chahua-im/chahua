import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AlertController, type AlertButton, type AlertOptions } from '@ionic/angular';
import { TranslocoService } from '@jsverse/transloco';
import { vi } from 'vitest';
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
    fixture.componentRef.setInput('upload', { file: new File(['file'], 'example.zip'), state });
    fixture.detectChanges();
    const retry = vi.fn();
    const remove = vi.fn();
    fixture.componentInstance.retry.subscribe(retry);
    fixture.componentInstance.remove.subscribe(remove);
    const open = async () => {
      fixture.nativeElement.querySelector('button').click();
      await vi.waitFor(() => expect(created).toHaveLength(1));
      return created[0];
    };
    return { fixture, state, retry, remove, created, open };
  }

  afterEach(() => vi.restoreAllMocks());

  it.each([true, false])('shows the selected filename and the appropriate action (retry=%s)', async (canRetry) => {
    const { fixture, retry, remove, open } = render(canRetry);
    const alert = await open();
    expect(alert.header).toBe('上传失败');
    expect(alert.subHeader).toBe('example.zip');
    expect(alert.message).toContain(canRetry ? '上传服务暂时不可用' : '50 MiB');
    expect(alert.buttons).toEqual([
      expect.objectContaining({ text: '取消', role: 'cancel' }),
      expect.objectContaining({ text: canRetry ? '重试' : '删除', role: canRetry ? 'retry' : 'destructive' }),
    ]);
    await alert.dismiss(undefined, canRetry ? 'retry' : 'destructive');
    await vi.waitFor(() => expect(canRetry ? retry : remove).toHaveBeenCalledOnce());
    expect(canRetry ? remove : retry).not.toHaveBeenCalled();
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
